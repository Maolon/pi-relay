import { join } from 'node:path';
import type { SourceCore, SourcePrincipal } from './core.js';
import type { Store } from '../store/database.js';
import type {
  ManagedPublish,
  ManagedReceipt,
  WithdrawResult,
  ScopeAdvance,
  ResponseApplied,
  RouteReceipt,
  ConsumerResponse,
  Event as ManagedEvent,
} from '../protocol/managed-types.js';
import type { ManagedRoutePacket, ScopeProof } from '../protocol/internal-types.js';
import { validateManaged, validateInternal, LIMITS } from '../protocol/validate.js';
import { canonical, digest, newId, proof, sha256 } from '../protocol/canonical.js';
import { invariant, safeError } from '../protocol/errors.js';
import { privateJson } from '../platform/private-paths.js';
import { BindingClient } from '../client/index.js';
import { STANDING_EXPIRES_AT, FOREVER } from '../protocol/constants.js';

export { FOREVER };

/** Design parameters (approved plan 02 §2.3): fixed ceilings, never recomputed from retries. */
export const MANAGED_LIMITS = Object.freeze({
  maxManagedAgeMs: 24 * 3600 * 1000,
  maxManagedTtlMs: 24 * 3600 * 1000,
  clockSkewMs: 60_000,
  tombstoneRetentionDays: 30,
  receiptRetentionRows: 5000,
});
/** 03 §3.3 step 2: scope proofs are short-lived (default ≤ 1s) and bound to the current attachment. */
export const MANAGED_PROOF_VALIDITY_MS = 1000;

interface ScopeRow {
  publisher_id: string;
  scope_id: string;
  revision: number;
  state: 'active' | 'paused' | 'closed';
}
interface AudienceRow {
  audience_ref: string;
  publisher_id: string;
  channel_id: string;
  route_set_json: string;
  membership_cut: number;
  consumer_profile_id: string;
  requested_mode: 'display' | 'resume';
  state: 'open' | 'closed' | 'revoked';
  issued_at: number;
  valid_until: number;
}
interface ManagedEventRow {
  publisher_id: string;
  event_id: string;
  scope_id: string;
  scope_revision: number;
  event_digest: string;
  event_bytes: Buffer;
  options_json: string;
  options_digest: string;
  valid_until: number;
  captured_at: number;
}
interface ReceiptUpdateRow {
  cursor: number;
  publisher_id: string;
  event_id: string;
  route_ref: string;
  target_revision: number;
  payload_json: string;
  created_at: number;
}
interface SourceResponseRow {
  response_id: string;
  publisher_id: string;
  event_id: string;
  route_ref: string;
  digest: string;
  body_json: string;
  source_cursor: number;
  application_result_json: string | null;
}

export interface AudienceProvisioning {
  audienceRef: string;
  channelId: string;
  consumerProfileId: string;
  requestedMode: 'display' | 'resume';
  validUntilMs: number;
}

/**
 * Managed delivery source-side operations (approved plan 02 §2.2 / 03).
 * Composition over SourceCore: shares the store, clock, memberships and route
 * staging machinery; never widens 1.1 behavior.
 */
export class ManagedSource {
  constructor(private readonly core: SourceCore) {}

  private get store(): Store {
    return this.core.store;
  }

  private publisherId(principal: SourcePrincipal): string {
    invariant(principal.kind !== 'invite' && principal.kind !== 'standing', 'unauthorized');
    return principal.kind === 'owner' ? 'owner' : `publisher:${principal.channelId}`;
  }

  private authorizePublisher(principal: SourcePrincipal, publisherId: string): void {
    invariant(this.publisherId(principal) === publisherId, 'unauthorized');
  }

  // ---- scopes ----

  /** advanceScope: expectedRevision=0 creates (authenticated init), else strict CAS +1. */
  advanceScope(principal: SourcePrincipal, input: ScopeAdvance): { revision: number; state: string } {
    const params = validateManaged('ScopeAdvance', input);
    const publisherId = this.publisherId(principal);
    const requestDigest = digest({ op: 'source.scope.advance', publisherId, params });
    const prior = this.store.operation<{ revision: number; state: string }>(params.operationId, requestDigest);
    if (prior) return prior;
    const result = this.store.txOperation(params.operationId, requestDigest, () => {
      const row = this.store.get<ScopeRow>(
        'SELECT * FROM managed_scopes WHERE publisher_id=? AND scope_id=?',
        publisherId,
        params.scopeId,
      );
      if (!row) {
        invariant(params.expectedRevision === 0 && params.nextRevision === 1, 'stale_scope_revision');
        invariant(params.state === 'active', 'invalid_payload');
        this.store.run(
          'INSERT INTO managed_scopes VALUES(?,?,?,?)',
          publisherId,
          params.scopeId,
          1,
          'active',
        );
        return { revision: 1, state: 'active' as const };
      }
      invariant(row.revision === params.expectedRevision, 'stale_scope_revision');
      invariant(params.nextRevision === row.revision + 1, 'stale_scope_revision');
      invariant(!(row.state === 'closed'), 'invalid_state'); // closed never reopens
      this.store.run(
        'UPDATE managed_scopes SET revision=?, state=? WHERE publisher_id=? AND scope_id=?',
        params.nextRevision,
        params.state,
        publisherId,
        params.scopeId,
      );
      return { revision: params.nextRevision, state: params.state };
    });
    return result;
  }

