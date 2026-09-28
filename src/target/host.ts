import { join } from 'node:path';
import { lstatSync } from 'node:fs';
import type { Invite, Policy, Request, ConnectResult, PreparedBinding } from '../protocol/types.js';
import {
  features,
  LIMITS,
  TARGET_FEATURES,
  MANAGED_TARGET_FEATURES,
  validate,
} from '../protocol/validate.js';
import { invariant, fail, safeError } from '../protocol/errors.js';
import { newId, sha256 } from '../protocol/canonical.js';
import { privateDir, privateJson } from '../platform/private-paths.js';
import { installPrivate, replaceDiscovery, removeIfSame } from '../platform/atomic-file.js';
import { serve, type RequestHandler } from '../transport/server.js';
import { enroll, enrollLocal, openSource } from '../client/index.js';
import { readSourceChannel } from '../platform/source-read.js';
import { STANDING_EXPIRES_AT, STANDING_INVITE_ID } from '../protocol/constants.js';
import { OwnerLock, readOwnerToken } from '../platform/owner-lock.js';
import { TargetCore, type TargetOptions } from './core.js';
import { ManagedTarget } from './managed.js';
import { importStaged } from '../staging/index.js';
export class TargetHost {
  readonly core: TargetCore;
  readonly managed: ManagedTarget;
  private endpoint?: { endpoint: string; close: () => Promise<void> };
  private retryTimer?: NodeJS.Timeout;
  private withdrawing?: Promise<void>;
  private supervisorTimer?: NodeJS.Timeout;
  private closed = false;
  private readonly proofConnections = new Map<
    string,
    Promise<Awaited<ReturnType<typeof openSource>>>
  >();
  constructor(options: TargetOptions) {
    this.core = new TargetCore({
      ...options,
      onChange: () => {
        options.onChange?.();
        this.scheduleWithdrawals();
      },
    });
    this.managed = new ManagedTarget(this.core);
    // Fencing supervisor: writes are already fenced at tx boundaries, but the
    // incumbent should also step down promptly once challenged.
    const supervise = () => {
      if (this.closed) return;
      this.supervisorTimer = undefined;
      try {
        this.core.store.lock.assertHeld();
        this.supervisorTimer = setTimeout(supervise, 500);
        this.supervisorTimer.unref();
      } catch {
        void this.close()
          .catch(() => {})
          .then(() => options.onSuperseded?.());
      }
    };
    this.supervisorTimer = setTimeout(supervise, 500);
    this.supervisorTimer.unref();
  }
  private scheduleWithdrawals(): void {
    if (this.closed || this.retryTimer || !this.core) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.closed || this.withdrawing) return;
      this.withdrawing = this.flushWithdrawals()
        .catch(() => {}) // background task: failures are handled or terminal; never unhandled
        .finally(() => {
          this.withdrawing = undefined;
        });
    }, 200);
    this.retryTimer.unref();
  }
  /** Local revocation is already durable. This notification only removes future source membership. */
  private async flushWithdrawals(): Promise<void> {
    let retry = false;
    for (const binding of this.core.list()) {
      if (this.closed) break;
      try {
        this.core.store.lock.assertHeld();
      } catch {
        // Ownership loss is terminal for this host; never touch the store
        // again. The supervisor closes us; the new owner re-runs this loop.
        return;
      }
      if (
        binding.state === 'provisioning' &&
        binding.authority === 'valid' &&
        binding.expiresAt > this.core.clock.now()
      ) {
        try {
          const invite = validate(
            'Invite',
            privateJson(join(this.core.store.dir, 'invites', sha256(binding.proposal.inviteId) + '.json')),
          );
          const prepared = this.core.prepare(binding.proposal);
          this.core.finalize(await enroll(invite, prepared));
        } catch (e) {
          const error = safeError(e);
          // Ownership loss is terminal for this local attachment: writing a
          // provisioning-failure fact would itself be fenced. The supervisor
          // closes this host; the new owner re-runs provisioning.
          if (error.code === 'owner_superseded') return;
          // CONTRACTS step 5: incomplete registration has a deadline; failure is
          // recorded as a terminal provisioning-failed fact, never auto-escalated.
          // Recording itself is a store write: skip it if we lost ownership
          // while awaiting enroll (a fenced write would reject this promise).
          if (!error.retryable) {
            try {
              this.core.store.lock.assertHeld();
              this.core.markProvisioningFailed(binding.id, error.code);
            } catch (fence) {
              if (safeError(fence).code === 'owner_superseded') return;
              throw fence;
            }
          } else retry = true;
        }
      } else if (
        binding.state === 'provisioning' &&
        binding.authority === 'valid' &&
        binding.expiresAt <= this.core.clock.now()
      ) {
        try {
          this.core.store.lock.assertHeld();
          this.core.markProvisioningFailed(binding.id, 'binding_expired');
        } catch (fence) {
          if (safeError(fence).code === 'owner_superseded') return;
          throw fence;
        }
      }
      const key = 'withdrawn:' + binding.id;
      if (binding.authority !== 'revoked' || this.core.store.meta(key)) continue;
      let connection: Awaited<ReturnType<typeof openSource>> | undefined;
      try {
        const invite = validate(
          'Invite',
          privateJson(join(this.core.store.dir, 'bindings', binding.id, 'source-invite.json')),
        );
        connection = await openSource(invite);
        await connection.rpc.call({
          op: 'source.withdraw',
          bindingId: binding.id,
          operationId: 'withdraw-' + binding.id,
          preparedDigest: binding.preparedDigest,
        });
        this.core.store.tx(() => this.core.store.setMeta(key, 'confirmed'));
      } catch {
        retry = true;
      } finally {
        connection?.rpc.dispose();
      }
    }
    if (retry && !this.closed) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        this.scheduleWithdrawals();
      }, 2000);
      this.retryTimer.unref();
    }
  }
  /** Scope-proof fetch (03 §3.3 step 2): Target→Source over the binding's stored
   *  invite, ≤1s window, undefined on any failure (callers defer). Connections
   *  are cached per binding and disposed on close. */
  async managedScopeProof(
    bindingId: string,
    eventIds: string[],
  ): Promise<import('../protocol/internal-types.js').ScopeProof | undefined> {
    if (this.closed) return undefined;
    let connection = this.proofConnections.get(bindingId);
    if (!connection) {
      try {
        const invite = validate(
          'Invite',
          privateJson(join(this.core.store.dir, 'bindings', bindingId, 'source-invite.json')),
        );
        connection = openSource(invite);
        this.proofConnections.set(bindingId, connection);
        connection.catch(() => this.proofConnections.delete(bindingId));
      } catch {
        return undefined;
      }
    }
    try {
      const c = await connection;
      return await Promise.race([
        c.rpc.call(
          {
            op: 'internal.source.proof',
            params: { bindingId, eventIds },
          } as never,
          2,
        ),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1000)),
      ]) as import('../protocol/internal-types.js').ScopeProof | undefined;
    } catch {
      this.proofConnections.delete(bindingId);
      return undefined;
    }
  }

  handler(): RequestHandler {
    let bindingId: string | undefined, credential: string | undefined;
    return (request: Request) => {
      if (request.op === 'connect') {
        invariant(request.bindingId && !request.sourceId && !request.inviteId, 'unauthorized');
        features(request.requiredFeatures, [...TARGET_FEATURES, ...MANAGED_TARGET_FEATURES]);
        const b = this.core.authenticate(request.bindingId, request.credential);
        bindingId = b.id;
        credential = request.credential;
        const result: ConnectResult = {
          protocol: 'pi-relay',
          major: 1,
          minor: 1,
          // Stage 2: consumer gate + responses implemented and advertised (02 §2.1).
          features: [...TARGET_FEATURES, ...MANAGED_TARGET_FEATURES],
          sourceId: b.proposal.sourceId,
          channelId: b.proposal.channelId,
          bindingId: b.id,
          targetFingerprint: b.proposal.targetFingerprint,
          realm: b.proposal.realm,
          attachmentId: this.core.attachmentId,
          ownerEpoch: this.core.store.epoch,
          bindingRevision: b.revision,
          preparedDigest: b.preparedDigest,
          membershipRevision: b.membershipRevision ?? 0,
          limits: { ...LIMITS },
        };
        return result;
      }
      invariant(bindingId && credential, 'unauthorized');
      this.core.authenticate(bindingId, credential);
      if (request.op === 'egress') fail('egress_forbidden');
      // Managed internal transport (relay-internal, minor 2, binding-authenticated).
      if ((request as { minor?: number }).minor === 2) {
        const op = (request as unknown as { op: string }).op;
        const framed = (request as unknown as {
          params: { bindingId: string; bindingRevision: number; attachmentId: string };
        }).params;
        invariant(
          framed &&
            framed.bindingId === bindingId &&
            typeof framed.bindingRevision === 'number' &&
            typeof framed.attachmentId === 'string',
          'unauthorized',
        );
        this.core.fence(bindingId, framed.bindingRevision, framed.attachmentId);
        const params = (request as unknown as { params: never }).params;
        switch (op) {
          case 'internal.target.admit': {
            const { packet } = framed as unknown as { packet: never };
            return this.managed.admitManaged(packet);
          }
          case 'internal.target.control':
            return this.managed.applyControl(params as never);
          case 'internal.target.ack':
            return this.managed.applyAck(params as never);
          case 'consumer.respond':
            // Consumer identity derives from the local target runtime (02 §2.5);
            // socket-borne consumer.respond stays closed until that surface ships.
            fail('unauthorized');
          default:
            fail('unauthorized');
        }
      }

      invariant(
        'bindingId' in request &&
          request.bindingId === bindingId &&
          'bindingRevision' in request &&
          'attachmentId' in request,
        'unauthorized',
      );
      this.core.fence(bindingId, request.bindingRevision, request.attachmentId);
      switch (request.op) {
        case 'publish':
          invariant(!!request.packet !== !!request.value);
          if (request.packet) {
            invariant(request.packet.bindingId === bindingId, 'unauthorized');
            return this.core.admit(request.packet);
          }
          invariant(request.value?.kind === 'progress', 'unauthorized');
          return this.core.admitProgress(bindingId, request.value);
        case 'receipt':
          return this.core.receipt(bindingId, request.eventId);
        case 'watch':
          return this.core.receipts(bindingId, request.after, request.limit);
        case 'route.revoke':
          return this.core.control(bindingId, {
            operationId: request.operationId,
            expectedRevision: request.bindingRevision,
            action: 'revoke',
          });
        default:
          fail('unauthorized');
      }
    };
  }
  async start(): Promise<this> {
    try {
      this.endpoint = await serve(() => this.handler());
      // Ownership may have been taken over while awaiting the transport.
      this.core.store.lock.assertHeld();
      replaceDiscovery(join(this.core.store.dir, 'attachment.json'), {
        version: 1,
        kind: 'binding',
        identity: this.core.options.fingerprint,
        realm: this.core.options.realm,
        endpoint: this.endpoint.endpoint,
        attachmentId: this.core.attachmentId,
        ownerEpoch: this.core.store.epoch,
      });
      this.scheduleWithdrawals();
      return this;
    } catch (e) {
      await this.close();
      throw e;
    }
  }
  /** The caller is a trusted owner; the model-facing extension never exposes this method. */
  async bind(
    inviteInput: Invite,
    options: {
      operationId?: string;
      resume?: boolean;
      affinity?: 'branch' | 'session';
      originAnchor?: string | null;
    } = {},
  ): Promise<string> {
    // Fence before any owner-controlled filesystem mutation: a superseded
    // host must not install invite files for a store it no longer owns.
    invariant(!this.closed, 'invalid_state');
    this.core.store.lock.assertHeld();
    const invite = validate('Invite', inviteInput);
    invariant(
      invite.realm === this.core.options.realm && invite.bindingExpiresAt > this.core.clock.now(),
      'unauthorized',
    );
    if (options.resume) invariant(invite.allowedModes.includes('resume'), 'unauthorized');
    const policy: Policy = {};
    for (const type of invite.types)
      policy[type.type] = {
        model: options.resume && type.kind === 'event' ? 'resume' : 'display',
        presentation: type.kind === 'progress' ? 'live' : 'card',
      };
    const inviteDir = privateDir(join(this.core.store.dir, 'invites'));
    installPrivate(join(inviteDir, sha256(invite.inviteId) + '.json'), invite);
    const prepared = this.core.prepare({
      operationId: options.operationId ?? 'bind-' + invite.inviteId,
      inviteId: invite.inviteId,
      sourceId: invite.sourceId,
      channelId: invite.channelId,
      targetFingerprint: this.core.options.fingerprint,
      realm: invite.realm,
      expiresAt: invite.bindingExpiresAt,
      types: invite.types,
      policy,
      affinity: options.affinity ?? 'branch',
      originAnchor: options.originAnchor ?? null,
    });
    installPrivate(join(this.core.store.dir, 'bindings', prepared.bindingId, 'source-invite.json'), invite);
    try {
      const membership = await enroll(invite, prepared);
      this.core.finalize(membership);
      return prepared.bindingId;
    } finally {
      this.scheduleWithdrawals();
    }
  }
  import(id: string) {
    return importStaged(this.core, id);
  }
  /** Delta-2 local standing binding: same-home, same-realm direct bind for a
   *  channel whose owner opted in with localTrust. No invite, no TTLs; the
   *  standing grant is session-scoped and budgeted by eligibility gates +
   *  fencing + the managed guard. Idempotent per (source, channel, fingerprint)
   *  — a handshake replay returns the live binding with its grant ensured. */
  async bindLocal(input: {
    sourceId: string;
    channelId: string;
    operationId?: string;
  }): Promise<{ bindingId: string; standing: true; armed: boolean }> {
    invariant(!this.closed, 'invalid_state');
    this.core.store.lock.assertHeld();
    const view = readSourceChannel(this.core.options.home, input.sourceId, input.channelId);
    if (!view) fail('source_not_found');
    if (view.channel.localTrust !== true) fail('local_trust_disabled');
    if (view.realm !== this.core.options.realm) fail('unauthorized');
    const existing = this.core.list().find(
      (b) =>
        b.standing === true &&
        b.authority === 'valid' &&
        b.state === 'active' &&
        b.proposal.sourceId === input.sourceId &&
        b.proposal.channelId === input.channelId,
    );
    if (existing) {
      this.armStanding(existing.id, view.channel);
      return { bindingId: existing.id, standing: true, armed: this.standingArmed(existing.id) };
    }
    const policy: Policy = {};
    for (const type of view.channel.types)
      policy[type.type] = {
        model: view.channel.allowedModes.includes('resume') && type.kind === 'event' ? 'resume' : 'display',
        presentation: type.kind === 'progress' ? 'live' : 'card',
      };
    const prepared = this.core.prepare({
      operationId: input.operationId ?? 'local-' + sha256(input.sourceId + ':' + input.channelId + ':' + this.core.options.fingerprint),
      inviteId: STANDING_INVITE_ID,
      sourceId: input.sourceId,
      channelId: input.channelId,
      targetFingerprint: this.core.options.fingerprint,
      realm: view.realm,
      expiresAt: STANDING_EXPIRES_AT,
      types: view.channel.types,
      policy,
      affinity: 'session',
      originAnchor: null,
      standing: true,
    });
    this.armStanding(prepared.bindingId, view.channel);
    const membership = await enrollLocal(view.discoveryFile, prepared);
    this.core.finalize(membership);
    this.scheduleWithdrawals();
    return { bindingId: prepared.bindingId, standing: true, armed: this.standingArmed(prepared.bindingId) };
  }
  /** Arm (or re-arm) the standing session-scoped grant on a binding. */
  private armStanding(bindingId: string, channel: { types: { type: string; kind: string }[]; allowedModes: string[] }): void {
    const binding = this.core.binding(bindingId);
    const eventTypes = Object.entries(binding.proposal.policy)
      .filter(([, rule]) => rule.model === 'resume')
      .map(([type]) => type);
    if (eventTypes.length === 0) return; // nothing wake-capable: bind stays unarmed
    this.core.control(bindingId, {
      operationId: newId('op'),
      expectedRevision: binding.revision,
      action: 'arm',
      grant: { eventTypes, maxClaims: 4, ttlMs: 30 * 60 * 1000, sessionScoped: true, standing: true },
    });
  }
  private standingArmed(bindingId: string): boolean {
    return Object.entries(this.core.binding(bindingId).proposal.policy).some(
      ([, rule]) => rule.model === 'resume',
    );
  }
  private closePromise?: Promise<void>;
  async close(): Promise<void> {
    // One shared shutdown promise: concurrent callers await the same run and
    // cleanup is guaranteed even when an in-flight background task rejects.
    this.closePromise ??= this.doClose();
    return this.closePromise;
  }
  private async doClose(): Promise<void> {
    this.closed = true;
    this.core.ready = false;
    for (const connection of this.proofConnections.values())
      connection
        .then((c) => c.rpc.dispose())
        .catch(() => {});
    this.proofConnections.clear();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.supervisorTimer) clearTimeout(this.supervisorTimer);
    try {
      await this.withdrawing?.catch(() => {});
    } finally {
      try {
        if (this.endpoint) {
          await this.endpoint.close();
          this.endpoint = undefined;
        }
      } finally {
        // Identity-guarded cleanup is intentionally not fenced: shutdown must
        // work after supersession, before releasing the lock.
        try {
          const file = join(this.core.store.dir, 'attachment.json');
          const discovery = validate('Discovery', privateJson(file));
          if (discovery.attachmentId === this.core.attachmentId) removeIfSame(file, lstatSync(file));
        } catch {}
        this.core.store.close();
      }
    }
  }
}
export async function createTarget(options: TargetOptions): Promise<TargetHost> {
  // Latest-active-wins: a newer session with the same fingerprint takes over
  // the store; the earlier holder fences itself out at its next write.
  const storeDir = privateDir(join(privateDir(options.home), 'targets', options.fingerprint));
  const lock = await OwnerLock.acquire(join(storeDir, 'owner.lock'), {
    takeover: true,
    pollMs: options.clock ? 20 : 100,
    timeoutMs: 10_000,
  });
  return new TargetHost({ ...options, lock }).start();
}
