import { lstatSync } from 'node:fs';
import { serve, type RequestHandler } from '../transport/server.js';
import { SourceCore, type SourceOptions, type SourcePrincipal } from './core.js';
import type { SourceConfig, Request, ConnectResult } from '../protocol/types.js';
import { features, LIMITS, SOURCE_FEATURES, MANAGED_SOURCE_FEATURES, validate } from '../protocol/validate.js';
import { invariant, fail } from '../protocol/errors.js';
import { privateJson } from '../platform/private-paths.js';
import { replaceDiscovery, removeIfSame } from '../platform/atomic-file.js';
import { ManagedSource } from './managed.js';
import { BindingClient } from '../client/index.js';
export class SourceHost {
  readonly core: SourceCore;
  readonly managed: ManagedSource;
  private endpoint?: { endpoint: string; close: () => Promise<void> };
  private timer?: NodeJS.Timeout;
  private managedTimer?: NodeJS.Timeout;
  private flushing?: Promise<void>;
  private managedSyncing?: Promise<void>;
  constructor(config: SourceConfig, options: SourceOptions = {}) {
    this.core = new SourceCore(config, options);
    this.managed = new ManagedSource(this.core);
  }
  handler(): RequestHandler {
    let credential: string | undefined, inviteId: string | undefined;
    return async (request: Request) => {
      if (request.op === 'connect') {
        invariant(request.sourceId === this.core.config.sourceId && !request.bindingId, 'unauthorized');
        features(request.requiredFeatures, [...SOURCE_FEATURES, ...MANAGED_SOURCE_FEATURES]);
        this.core.authenticate(request.credential, request.inviteId);
        credential = request.credential;
        inviteId = request.inviteId;
        const result: ConnectResult = {
          protocol: 'pi-relay',
          major: 1,
          minor: 1,
          // Stage 2: managed source features are implemented and advertised (02 §2.1).
          features: [...SOURCE_FEATURES, ...MANAGED_SOURCE_FEATURES],
          sourceId: this.core.config.sourceId,
          realm: this.core.config.realm,
          attachmentId: this.core.attachmentId,
          ownerEpoch: this.core.store.epoch,
          sourceRevision: this.core.revision,
          limits: { ...LIMITS },
        };
        return result;
      }
      invariant(credential, 'unauthorized');
      const principal = this.core.authenticate(credential, inviteId);
      if (request.op === 'egress') fail('egress_forbidden');
      // Managed delivery (wire 1.2) operations. Validated against the approved
      // managed contract by validateWire at the transport boundary.
      if ((request as { minor?: number }).minor === 2) {
        const op = (request as unknown as { op: string; params: unknown }).op;
        const params = (request as unknown as { params: never }).params;
        switch (op) {
          case 'source.managed.publish':
            return this.managed.publishManaged(principal, params as never);
          case 'source.managed.receipt': {
            const p = params as unknown as { eventId: string };
            return this.managed.managedReceipt(principal, p.eventId);
          }
          case 'source.managed.watch': {
            const p = params as unknown as { after: number; limit: number };
            return this.managed.managedWatch(principal, p.after, p.limit);
          }
          case 'source.managed.snapshot': {
            const p = params as unknown as { afterEventId?: string; limit: number };
            return this.managed.managedSnapshot(principal, p.afterEventId, p.limit);
          }
          case 'source.event.withdraw':
            return this.managed.withdraw(principal, params as never);
          case 'source.scope.advance':
            return this.managed.advanceScope(principal, params as never);
          case 'source.response.applied':
            return this.managed.confirmApplied(principal, params as never);
          case 'internal.source.proof': {
            // Target→Source direction (03 §3.3 step 2): the binding's invite
            // credential authorizes proofs for its own routed events only.
            invariant(principal.kind === 'invite', 'unauthorized');
            const inviteRow = this.core.store.get<{ used_by: string }>(
              'SELECT used_by FROM invites WHERE id=?',
              principal.inviteId,
            );
            invariant(inviteRow?.used_by, 'unauthorized');
            const proofParams = params as unknown as { bindingId: string; eventIds: string[] };
            invariant(inviteRow.used_by === proofParams.bindingId, 'unauthorized');
            return this.managed.scopeProof(proofParams.bindingId, proofParams.eventIds);
          }
          case 'owner.setup.commit':
            fail('unsupported_feature'); // arrives with the Pi-side owner setup UI (stage 3/4)
          default:
            fail('unauthorized');
        }
      }
      switch (request.op) {
        case 'source.publish':
          this.core.authorize(principal, request.channelId);
          return this.core.publish(
            request.channelId,
            request.value,
            request.autoRequired,
            principal.kind === 'owner',
          );
        case 'source.receipt':
          this.core.authorize(principal, request.channelId);
          return this.core.fanoutResult(request.channelId, request.eventId, principal.kind === 'owner');
        case 'source.invite':
          invariant(principal.kind === 'owner', 'unauthorized');
          return this.core.createInvite(request);
        case 'source.enroll':
          invariant(principal.kind === 'invite' || principal.kind === 'standing', 'unauthorized');
          return this.core.enroll(principal.inviteId, request.prepared);
        case 'source.status':
          invariant(principal.kind === 'owner', 'unauthorized');
          return this.core.status();
        case 'source.control':
          invariant(principal.kind === 'owner', 'unauthorized');
          return this.core.control(
            request.channelId,
            request.operationId,
            request.action,
            request.expectedRevision,
          );
        case 'source.withdraw': {
          invariant(principal.kind === 'invite', 'unauthorized');
          const row = this.core.store.get<{ used_by: string }>(
            'SELECT used_by FROM invites WHERE id=?',
            principal.inviteId,
          );
          invariant(row?.used_by === request.bindingId, 'unauthorized');
          this.core.withdraw(request.bindingId, request.operationId, request.preparedDigest);
          return { revoked: true };
        }
        default:
          fail('unauthorized');
      }
    };
  }
  async start(): Promise<this> {
    try {
      this.endpoint = await serve(() => this.handler());
      replaceDiscovery(this.core.discoveryFile, {
        version: 1,
        kind: 'source',
        identity: this.core.config.sourceId,
        realm: this.core.config.realm,
        endpoint: this.endpoint.endpoint,
        attachmentId: this.core.attachmentId,
        ownerEpoch: this.core.store.epoch,
      });
      this.timer = setInterval(() => {
        if (!this.flushing)
          this.flushing = this.core
            .flushProgress()
            .catch(() => {})
            .finally(() => {
              this.flushing = undefined;
            });
      }, 200);
      this.timer.unref();
      // Managed sync pump (02 §2.4): poll audience routes' receipt streams and
      // deliver pending application acks to targets.
      this.managedTimer = setInterval(() => {
        if (!this.managedSyncing)
          this.managedSyncing = this.syncManaged()
            .catch(() => {})
            .finally(() => {
              this.managedSyncing = undefined;
            });
      }, 500);
      this.managedTimer.unref();
      return this;
    } catch (e) {
      await this.close();
      throw e;
    }
  }
  private async syncManaged(): Promise<void> {
    // Stage 3.5: retry due staged packets for offline routes first — a route
    // that comes back receives its managed deliveries before receipt polling.
    await this.managed.retryManagedPending();
    const routes = this.managed.managedRouteBindings();
    for (const { bindingId } of routes) {
      try {
        const membership = this.core.membership(bindingId);
        const handle = JSON.parse(
          (await import('node:fs')).readFileSync(membership.capabilityRef, 'utf8'),
        ) as Parameters<typeof BindingClient.prototype.publishManagedPacket>[0] extends never
          ? never
          : import('../protocol/types.js').BindingHandle;
        const client = new BindingClient(handle);
        try {
          const cursor = Number(this.core.store.meta('managedWatch:' + bindingId) ?? 0);
          const response = (await client.watchManaged(cursor)) as {
            cursor: number;
            updates: Array<{ eventId: string; kind: string; fact: unknown }>;
          };
          for (const update of response.updates ?? []) {
            this.managed.ingestBindingUpdate(bindingId, update);
          }
          this.core.store.setMeta('managedWatch:' + bindingId, String(response.cursor));
        } finally {
          client.dispose();
        }
      } catch {
        // route unreachable this pass; receipts stay on the target store
      }
    }
    // application acks (source -> target)
    for (const ack of this.managed.pendingAcks()) {
      const bindingId =
        this.core.store.meta('managedRoute:' + ack.routeRef) ??
        this.managed.recoverRouteBinding(ack.routeRef, ack.responseId);
      if (!bindingId) continue;
      try {
        const membership = this.core.membership(bindingId);
        const { readFileSync } = await import('node:fs');
        const handle = JSON.parse(
          readFileSync(membership.capabilityRef, 'utf8'),
        ) as import('../protocol/types.js').BindingHandle;
        const client = new BindingClient(handle);
        try {
          const payload = JSON.parse(ack.payloadJson) as {
            responseId: string;
            appliedAt: number;
            result: never;
          };
          const delivered = await client.pushManagedAck(payload);
          if (delivered.applied) this.managed.markAckSent(ack.responseId, ack.routeRef);
        } finally {
          client.dispose();
        }
      } catch {
        // retry next pass
      }
    }
  }
  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.managedTimer) {
      clearInterval(this.managedTimer);
      this.managedTimer = undefined;
    }
    await this.managedSyncing;
    await this.flushing;
    if (this.endpoint) {
      await this.endpoint.close();
      this.endpoint = undefined;
    }
    try {
      const d = validate('Discovery', privateJson(this.core.discoveryFile));
      if (d.attachmentId === this.core.attachmentId)
        removeIfSame(this.core.discoveryFile, lstatSync(this.core.discoveryFile));
    } catch {}
    await this.core.close();
  }
}
export async function createSource(config: SourceConfig, options: SourceOptions = {}): Promise<SourceHost> {
  return new SourceHost(config, options).start();
}