  // ---- audiences (owner-approved provisioning; wire owner.setup.commit arrives with the Pi-side UI) ----

  provisionAudience(principal: SourcePrincipal, input: AudienceProvisioning): { audienceRef: string } {
    invariant(principal.kind === 'owner', 'unauthorized');
    invariant(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.audienceRef), 'invalid_payload');
    const channel = this.core.config.channels.find((c) => c.id === input.channelId);
    invariant(channel, 'not_found');
    const isSentinel = input.validUntilMs === STANDING_EXPIRES_AT || input.validUntilMs === Number.MAX_SAFE_INTEGER;
    const isLocal = Boolean(channel.localTrust || this.core.config.realm === 'local');
    if (isSentinel) {
      invariant(isLocal, 'invalid_payload');
    } else {
      invariant(input.validUntilMs > 0 && input.validUntilMs <= MANAGED_LIMITS.maxManagedTtlMs, 'invalid_payload');
    }
    const now = this.core.clock.now();
    const result = this.store.tx(() => {
      invariant(input.requestedMode === 'display' || channel.allowedModes.includes('resume'), 'unauthorized');
      const memberships = this.store
        .all<{ binding: string; body: string; cut: number }>(
          "SELECT binding,body,cut FROM memberships WHERE channel=? AND state='active'",
          input.channelId,
        )
        .filter((m) => (JSON.parse(m.body) as { expiresAt: number }).expiresAt > now);
      const routeSet = memberships.map((m) => m.binding);
      const existing = this.store.get<AudienceRow>(
        'SELECT * FROM managed_audiences WHERE audience_ref=?',
        input.audienceRef,
      );
      if (existing) {
        // Idempotent reprovision with an identical frozen route set only.
        invariant(JSON.parse(existing.route_set_json).join(',') === routeSet.join(','), 'id_conflict');
        return { audienceRef: existing.audience_ref };
      }
      this.store.run(
        `INSERT INTO managed_audiences VALUES(?,?,?,?,?,?,?,?,?,?)`,
        input.audienceRef,
        'owner',
        input.channelId,
        canonical(routeSet),
        Number(this.store.meta('membershipCut') ?? 0),
        input.consumerProfileId,
        input.requestedMode,
        'open',
        now,
        isSentinel ? STANDING_EXPIRES_AT : now + input.validUntilMs,
      );
      return { audienceRef: input.audienceRef };
    });
    return result;
  }

  /**
   * Explicit lifecycle closure for an audience (session close / backend stop).
   * Prevents future publishes to this audience and removes it from sync pump scans.
   */
  closeAudience(principal: SourcePrincipal, audienceRef: string): { closed: boolean } {
    invariant(principal.kind === 'owner', 'unauthorized');
    invariant(typeof audienceRef === 'string' && audienceRef.length > 0, 'invalid_payload');
    return this.store.tx(() => {
      const row = this.store.get<AudienceRow>(
        'SELECT * FROM managed_audiences WHERE audience_ref=?',
        audienceRef,
      );
      invariant(row, 'not_found');
      if (row.state === 'closed') return { closed: true };
      this.store.run(
        "UPDATE managed_audiences SET state='closed' WHERE audience_ref=?",
        audienceRef,
      );
      return { closed: true };
    });
  }

  private audience(audienceRef: string): AudienceRow {
    const row = this.store.get<AudienceRow>(
      'SELECT * FROM managed_audiences WHERE audience_ref=?',
      audienceRef,
    );
    invariant(row, 'not_found');
    return row;
  }

  // ---- scope proof (03 §3.3 step 2; internal.source.proof) ----

  /** Short-lived scope/tombstone proof. The binding principal sees only events
   *  actually routed to it (02 §2.4: no cross-route leakage). */
  scopeProof(bindingId: string, eventIds: string[]): ScopeProof {
    invariant(Array.isArray(eventIds) && eventIds.length >= 1 && eventIds.length <= 32, 'invalid_payload');
    const now = this.core.clock.now();
    const proofs: ScopeProof['proofs'] = [];
    for (const eventId of eventIds) {
      const row = this.store.get<ManagedEventRow>(
        'SELECT * FROM managed_events WHERE event_id=?',
        eventId,
      );
      if (!row) continue;
      const options = JSON.parse(row.options_json) as { audienceRef: string };
      const audience = this.store.get<AudienceRow>(
        'SELECT * FROM managed_audiences WHERE audience_ref=? AND publisher_id=?',
        options.audienceRef,
        row.publisher_id,
      );
      if (
        !audience ||
        !(JSON.parse(audience.route_set_json) as string[]).includes(bindingId)
      )
        continue;
      const scope = this.store.get<ScopeRow>(
        'SELECT * FROM managed_scopes WHERE publisher_id=? AND scope_id=?',
        row.publisher_id,
        row.scope_id,
      );
      proofs.push({
        eventId,
        publisherId: row.publisher_id,
        scopeId: row.scope_id,
        scopeRevision: scope?.revision ?? row.scope_revision,
        scopeState: scope?.state ?? 'closed',
        tombstoned: !!this.store.get(
          'SELECT 1 FROM event_tombstones WHERE publisher_id=? AND event_id=?',
          row.publisher_id,
          eventId,
        ),
        audienceState: audience.state,
      });
    }
    return { issuedAt: now, validForMs: MANAGED_PROOF_VALIDITY_MS, proofs };
  }

  // ---- publish (02 §2.2/2.3, 03 §3.2 cancel-before-publish) ----

  async publishManaged(principal: SourcePrincipal, input: ManagedPublish): Promise<ManagedReceipt> {
    const params = validateManaged('ManagedPublish', input);
    const publisherId = this.publisherId(principal);
    const now = this.core.clock.now();
    const event = params.event;
    const optionsDigest = sha256(canonical(params.options));
    const eventDigest = digest(event as unknown as object);
    const validUntilMs = Math.min(
      Date.parse(event.validUntil) || 0,
      now + MANAGED_LIMITS.maxManagedTtlMs,
    );
    invariant(validUntilMs > now, 'binding_expired');
    invariant(
      Date.parse(event.occurredAt) - now <= MANAGED_LIMITS.clockSkewMs,
      'invalid_payload',
    );

    // tombstone before capture (03 §3.2): a withdrawn eventId never (re)captures.
    invariant(
      !this.store.get(
        'SELECT 1 FROM event_tombstones WHERE publisher_id=? AND event_id=?',
        publisherId,
        event.id,
      ),
      'cancelled',
    );
    const audience = this.audience(params.options.audienceRef);
    invariant(audience.publisher_id === 'owner' || audience.publisher_id === publisherId, 'unauthorized');
    invariant(audience.state === 'open', 'invalid_state');
    invariant(audience.valid_until > now, 'binding_expired');
    const scope = this.store.get<ScopeRow>(
      'SELECT * FROM managed_scopes WHERE publisher_id=? AND scope_id=?',
      publisherId,
      params.options.scope.id,
    );
    invariant(scope, 'not_found');
    invariant(scope.revision === params.options.scope.revision, 'stale_scope_revision');
    invariant(scope.state === 'active', 'invalid_state');

    // Identity: same (event, options) replays; same id different options conflicts (m10).
    const existing = this.store.get<ManagedEventRow>(
      'SELECT * FROM managed_events WHERE publisher_id=? AND event_id=?',
      publisherId,
      event.id,
    );
    if (existing) {
      invariant(
        existing.event_digest === eventDigest && existing.options_digest === optionsDigest,
        'id_conflict',
      );
      return this.managedReceipt(principal, event.id);
    }

    const routeSet = JSON.parse(audience.route_set_json) as string[];
    const packets: ManagedRoutePacket[] = [];
    const captured = this.store.tx(() => {
      this.store.run(
        `INSERT INTO managed_events VALUES(?,?,?,?,?,?,?,?,?,?)`,
        publisherId,
        event.id,
        params.options.scope.id,
        params.options.scope.revision,
        eventDigest,
        Buffer.from(canonical(event), 'utf8'),
        canonical(params.options),
        optionsDigest,
        validUntilMs,
        now,
      );
      const total = this.store.get<{ bytes: number }>(
        'SELECT coalesce(sum(length(event_bytes)),0) bytes FROM managed_events',
      )!;
      invariant(total.bytes <= LIMITS.journalBytes, 'backpressure');
      for (const bindingId of routeSet) {
        const m = this.core.membership(bindingId);
        const state = this.store.get<{ state: string }>(
          'SELECT state FROM memberships WHERE binding=?',
          bindingId,
        )!.state;
        const handle = privateJson(m.capabilityRef) as { proofKey: string; proofKeyId: string };
        const unsigned = {
          packetVersion: 2 as const,
          routeRef: digest({ bindingId, eventId: event.id }),
          bindingId,
          sourceId: this.core.config.sourceId,
          channelId: audience.channel_id,
          event,
          sourceEventDigest: eventDigest,
          fanoutId: newId('fanout'),
          membershipRevision: m.membershipRevision,
          routeCreatedAt: now,
          routeValidUntil: Math.min(validUntilMs, m.expiresAt),
          options: params.options,
          optionsDigest,
          proofKeyId: handle.proofKeyId,
        };
        packets.push(
          validateInternal('ManagedRoutePacket', {
            ...unsigned,
            proof: proof('pi-relay/managed-route-packet/v1', unsigned, handle.proofKey),
          }),
        );
      }
      // Route→binding index for the sync pump's ack tail (m9/A10). Written at
      // capture time — after the packets are built — so staged, retried and
      // directly-admitted routes are all covered.
      for (const packet of packets) {
        this.store.setMeta('managedRoute:' + packet.routeRef, packet.bindingId);
      }
      return true;
    });
    invariant(captured);

    // Dispatch: online push per route. Offline targets report admission 'unknown'
    // with freshness 'offline' — managed offline spool staging lands with the
    // stage-3 crash/race hardening, never silently claimed as durable here.
    for (const packet of packets) {
      await this.pushManagedPacket(packet);
    }
    return this.managedReceipt(principal, event.id);
  }

  private async pushManagedPacket(packet: ManagedRoutePacket): Promise<void> {
    let client: BindingClient | undefined;
    try {
      const handle = this.routeHandle(packet.bindingId);
      client = new BindingClient(handle, undefined, () => {
        invariant(
          this.store.get<{ state: string }>(
            'SELECT state FROM memberships WHERE binding=?',
            packet.bindingId,
          )?.state === 'active',
          'binding_revoked',
        );
      });
      const result = await client.publishManagedPacket(packet);
      // Managed offline spool staging (stage 3.5): offline/unknown routes get a
      // durable pending packet retried by the sync pump — never a silent
      // durability claim (receipt still reports admission unknown + offline).
      if (result.outcome === 'offline' || result.outcome === 'unknown')
        this.stagePendingRoute(packet);
      this.recordRouteAdmission(packet, result);
    } catch {
      this.stagePendingRoute(packet);
      this.recordRouteAdmission(packet, { outcome: 'offline' });
    } finally {
      client?.dispose();
    }
  }

  private stagePendingRoute(packet: ManagedRoutePacket): void {
    const publisherId = this.publisherIdOfEvent(packet.event.id);
    const now = this.core.clock.now();
    this.store.run(
      `INSERT OR IGNORE INTO managed_route_pending VALUES(?,?,?,?,?,?,?)`,
      publisherId,
      packet.event.id,
      packet.routeRef,
      canonical(packet),
      now,
      0,
      now,
    );
  }

  /** Sync-pump retry pass over due staged packets (stage 3.5). Withdrawn
   *  events drop their staging; revoked routes reject permanently; offline
   *  targets back off exponentially (1s..60s). Idempotent at the target via
   *  (route_ref,event_id) dedup with request equality. */
  async retryManagedPending(limit = 16): Promise<{ pushed: number; remaining: number }> {
    const now = this.core.clock.now();
    const rows = this.store.all<{
      publisher_id: string;
      event_id: string;
      route_ref: string;
      packet_json: string;
      attempts: number;
    }>(
      'SELECT * FROM managed_route_pending WHERE next_attempt_at<=? ORDER BY created_at LIMIT ?',
      now,
      limit,
    );
    let pushed = 0;
    for (const row of rows) {
      // A withdraw that landed while staged kills the pending push (03 §3.2).
      if (
        this.store.get(
          'SELECT 1 FROM event_tombstones WHERE publisher_id=? AND event_id=?',
          row.publisher_id,
          row.event_id,
        )
      ) {
        this.store.run(
          'DELETE FROM managed_route_pending WHERE publisher_id=? AND event_id=? AND route_ref=?',
          row.publisher_id,
          row.event_id,
          row.route_ref,
        );
        continue;
      }
      const packet = validateInternal('ManagedRoutePacket', JSON.parse(row.packet_json));
      let client: BindingClient | undefined;
      try {
        const handle = this.routeHandle(packet.bindingId);
        // Same membership gate as the first push: a binding revoked while the
        // packet was staged must not receive it on retry.
        client = new BindingClient(handle, undefined, () => {
          invariant(
            this.store.get<{ state: string }>('SELECT state FROM memberships WHERE binding=?', packet.bindingId)
              ?.state === 'active',
            'binding_revoked',
          );
        });
        const result = await client.publishManagedPacket(packet);
        if (result.outcome === 'accepted') {
          this.recordRouteAdmission(packet, result);
          this.store.run(
            'DELETE FROM managed_route_pending WHERE publisher_id=? AND event_id=? AND route_ref=?',
            row.publisher_id,
            row.event_id,
            row.route_ref,
          );
          pushed++;
        } else if (result.outcome === 'rejected') {
          this.recordRouteAdmission(packet, result);
          this.store.run(
            'DELETE FROM managed_route_pending WHERE publisher_id=? AND event_id=? AND route_ref=?',
            row.publisher_id,
            row.event_id,
            row.route_ref,
          );
        } else {
          this.backoffPendingRoute(row.publisher_id, row.event_id, row.route_ref, row.attempts, now);
        }
      } catch (e) {
        const error = safeError(e);
        if (error.code === 'not_found' || error.code === 'binding_revoked' || error.code === 'unauthorized') {
          // membership gone: the route can never accept this packet again
          this.recordRouteAdmission(packet, { outcome: 'rejected' });
          this.store.run(
            'DELETE FROM managed_route_pending WHERE publisher_id=? AND event_id=? AND route_ref=?',
            row.publisher_id,
            row.event_id,
            row.route_ref,
          );
        } else {
          this.backoffPendingRoute(row.publisher_id, row.event_id, row.route_ref, row.attempts, now);
        }
      } finally {
        client?.dispose();
      }
    }
    const remaining = (
      this.store.get<{ n: number }>('SELECT count(*) n FROM managed_route_pending')?.n ?? 0
    );
    return { pushed, remaining };
  }

  private backoffPendingRoute(
    publisherId: string,
    eventId: string,
    routeRef: string,
    attempts: number,
    now: number,
  ): void {
    this.store.run(
      'UPDATE managed_route_pending SET attempts=attempts+1, next_attempt_at=? WHERE publisher_id=? AND event_id=? AND route_ref=?',
      now + Math.min(60_000, 1000 * 2 ** attempts),
      publisherId,
      eventId,
      routeRef,
    );
  }

  private routeHandle(bindingId: string) {
    const m = this.core.membership(bindingId);
    return privateJson(m.capabilityRef) as ConstructorParameters<typeof BindingClient>[0];
  }

  private recordRouteAdmission(
    packet: ManagedRoutePacket,
    result: { outcome: string; state?: string },
  ): void {
    const routeRef = packet.routeRef;
    const publisherId = this.publisherIdOfEvent(packet.event.id);
    const admission =
      result.outcome === 'accepted'
        ? 'accepted'
        : result.outcome === 'rejected'
          ? 'rejected'
          : result.outcome === 'offline'
            ? 'unknown'
            : 'unknown';
    // Local admission facts live in a negative revision domain: they never
    // collide with the target's positive target_revision stream (M5 dedup)
    // and never block a later target fact from landing.
    const localRevision = -(
      this.store.get<{ n: number }>('SELECT coalesce(max(cursor),0) n FROM source_receipt_updates')!.n + 1
    );
    this.ingestUpdate({
      publisherId,
      eventId: packet.event.id,
      routeRef,
      targetRevision: localRevision,
      fact: {
        kind: 'managed-delivery',
        state: result.outcome === 'accepted' ? (result.state ?? 'pending') : 'pending',
        admission,
        at: this.core.clock.now(),
      },
    });
  }

  private publisherIdOfEvent(eventId: string): string {
    const rows = this.store.all<{ publisher_id: string }>(
      'SELECT DISTINCT publisher_id FROM managed_events WHERE event_id=?',
      eventId,
    );
    invariant(rows.length === 1, 'not_found');
    return rows[0].publisher_id;
  }

  routeRef(packet: { bindingId: string; event: { id: string } }): string {
    return digest({ bindingId: packet.bindingId, eventId: packet.event.id });
  }

  // ---- receipts / watch / snapshot (02 §2.4, delta-1 A2) ----

  managedReceipt(principal: SourcePrincipal, eventId: string): ManagedReceipt {
    const publisherId = this.publisherId(principal);
    const row = this.store.get<ManagedEventRow>(
      'SELECT * FROM managed_events WHERE publisher_id=? AND event_id=?',
      publisherId,
      eventId,
    );
    invariant(row, 'not_found');
    const audienceRef = (JSON.parse(row.options_json) as { audienceRef: string }).audienceRef;
    const audience = this.audience(audienceRef);
    const routeSet = JSON.parse(audience.route_set_json) as string[];
    const tombstone = this.store.get<{ created_at: number }>(
      'SELECT created_at FROM event_tombstones WHERE publisher_id=? AND event_id=?',
      publisherId,
      eventId,
    );
    const routes: RouteReceipt[] = routeSet.map((bindingId) => {
      const routeRef = this.routeRefForBinding(publisherId, eventId, bindingId);
      const latest = this.latestUpdate(publisherId, eventId, routeRef);
      const control = this.store.get<{ disposition: string }>(
        'SELECT disposition FROM route_controls WHERE publisher_id=? AND event_id=? AND route_ref=?',
        publisherId,
        eventId,
        routeRef,
      );
      const now = this.core.clock.now();
      const expired = row.valid_until <= now;
      let delivery: RouteReceipt['delivery'] = 'pending';
      let admission: RouteReceipt['admission'] = latest ? (latest.admission as RouteReceipt['admission']) : 'unknown';
      if (expired) delivery = 'expired';
      else if (tombstone) {
        delivery = 'withdrawn';
        admission = 'unknown';
      } else if (latest) {
        delivery = latest.state as RouteReceipt['delivery'];
        if (['suppressed', 'expired', 'withdrawn'].includes(latest.state)) delivery = latest.state as RouteReceipt['delivery'];
      }
      if (control?.disposition === 'prevented') delivery = 'withdrawn';
      if (control?.disposition === 'too_late') {
        // submitted/recorded deliveries are history; keep the observed delivery state.
      }
      const receipt: RouteReceipt = {
        routeRef,
        targetRevision: latest?.targetRevision ?? 0,
        freshness: (latest?.freshness ?? 'offline') as 'fresh' | 'stale' | 'offline',
        admission,
        delivery,
        withdrawal: (control?.disposition as RouteReceipt['withdrawal']) ?? (tombstone ? 'unknown' : 'none'),
      };
      if (latest?.observation) {
        (receipt as { observation?: unknown }).observation = latest.observation;
      }
      return receipt;
    });
    const responses = this.store
      .all<SourceResponseRow>(
        'SELECT * FROM source_responses WHERE publisher_id=? AND event_id=? ORDER BY source_cursor',
        publisherId,
        eventId,
      )
      .map((r) => this.toConsumerResponse(r));
    const sourceState: ManagedReceipt['sourceState'] = tombstone
      ? 'captured' // withdrawn events remain captured for audit; delivery reports withdrawn
      : 'captured';
    return {
      eventId,
      sourceState,
      sourceCursor: this.managedCursor(),
      scope: { id: row.scope_id, revision: row.scope_revision },
      routes,
      responses,
    };
  }

  private toConsumerResponse(r: SourceResponseRow): ConsumerResponse {
    const body = JSON.parse(r.body_json) as {
      responseType: string;
      schemaVersion: number;
      data: unknown;
      createdAt: string;
    };
    const response: ConsumerResponse = {
      responseId: r.response_id,
      deliveryRef: 'delivery:' + r.route_ref,
      responseType: body.responseType,
      schemaVersion: body.schemaVersion,
      data: body.data as { [key: string]: never },
      createdAt: body.createdAt,
      state: r.application_result_json ? 'application_applied' : 'source_recorded',
    };
    if (r.application_result_json) {
      (response as { applicationResult?: unknown }).applicationResult = JSON.parse(
        r.application_result_json,
      );
    }
    return response;
  }

  private routeRefForBinding(_publisherId: string, eventId: string, bindingId: string): string {
    // Deterministic routeRef derivable on both sides: digest(bindingId, eventId).
    return digest({ bindingId, eventId });
  }

  private latestUpdate(
    publisherId: string,
    eventId: string,
    routeRef: string,
  ): { targetRevision: number; admission: string; state: string; freshness: string; observation?: unknown } | undefined {
    const row = this.store.get<ReceiptUpdateRow>(
      // Ordering by insertion cursor, not target_revision: local admission facts
      // live in a negative revision domain (dedup keys only), while target
      // facts arrive in watch order — cursor order is the honest "latest".
      'SELECT * FROM source_receipt_updates WHERE publisher_id=? AND event_id=? AND route_ref=? ORDER BY cursor DESC LIMIT 1',
      publisherId,
      eventId,
      routeRef,
    );
    if (!row) return undefined;
    // Rows store the M5 envelope {authentication, fact}; the projection reads the fact.
    const envelope = JSON.parse(row.payload_json) as { fact?: Record<string, unknown> };
    const fact = envelope.fact ?? {};
    const freshness = fact.freshness === 'fresh' || fact.freshness === 'offline'
      ? fact.freshness
      : ('stale' as const);
    return {
      targetRevision: row.target_revision,
      admission: String(fact.admission ?? 'unknown'),
      state: String(fact.state ?? 'pending'),
      freshness,
      observation: fact.observation,
    };
  }

  managedCursor(): number {
    return (
      this.store.get<{ n: number }>('SELECT coalesce(max(cursor),0) n FROM source_receipt_updates')!.n
    );
  }

  managedWatch(
    principal: SourcePrincipal,
    after: number,
    limit: number,
  ): { cursor: number; resyncRequired: boolean; snapshotCursor?: number; updates: unknown[] } {
    const publisherId = this.publisherId(principal);
    invariant(Number.isSafeInteger(after) && after >= 0 && limit > 0 && limit <= 128, 'invalid_payload');
    const cursor = this.managedCursor();
    const min = this.store.get<{ n: number }>(
      'SELECT coalesce(min(cursor),1) n FROM source_receipt_updates WHERE publisher_id=?',
      publisherId,
    )!.n;
    // A2 resync boundary: `after+1` earlier than the smallest retained cursor → resync.
    if (after + 1 < min) {
      return {
        cursor,
        resyncRequired: true,
        snapshotCursor: min - 1,
        updates: [],
      };
    }
    invariant(after <= cursor, 'cursor_expired');
    const rows = this.store.all<ReceiptUpdateRow>(
      'SELECT * FROM source_receipt_updates WHERE publisher_id=? AND cursor>? ORDER BY cursor LIMIT ?',
      publisherId,
      after,
      limit,
    );
    return {
      cursor: rows.at(-1)?.cursor ?? after,
      resyncRequired: false,
      updates: rows.map((r) => ({
        cursor: r.cursor,
        eventId: r.event_id,
        routeRef: r.route_ref,
        targetRevision: r.target_revision,
        at: r.created_at,
        fact: JSON.parse(r.payload_json),
      })),
    };
  }

  managedSnapshot(principal: SourcePrincipal, afterEventId: string | undefined, limit: number) {
    const publisherId = this.publisherId(principal);
    invariant(limit > 0 && limit <= 128, 'invalid_payload');
    const rows = this.store
      .all<ManagedEventRow>(
        'SELECT * FROM managed_events WHERE publisher_id=? ORDER BY captured_at, event_id',
        publisherId,
      )
      .filter((r) => (afterEventId ? r.event_id > afterEventId : true))
      .slice(0, limit);
    return {
      snapshotCursor: this.managedCursor(),
      updates: rows.map((r) => ({
        eventId: r.event_id,
        receipt: this.managedReceipt(principal, r.event_id),
      })),
    };
  }

  // ---- withdraw (02 §2.6, 03 §3.2/3.4) ----

  withdraw(
    principal: SourcePrincipal,
    input: { operationId: string; eventId: string; reason: string },
  ): WithdrawResult {
    invariant(typeof input.operationId === 'string' && input.operationId.length > 0, 'invalid_payload');
    invariant(typeof input.eventId === 'string' && input.eventId.length > 0, 'invalid_payload');
    invariant(typeof input.reason === 'string' && input.reason.length > 0, 'invalid_payload');
    const publisherId = this.publisherId(principal);
    const requestDigest = digest({ op: 'source.event.withdraw', publisherId, input });
    const prior = this.store.operation<WithdrawResult>(input.operationId, requestDigest);
    if (prior) return prior;
    const result = this.store.txOperation<WithdrawResult>(input.operationId, requestDigest, () => {
      const now = this.core.clock.now();
      this.store.run(
        'INSERT OR IGNORE INTO event_tombstones VALUES(?,?,?,?,?)',
        publisherId,
        input.eventId,
        input.operationId,
        now,
        now + MANAGED_LIMITS.tombstoneRetentionDays * 24 * 3600 * 1000,
      );
      const row = this.store.get<ManagedEventRow>(
        'SELECT * FROM managed_events WHERE publisher_id=? AND event_id=?',
        publisherId,
        input.eventId,
      );
      const routes: Array<{ routeRef: string; disposition: 'prevented' | 'too_late' | 'pending' | 'unknown' }> = [];
      if (row) {
        const audienceRef = (JSON.parse(row.options_json) as { audienceRef: string }).audienceRef;
        const audience = this.audience(audienceRef);
        for (const bindingId of JSON.parse(audience.route_set_json) as string[]) {
          const routeRef = this.routeRefForBinding(publisherId, input.eventId, bindingId);
          const latest = this.latestUpdate(publisherId, input.eventId, routeRef);
          let disposition: 'prevented' | 'too_late' | 'pending' | 'unknown';
          if (latest && ['submitted', 'recorded'].includes(latest.state)) disposition = 'too_late';
          else if (latest && ['withdrawn', 'suppressed', 'expired'].includes(latest.state))
            disposition = 'prevented';
          else if (!latest) disposition = 'unknown';
          else disposition = 'pending';
          this.store.run(
            `INSERT INTO route_controls(control_id,publisher_id,event_id,route_ref,disposition,target_revision)
             VALUES(?,?,?,?,?,?)
             ON CONFLICT(publisher_id,event_id,route_ref) DO UPDATE SET disposition=excluded.disposition`,
            newId('ctl'),
            publisherId,
            input.eventId,
            routeRef,
            disposition,
            latest?.targetRevision ?? 0,
          );
          routes.push({ routeRef, disposition });
        }
      }
      return {
        operationId: input.operationId,
        eventId: input.eventId,
        sourceApplied: true,
        routes,
      };
    });
    return result;
  }

  // ---- confirmApplied (02 §2.2, 03 §3.5) ----

  confirmApplied(principal: SourcePrincipal, input: ResponseApplied): { applied: boolean } {
    const params = input;
    const publisherId = this.publisherId(principal);
    const requestDigest = digest({ op: 'source.response.applied', publisherId, params });
    const prior = this.store.operation<{ applied: boolean }>(params.operationId, requestDigest);
    if (prior) return prior;
    const result = this.store.txOperation(params.operationId, requestDigest, () => {
      const row = this.store.get<SourceResponseRow>(
        'SELECT * FROM source_responses WHERE response_id=?',
        params.responseId,
      );
      invariant(row && row.publisher_id === publisherId, 'not_found');
      if (row.application_result_json === null) {
        this.store.run(
          'UPDATE source_responses SET application_result_json=? WHERE response_id=? AND application_result_json IS NULL',
          canonical(params.result),
          params.responseId,
        );
        this.store.run(
          `INSERT OR IGNORE INTO application_ack_outbox(response_id,route_ref,payload_json,sent,at)
           VALUES(?,?,?,0,?)`,
          params.responseId,
          row.route_ref,
          canonical({ responseId: params.responseId, appliedAt: this.core.clock.now(), result: params.result }),
          this.core.clock.now(),
        );
      }
      return { applied: true };
    });
    return result;
  }

  // ---- target→source ingest (called by the source pump from 1.1 receipt-watch) ----

  ingestUpdate(input: {
    publisherId: string;
    eventId: string;
    routeRef: string;
    targetRevision: number;
    fact: Record<string, unknown>;
  }): boolean {
    let inserted = false;
    this.store.tx(() => {
      const envelope = { authentication: { kind: 'target-receipt-watch' }, fact: input.fact };
      const info = this.store.run(
        'INSERT OR IGNORE INTO source_receipt_updates(publisher_id,event_id,route_ref,target_revision,payload_json,created_at) VALUES(?,?,?,?,?,?)',
        input.publisherId,
        input.eventId,
        input.routeRef,
        input.targetRevision,
        canonical(envelope),
        this.core.clock.now(),
      );
      inserted = info.changes === 1;
      if (inserted && input.fact.kind === 'consumer-response') {
        const body = input.fact as {
          responseId: string;
          responseType: string;
          schemaVersion: number;
          data: unknown;
          digest: string;
          createdAt: string;
        };
        const existing = this.store.get<{ digest: string }>(
          'SELECT digest FROM source_responses WHERE response_id=?',
          body.responseId,
        );
        if (existing) {
          invariant(existing.digest === body.digest, 'id_conflict');
        } else {
          this.store.run(
            `INSERT INTO source_responses(response_id,publisher_id,event_id,route_ref,digest,body_json,source_cursor)
             VALUES(?,?,?,?,?,?,?)`,
            body.responseId,
            input.publisherId,
            input.eventId,
            input.routeRef,
            body.digest,
            canonical({
              responseType: body.responseType,
              schemaVersion: body.schemaVersion,
              data: body.data,
              createdAt: body.createdAt,
            }),
            this.managedCursor(),
          );
        }
      }
    });
    return inserted;
  }

  /** Managed routes to poll: binding ids across open audiences. */
  managedRouteBindings(): Array<{ bindingId: string; audienceRef: string }> {
    const rows = this.store.all<{ route_set_json: string; audience_ref: string }>(
      "SELECT route_set_json,audience_ref FROM managed_audiences WHERE state='open'",
    );
    const out: Array<{ bindingId: string; audienceRef: string }> = [];
    for (const r of rows) {
      for (const bindingId of JSON.parse(r.route_set_json) as string[]) {
        out.push({ bindingId, audienceRef: r.audience_ref });
      }
    }
    return out;
  }

  /** Map a binding receipt fact (from 1.1 watch) into managed receipt updates. */
  ingestBindingUpdate(bindingId: string, update: { eventId: string; kind: string; fact: unknown }): void {
    if (!update.eventId || typeof update.eventId !== 'string') return;
    const fact = (update.fact ?? {}) as Record<string, unknown>;
    const managed = this.store.all<{ publisher_id: string; event_id: string }>(
      'SELECT DISTINCT publisher_id,event_id FROM managed_events WHERE event_id=?',
      update.eventId,
    );
    for (const m of managed) {
      const routeRef = this.routeRefForBinding(m.publisher_id, m.event_id, bindingId);
      const targetRevision = Number(fact.targetRevision ?? 0) || 1;
      if (update.kind === 'consumer-response') {
        this.ingestUpdate({
          publisherId: m.publisher_id,
          eventId: m.event_id,
          routeRef,
          targetRevision,
          fact,
        });
      } else if (update.kind.startsWith('managed-')) {
        this.ingestUpdate({
          publisherId: m.publisher_id,
          eventId: m.event_id,
          routeRef,
          targetRevision,
          fact,
        });
      }
    }
  }

  /** Unsent application acks (source→target, m9/A10). */
  pendingAcks(): Array<{ responseId: string; routeRef: string; payloadJson: string }> {
    return this.store
      .all<{ response_id: string; route_ref: string; payload_json: string }>(
        'SELECT response_id, route_ref, payload_json FROM application_ack_outbox WHERE sent=0',
      )
      .map((r) => ({
        responseId: r.response_id,
        routeRef: r.route_ref,
        payloadJson: r.payload_json,
      }));
  }

  /** Deterministic legacy repair for acks whose route→binding meta was never
   *  written (pre-fix stores): routeRef = digest({bindingId, eventId}), so the
   *  binding is recoverable from the response's event and the membership set.
   *  A successful recovery persists the meta so it never re-scans. */
  recoverRouteBinding(routeRef: string, responseId: string): string | undefined {
    const resp = this.store.get<{ event_id: string }>(
      'SELECT event_id FROM source_responses WHERE response_id=?',
      responseId,
    );
    if (!resp) return undefined;
    for (const row of this.store.all<{ binding: string }>('SELECT binding FROM memberships')) {
      if (digest({ bindingId: row.binding, eventId: resp.event_id }) === routeRef) {
        this.store.setMeta('managedRoute:' + routeRef, row.binding);
        return row.binding;
      }
    }
    return undefined;
  }

  markAckSent(responseId: string, routeRef: string): void {
    this.store.run(
      'UPDATE application_ack_outbox SET sent=1 WHERE response_id=? AND route_ref=?',
      responseId,
      routeRef,
    );
  }
}

