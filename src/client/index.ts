import { parseJson } from '../protocol/json.js';
import { join } from 'node:path';
import { readPrivate, privateJson, verifyDir } from '../platform/private-paths.js';
import { RpcClient } from '../transport/client.js';
import type {
  BindingHandle,
  SourceHandle,
  Invite,
  ConnectResult,
  Event,
  Value,
  RoutePacket,
  EventReceipt,
  AdmissionResult,
  FanoutResult,
  PreparedBinding,
  MembershipProof,
} from '../protocol/types.js';
import { deadline, LIMITS, validate } from '../protocol/validate.js';
import { canonical, digest, sha256, newId } from '../protocol/canonical.js';
import { STANDING_INVITE_ID } from '../protocol/constants.js';
import { RelayError, invariant, safeError } from '../protocol/errors.js';
import { signPacket, stage } from '../staging/index.js';
export { requestOnBus } from '../transport/in-process.js';
export function readBindingHandle(path: string): BindingHandle {
  return validate('BindingHandle', privateJson(path));
}
export function readSourceHandle(path: string): SourceHandle {
  return validate('SourceHandle', privateJson(path));
}
export function readInvite(path: string): Invite {
  return validate('Invite', privateJson(path));
}
export async function openBinding(
  handle: BindingHandle,
  requiredFeatures: string[] = [],
): Promise<{ rpc: RpcClient; hello: ConnectResult }> {
  validate('BindingHandle', handle);
  const discovery = validate('Discovery', privateJson(handle.discoveryFile));
  invariant(
    discovery.kind === 'binding' &&
      discovery.identity === handle.targetFingerprint &&
      discovery.realm === handle.realm,
    'unauthorized',
  );
  const rpc = new RpcClient(discovery.endpoint);
  try {
    const hello = await rpc.open({
      credential: handle.credential,
      bindingId: handle.bindingId,
      requiredFeatures,
    });
    invariant(
      hello.bindingId === handle.bindingId &&
        hello.targetFingerprint === handle.targetFingerprint &&
        hello.realm === handle.realm &&
        hello.sourceId === handle.sourceId &&
        hello.channelId === handle.channelId &&
        hello.attachmentId === discovery.attachmentId &&
        hello.ownerEpoch === discovery.ownerEpoch,
      'unauthorized',
    );
    return { rpc, hello };
  } catch (e) {
    rpc.dispose();
    throw e;
  }
}
export async function openSource(
  handle: SourceHandle | Invite,
  requiredFeatures: string[] = [],
): Promise<{ rpc: RpcClient; hello: ConnectResult }> {
  const discovery = validate('Discovery', privateJson(handle.discoveryFile));
  invariant(
    discovery.kind === 'source' && discovery.identity === handle.sourceId && discovery.realm === handle.realm,
    'unauthorized',
  );
  const rpc = new RpcClient(discovery.endpoint);
  try {
    const hello = await rpc.open({
      credential: handle.credential,
      sourceId: handle.sourceId,
      ...(handle.kind === 'invite' ? { inviteId: handle.inviteId } : {}),
      requiredFeatures,
    });
    invariant(
      hello.sourceId === handle.sourceId &&
        hello.realm === handle.realm &&
        hello.attachmentId === discovery.attachmentId &&
        hello.ownerEpoch === discovery.ownerEpoch,
      'unauthorized',
    );
    return { rpc, hello };
  } catch (e) {
    rpc.dispose();
    throw e;
  }
}
export class BindingClient {
  private connection?: { rpc: RpcClient; hello: ConnectResult };
  private closed = false;
  constructor(
    readonly handle: BindingHandle,
    private readonly stager: typeof stage = stage,
    private readonly beforeSend?: () => void,
  ) {
    validate('BindingHandle', handle);
  }
  private async conn() {
    invariant(!this.closed, 'transport_unavailable');
    return (this.connection ??= await openBinding(this.handle, ['durable-events', 'receipt-query']));
  }
  private reset(): void {
    this.connection?.rpc.dispose();
    this.connection = undefined;
  }
  async publishPacket(packet: RoutePacket): Promise<AdmissionResult> {
    try {
      this.stager(this.handle, packet);
    } catch (e) {
      return { outcome: 'rejected', error: safeError(e) };
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      let sent = false;
      try {
        const { rpc, hello } = await this.conn();
        this.beforeSend?.();
        sent = true;
        return validate(
          'AdmissionResult',
          await rpc.call({
            op: 'publish',
            bindingId: this.handle.bindingId,
            bindingRevision: hello.bindingRevision!,
            attachmentId: hello.attachmentId,
            packet,
          }),
        );
      } catch (e) {
        this.reset();
        if (
          e instanceof RelayError &&
          ['stale_binding_revision', 'attachment_stale'].includes(e.code) &&
          attempt === 0
        )
          continue;
        if (
          e instanceof RelayError &&
          !['admission_unknown', 'transport_unavailable', 'target_offline'].includes(e.code)
        )
          return { outcome: 'rejected', error: e.detail };
        return sent
          ? { outcome: 'admission-unknown', eventId: packet.event.id, staged: true }
          : { outcome: 'staged', eventId: packet.event.id, durability: 'producer-outbox' };
      }
    }
    return { outcome: 'admission-unknown', eventId: packet.event.id, staged: true };
  }
  /** One-shot managed watch page for the source pump (stage 2 poll model, 02 §2.4). */
  async watchManaged(after: number): Promise<{ cursor: number; updates: unknown[] }> {
    const { rpc, hello } = await this.conn();
    return (await rpc.call({
      op: 'watch',
      bindingId: this.handle.bindingId,
      bindingRevision: hello.bindingRevision!,
      attachmentId: hello.attachmentId,
      after,
      limit: 128,
    })) as { cursor: number; updates: unknown[] };
  }
  /** Managed delivery (stage 2): push a managed route packet over the internal op.
   *  Offline targets return outcome 'offline' — no silent durability claim. */
  async publishManagedPacket(
    packet: import('../protocol/internal-types.js').ManagedRoutePacket,
  ): Promise<{ outcome: 'accepted' | 'rejected' | 'unknown' | 'offline'; state?: string }> {
    try {
      const { rpc, hello } = await this.connManaged();
      const result = (await rpc.call(
        {
          op: 'internal.target.admit',
          params: {
            bindingId: this.handle.bindingId,
            bindingRevision: hello.bindingRevision!,
            attachmentId: hello.attachmentId,
            packet,
          },
        } as never,
        2,
      )) as { state?: string };
      return { outcome: 'accepted', state: result?.state };
    } catch (e) {
      this.reset();
      const error = safeError(e);
      if (error.code === 'admission_unknown') return { outcome: 'unknown' };
      // 'rejected' means the target actually answered with a rejection; any
      // client-side failure (missing discovery, refused connection, fs error)
      // is offline — staged and retried, never mistaken for a live rejection.
      const neverReached = new Set([
        'transport_unavailable',
        'target_offline',
        'unsafe_path',
        'store_unavailable',
        'backpressure',
        'owner_superseded',
      ]);
      if (neverReached.has(error.code) || !(e instanceof RelayError)) return { outcome: 'offline' };
      return { outcome: 'rejected' };
    }
  }
  /** Internal managed control push (withdraw / scope fence propagation). */
  async pushManagedControl(
    params: {
      kind: 'event-withdraw' | 'scope-fence';
      eventId?: string;
      scopeId?: string;
      scopeRevision?: number;
      controlId: string;
    },
  ): Promise<{ applied: boolean }> {
    try {
      const { rpc, hello } = await this.connManaged();
      await rpc.call(
        {
          op: 'internal.target.control',
          params: {
            bindingId: this.handle.bindingId,
            bindingRevision: hello.bindingRevision!,
            attachmentId: hello.attachmentId,
            ...params,
          },
        } as never,
        2,
      );
      return { applied: true };
    } catch (e) {
      this.reset();
      const error = safeError(e);
      if (error.code === 'transport_unavailable' || error.code === 'target_offline')
        return { applied: false };
      throw e;
    }
  }
  /** Internal application-ack delivery (source -> target, m9/A10). */
  async pushManagedAck(
    params: { responseId: string; appliedAt: number; result: unknown },
  ): Promise<{ applied: boolean }> {
    try {
      const { rpc, hello } = await this.connManaged();
      await rpc.call(
        {
          op: 'internal.target.ack',
          params: {
            bindingId: this.handle.bindingId,
            bindingRevision: hello.bindingRevision!,
            attachmentId: hello.attachmentId,
            ...params,
          },
        } as never,
        2,
      );
      return { applied: true };
    } catch (e) {
      this.reset();
      const error = safeError(e);
      if (error.code === 'transport_unavailable' || error.code === 'target_offline')
        return { applied: false };
      throw e;
    }
  }
  private async connManaged() {
    invariant(!this.closed, 'transport_unavailable');
    return (this.connection ??= await openBinding(this.handle, [
      'durable-events',
      'receipt-query',
      'consumer-gate-v1',
      'consumer-responses-v1',
    ]));
  }
  /** Shared-channel wake-capable events must use SourcePublisher; the convenience edge is display-only. */
  async publish(value: Value): Promise<AdmissionResult> {
    validate('Value', value);
    if (value.kind === 'progress') {
      try {
        const { rpc, hello } = await this.conn();
        return validate(
          'AdmissionResult',
          await rpc.call({
            op: 'publish',
            bindingId: this.handle.bindingId,
            bindingRevision: hello.bindingRevision!,
            attachmentId: hello.attachmentId,
            value,
          }),
        );
      } catch (e) {
        this.reset();
        if (e instanceof RelayError && !['transport_unavailable', 'admission_unknown'].includes(e.code))
          return { outcome: 'rejected', error: e.detail };
        return { outcome: 'dropped', reason: 'progress-offline' };
      }
    }
    let packet: RoutePacket;
    try {
      packet = validate(
        'RoutePacket',
        parseJson(readPrivate(join(this.handle.spoolDir, 'pending', sha256(value.id) + '.json')).text),
      );
      invariant(packet.sourceEventDigest === digest(value), 'id_conflict');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const { hello } = await this.conn();
      const now = Date.now();
      packet = signPacket(
        {
          packetVersion: 1,
          bindingId: this.handle.bindingId,
          sourceId: this.handle.sourceId,
          channelId: this.handle.channelId,
          event: value,
          sourceEventDigest: digest(value),
          fanoutId: 'edge-' + sha256(value.id).slice(0, 32),
          membershipRevision: hello.membershipRevision ?? 0,
          routeCreatedAt: now,
          routeValidUntil: Math.min(this.handle.expiresAt, deadline(value.validUntil, now + 3600000)),
          policySnapshotId: digest({ model: 'display' }),
          allowedModelModes: ['display'],
          proofKeyId: this.handle.proofKeyId,
        },
        this.handle.proofKey,
      );
    }
    return this.publishPacket(packet);
  }
  async getReceipt(eventId: string): Promise<EventReceipt> {
    const { rpc, hello } = await this.conn();
    try {
      return validate(
        'EventReceipt',
        await rpc.call({
          op: 'receipt',
          bindingId: this.handle.bindingId,
          bindingRevision: hello.bindingRevision!,
          attachmentId: hello.attachmentId,
          eventId,
        }),
      );
    } catch (e) {
      this.reset();
      throw e;
    }
  }
  async *watchReceipts(
    options: { after?: number; signal?: AbortSignal; pollMs?: number } = {},
  ): AsyncGenerator<unknown> {
    let after = options.after ?? 0;
    while (!this.closed && !options.signal?.aborted) {
      const { rpc, hello } = await this.conn();
      const response = (await rpc.call({
        op: 'watch',
        bindingId: this.handle.bindingId,
        bindingRevision: hello.bindingRevision!,
        attachmentId: hello.attachmentId,
        after,
        limit: 128,
      })) as { cursor: number; updates: unknown[] };
      for (const update of response.updates) yield update;
      after = response.cursor;
      await new Promise<void>((resolve) => setTimeout(resolve, options.pollMs ?? 200));
    }
  }
  async revoke(operationId: string): Promise<unknown> {
    const { rpc, hello } = await this.conn();
    return rpc.call({
      op: 'route.revoke',
      bindingId: this.handle.bindingId,
      bindingRevision: hello.bindingRevision!,
      attachmentId: hello.attachmentId,
      operationId,
    });
  }
  dispose(): void {
    this.closed = true;
    this.reset();
  }
}
export function connect(handle: BindingHandle): BindingClient {
  return new BindingClient(handle);
}
export class SourcePublisher {
  private closed = false;
  constructor(
    readonly handle: SourceHandle,
    readonly channelId: string = handle.channelId ?? '',
  ) {
    validate('SourceHandle', handle);
    invariant(channelId.length > 0, 'invalid_payload');
  }
  async publish(value: Value, options: { autoRequired?: boolean } = {}): Promise<FanoutResult> {
    invariant(!this.closed, 'transport_unavailable');
    const { rpc } = await openSource(this.handle, ['multi-session-fanout']);
    try {
      return validate(
        'FanoutResult',
        await rpc.call({
          op: 'source.publish',
          channelId: this.channelId,
          value,
          ...(options.autoRequired !== undefined ? { autoRequired: options.autoRequired } : {}),
        }),
      );
    } catch (error) {
      if (error instanceof RelayError && ['transport_unavailable', 'admission_unknown'].includes(error.code))
        throw new RelayError('admission_unknown');
      throw error;
    } finally {
      rpc.dispose();
    }
  }
  async getFanout(eventId: string): Promise<FanoutResult> {
    const { rpc } = await openSource(this.handle, ['receipt-query']);
    try {
      return validate(
        'FanoutResult',
        await rpc.call({ op: 'source.receipt', channelId: this.channelId, eventId }),
      );
    } finally {
      rpc.dispose();
    }
  }
  dispose(): void {
    this.closed = true;
  }
}
export function connectChannel(handle: SourceHandle, channelId?: string): SourcePublisher {
  return new SourcePublisher(handle, channelId ?? handle.channelId ?? '');
}
export async function enroll(invite: Invite, prepared: PreparedBinding): Promise<MembershipProof> {
  const { rpc } = await openSource(invite);
  try {
    return validate('MembershipProof', await rpc.call({ op: 'source.enroll', prepared }));
  } finally {
    rpc.dispose();
  }
}
/** Delta-2: standing enrollment reaches the source over the same transport; the
 *  UDS socket inside the 0700 home IS the local identity (no invite credential
 *  exists). Source-side localTrust + realm + probe checks do the gating. */
export async function enrollLocal(discoveryFile: string, prepared: PreparedBinding): Promise<MembershipProof> {
  const discovery = validate('Discovery', privateJson(discoveryFile));
  invariant(
    discovery.kind === 'source' &&
      discovery.identity === prepared.proposal.sourceId &&
      discovery.realm === prepared.proposal.realm,
    'unauthorized',
  );
  const rpc = new RpcClient(discovery.endpoint);
  try {
    const hello = await rpc.open({
      credential: prepared.handle.credential,
      sourceId: prepared.proposal.sourceId,
      inviteId: STANDING_INVITE_ID,
      // Capability negotiation: an older source without local-standing-v1
      // rejects the connect (unsupported_feature) instead of mis-handling it.
      requiredFeatures: ['local-standing-v1'],
    });
    invariant(
      hello.sourceId === prepared.proposal.sourceId &&
        hello.realm === prepared.proposal.realm &&
        hello.attachmentId === discovery.attachmentId &&
        hello.ownerEpoch === discovery.ownerEpoch,
      'unauthorized',
    );
    return validate('MembershipProof', await rpc.call({ op: 'source.enroll', prepared }));
  } finally {
    rpc.dispose();
  }
}
export { ManagedSourceClient, connectManagedSource } from './managed.js';
