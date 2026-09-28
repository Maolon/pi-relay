import type { TargetCore, Eligibility } from './core.js';
import type { Store } from '../store/database.js';
import type { ManagedRoutePacket, ScopeProof } from '../protocol/internal-types.js';
import type { GateResult } from '../protocol/managed-types.js';
import { validateInternal, validateManaged } from '../protocol/validate.js';
import { canonical, digest, equalSecret, newId, proof, withoutProof } from '../protocol/canonical.js';
import { invariant } from '../protocol/errors.js';
import { privateJson } from '../platform/private-paths.js';

export interface ConsumerProfileInput {
  profileId: string;
  eventManifestDigest: string;
  responseManifestDigest: string;
  guardImplementationId: string;
  timeoutMs: number;
  requireCurrentScope?: boolean;
}

export type GuardCallback = (
  event: ManagedRoutePacket['event'],
  context: ManagedGuardContext,
  signal: AbortSignal,
) => Promise<GateResult>;

/** Guard context per the approved consumer contract (01 §1.2 / contracts ConsumerContext):
 *  derived from durable target state, never from packet self-claims. */
export interface ManagedGuardContext {
  readonly deliveryRef: string;
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly profileId: string;
  readonly sourceId: string;
  readonly channelId: string;
  readonly scopeId: string;
  readonly scopeRevision: number;
}

interface ManagedDeliveryRow {
  delivery_ref: string;
  route_ref: string;
  event_id: string;
  scope_id: string;
  scope_revision: number;
  state: 'pending' | 'held' | 'intent' | 'submitted' | 'recorded' | 'unknown' | 'suppressed' | 'expired' | 'withdrawn';
  target_revision: number;
  consumer_profile_id: string;
  registration_epoch: number;
  request_json: string;
}

/**
 * Managed delivery target-side operations (approved plan 02 §2.5, 03 §3.3).
 * The pump runs inside the target's serial actuator: guard -> intent commit ->
 * invoke (no await between final recheck and invoke) -> submitted -> observed
 * -> recorded. Application acks advance consumer_response_outbox state.
 */
export class ManagedTarget {
  private readonly guards = new Map<string, { guard: GuardCallback; epoch: number }>();

  constructor(private readonly core: TargetCore) {
    // Restore semantics (03 §3.6): an 'intent' row predates this process — it
    // died between the intent commit and the invoke boundary, so it is unknown,
    // never auto-retried. 'submitted' stays for observation reconciliation,
    // exactly like the 1.1 attempts.
    core.store.tx(() => {
      core.store.run("UPDATE managed_deliveries SET state='unknown' WHERE state='intent'");
    });
  }

  private get store(): Store {
    return this.core.store;
  }

  // ---- admission (internal op from Source dispatch) ----

  admitManaged(input: ManagedRoutePacket): { deliveryRef: string; state: string; admission: 'accepted'; duplicate: boolean } {
    const packet = validateInternal('ManagedRoutePacket', input);
    const b = this.core.binding(packet.bindingId);
    this.core.usable(b);
    invariant(b.state === 'active', 'subscription_provisioning');
    invariant(
      packet.sourceId === b.proposal.sourceId && packet.channelId === b.proposal.channelId,
      'unauthorized',
    );
    const key = this.store.get<{ key_ref: string }>(
      'SELECT key_ref FROM credentials WHERE id=? AND binding=?',
      packet.proofKeyId,
      b.id,
    );
    invariant(key, 'unauthorized');
    const material = privateJson(key.key_ref) as { key: string };
    invariant(
      equalSecret(
        packet.proof,
        proof('pi-relay/managed-route-packet/v1', withoutProof(packet), material.key),
      ),
      'unauthorized',
    );
    invariant(digest(packet.event as unknown as object) === packet.sourceEventDigest, 'id_conflict');
    invariant(digest(packet.options as unknown as object) === packet.optionsDigest, 'id_conflict');
    invariant(
      packet.routeValidUntil <= b.expiresAt && packet.routeValidUntil > this.core.clock.now(),
      'binding_expired',
    );
    const result = this.store.tx(() => {
      const old = this.store.get<ManagedDeliveryRow>(
        'SELECT * FROM managed_deliveries WHERE route_ref=? AND event_id=?',
        packet.routeRef,
        packet.event.id,
      );
      if (old) {
        invariant(
          old.request_json === canonical({ event: packet.event, options: packet.options }),
          'id_conflict',
        );
        return { deliveryRef: old.delivery_ref, state: old.state, duplicate: true };
      }
      const held = this.core.holds(b.id).length > 0;
      const deliveryRef = newId('mdel');
      this.store.run(
        'INSERT OR IGNORE INTO managed_route_index VALUES(?,?,?)',
        packet.routeRef,
        b.id,
        packet.event.id,
      );
      this.store.run(
        `INSERT INTO managed_deliveries VALUES(?,?,?,?,?,?,?,?,?,?)`,
        deliveryRef,
        packet.routeRef,
        packet.event.id,
        packet.options.scope.id,
        packet.options.scope.revision,
        held ? 'held' : 'pending',
        1,
        packet.options.consumerProfileId,
        1,
        canonical({ event: packet.event, options: packet.options }),
      );
      this.appendManaged(b.id, packet.event.id, {
        kind: 'managed-delivery',
        routeRef: packet.routeRef,
        deliveryRef,
        state: held ? 'held' : 'pending',
        targetRevision: 1,
        admission: 'accepted',
        freshness: 'fresh',
        at: this.core.clock.now(),
      });
      return { deliveryRef, state: held ? 'held' : 'pending', duplicate: false };
    });
    this.core.options.onChange?.();
    return { ...result, admission: 'accepted' as const };
  }

  // ---- consumer registration (02 §2.5) ----

  registerConsumer(
    profile: ConsumerProfileInput,
    guard: GuardCallback,
  ): { profileId: string; epoch: number } {
    invariant(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(profile.profileId), 'invalid_payload');
    invariant(profile.timeoutMs > 0 && profile.timeoutMs <= 10_000, 'invalid_payload');
    const now = this.core.clock.now();
    const out = this.store.tx(() => {
      const existing = this.store.get<{ epoch: number }>(
        'SELECT epoch FROM consumer_registrations WHERE profile_id=?',
        profile.profileId,
      );
      const epoch = (existing?.epoch ?? 0) + 1;
      this.store.run(
        `INSERT INTO consumer_registrations VALUES(?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(profile_id) DO UPDATE SET
           event_manifest_digest=excluded.event_manifest_digest,
           response_manifest_digest=excluded.response_manifest_digest,
           guard_implementation_id=excluded.guard_implementation_id,
           timeout_ms=excluded.timeout_ms,
           require_current_scope=excluded.require_current_scope,
           owner_approved=excluded.owner_approved,
           epoch=excluded.epoch,
           updated_at=excluded.updated_at`,
        profile.profileId,
        profile.eventManifestDigest,
        profile.responseManifestDigest,
        profile.guardImplementationId,
        profile.timeoutMs,
        profile.requireCurrentScope ? 1 : 0,
        1, // owner approval: local trusted registration from the extension surface (stage 2)
        epoch,
        now,
        now,
      );
      return { profileId: profile.profileId, epoch };
    });
    this.guards.set(profile.profileId, { guard, epoch: out.epoch });
    return out;
  }

  // ---- consumer respond (02 §2.5) ----

  respond(input: {
    operationId: string;
    deliveryRef: string;
    responseType: string;
    schemaVersion: number;
    data: unknown;
  }): {
    responseId: string;
    state: 'target_staged' | 'source_recorded' | 'application_applied';
    duplicate?: boolean;
  } {
    invariant(
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.operationId) &&
        typeof input.deliveryRef === 'string' &&
        typeof input.responseType === 'string' &&
        Number.isSafeInteger(input.schemaVersion),
      'invalid_payload',
    );
    const principal = 'consumer:local';
    const body = {
      responseType: input.responseType,
      schemaVersion: input.schemaVersion,
      data: input.data,
    };
    const bodyDigest = digest(body);
    const result = this.store.tx(() => {
      const prior = this.store.get<{ body_json: string; response_id: string; state: string }>(
        'SELECT body_json,response_id,state FROM consumer_response_outbox WHERE principal=? AND operation_id=?',
        principal,
        input.operationId,
      );
      if (prior) {
        const priorDigest = digest(
          (JSON.parse(prior.body_json) as { body: unknown }).body,
        );
        invariant(priorDigest === bodyDigest, 'id_conflict');
        return { responseId: prior.response_id, state: prior.state as 'target_staged', duplicate: true };
      }
      const delivery = this.store.get<ManagedDeliveryRow>(
        'SELECT * FROM managed_deliveries WHERE delivery_ref=?',
        input.deliveryRef,
      );
      invariant(delivery, 'not_found');
      // A response may only follow a delivery the host could actually act
      // on: terminal outcomes (expired/withdrawn/suppressed) and transient
      // pre-invoke states never accept one (02 §2.5 respond semantics).
      invariant(
        delivery.state === 'recorded' ||
          delivery.state === 'submitted' ||
          delivery.state === 'held' ||
          delivery.state === 'pending',
        'invalid_state',
      );
      const registration = this.store.get<{ response_manifest_digest: string }>(
        'SELECT response_manifest_digest FROM consumer_registrations WHERE profile_id=?',
        delivery.consumer_profile_id,
      );
      invariant(registration, 'invalid_state');
      const responseId = newId('resp');
      this.store.run(
        `INSERT INTO consumer_response_outbox VALUES(?,?,?,?,?,?,?,NULL)`,
        responseId,
        input.deliveryRef,
        input.operationId,
        principal,
        bodyDigest,
        canonical({ body }),
        'target_staged',
      );
      this.appendManaged(delivery.event_id && this.bindingOf(delivery), delivery.event_id, {
        kind: 'consumer-response',
        routeRef: delivery.route_ref,
        deliveryRef: delivery.delivery_ref,
        responseId,
        responseType: input.responseType,
        schemaVersion: input.schemaVersion,
        data: input.data,
        digest: bodyDigest,
        createdAt: new Date(this.core.clock.now()).toISOString(),
        targetRevision: this.bumpTargetRevision(delivery.delivery_ref),
        at: this.core.clock.now(),
      });
      return { responseId, state: 'target_staged' as const };
    });
    this.core.options.onChange?.();
    return result;
  }

  /** Owner-visible consumer registration projection (no guard code, no
   *  tokens): durable rows plus liveness of the in-process guard and
   *  per-profile delivery state counts. */
  listConsumers(): Array<{
    profileId: string;
    eventManifestDigest: string;
    responseManifestDigest: string;
    guardImplementationId: string;
    timeoutMs: number;
    requireCurrentScope: boolean;
    epoch: number;
    updatedAt: number;
    guardLive: boolean;
    deliveries: Record<string, number>;
  }> {
    const rows = this.store.all<{
      profile_id: string;
      event_manifest_digest: string;
      response_manifest_digest: string;
      guard_implementation_id: string;
      timeout_ms: number;
      require_current_scope: number;
      epoch: number;
      updated_at: number;
    }>('SELECT * FROM consumer_registrations ORDER BY profile_id');
    return rows.map((row) => {
      const counts = this.store.all<{ state: string; n: number }>(
        'SELECT state, COUNT(*) AS n FROM managed_deliveries WHERE consumer_profile_id=? GROUP BY state',
        row.profile_id,
      );
      const deliveries: Record<string, number> = {};
      for (const c of counts) deliveries[c.state] = c.n;
      return {
        profileId: row.profile_id,
        eventManifestDigest: row.event_manifest_digest,
        responseManifestDigest: row.response_manifest_digest,
        guardImplementationId: row.guard_implementation_id,
        timeoutMs: row.timeout_ms,
        requireCurrentScope: !!row.require_current_scope,
        epoch: row.epoch,
        updatedAt: row.updated_at,
        guardLive: this.guards.get(row.profile_id)?.epoch === row.epoch,
        deliveries,
      };
    });
  }

  /** Remove a consumer registration. Live guards are dropped; the pump then
   *  defers that profile's deliveries (GUARD_UNAVAILABLE, no wake budget),
   *  so revocation never forges an outcome. */
  revokeConsumer(profileId: string): { profileId: string; revoked: boolean } {
    invariant(typeof profileId === 'string' && profileId.length > 0, 'invalid_payload');
    const result = this.store.tx(() => {
      const r = this.store.run('DELETE FROM consumer_registrations WHERE profile_id=?', profileId);
      return { profileId, revoked: r.changes > 0 };
    });
    this.guards.delete(profileId);
    this.core.options.onChange?.();
    return result;
  }

  /** Read-only managed-delivery projection for owner display: state,
   *  revisions and routing only — never transcript or event payloads. */
  managedDeliveries(filter?: {
    profileId?: string;
    state?: string;
    limit?: number;
  }): Array<{
    deliveryRef: string;
    eventId: string;
    eventType: string;
    bindingId: string;
    scopeId: string;
    scopeRevision: number;
    consumerProfileId: string;
    state: string;
    targetRevision: number;
    rowId: number;
  }> {
    const limit = Math.min(Math.max(filter?.limit ?? 20, 1), 100);
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.profileId) {
      where.push('consumer_profile_id=?');
      params.push(filter.profileId);
    }
    if (filter?.state) {
      where.push('state=?');
      params.push(filter.state);
    }
    const rows = this.store.all<ManagedDeliveryRow & { row_id: number }>(
      `SELECT *, rowid AS row_id FROM managed_deliveries ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY rowid DESC LIMIT ` +
        limit,
      ...params,
    );
    return rows.map((row) => {
      const request = JSON.parse(row.request_json) as {
        event: { type: string };
      };
      return {
        deliveryRef: row.delivery_ref,
        eventId: row.event_id,
        eventType: request.event.type,
        bindingId: this.bindingOf(row),
        scopeId: row.scope_id,
        scopeRevision: row.scope_revision,
        consumerProfileId: row.consumer_profile_id,
        state: row.state,
        targetRevision: row.target_revision,
        rowId: row.row_id,
      };
    });
  }

  /** Authoritative packet projection for respond callers: the stored event
   *  payload (attention envelope) plus routing, without transcript data.
   *  Used by the Pi-session respond surfaces to rebuild the consumer
   *  response body from durable state instead of trusting caller input. */
  managedDeliveryPacket(deliveryRef: string): {
    deliveryRef: string;
    eventId: string;
    eventType: string;
    consumerProfileId: string;
    state: string;
    data: unknown;
  } {
    invariant(typeof deliveryRef === 'string' && deliveryRef.length > 0, 'invalid_payload');
    const row = this.store.get<ManagedDeliveryRow>(
      'SELECT * FROM managed_deliveries WHERE delivery_ref=?',
      deliveryRef,
    );
    invariant(row, 'not_found');
    const request = JSON.parse(row.request_json) as {
      event: { type: string; data: unknown };
    };
    return {
      deliveryRef: row.delivery_ref,
      eventId: row.event_id,
      eventType: request.event.type,
      consumerProfileId: row.consumer_profile_id,
      state: row.state,
      data: request.event.data,
    };
  }

  private bindingOf(delivery: ManagedDeliveryRow): string {
    const row = this.store.get<{ binding: string }>(
      'SELECT binding FROM managed_route_index WHERE route_ref=?',
      delivery.route_ref,
    );
    invariant(row, 'invalid_state');
    return row.binding;
  }

  private bumpTargetRevision(deliveryRef: string): number {
    this.store.run(
      'UPDATE managed_deliveries SET target_revision=target_revision+1 WHERE delivery_ref=?',
      deliveryRef,
    );
    return this.store.get<{ target_revision: number }>(
      'SELECT target_revision FROM managed_deliveries WHERE delivery_ref=?',
      deliveryRef,
    )!.target_revision;
  }

  private appendManaged(bindingId: string, eventId: string, fact: Record<string, unknown>): void {
    // Route managed facts through the 1.1 receipts stream: the source pump
    // (receipt-watch) ingests managed-* / consumer-response kinds.
    this.core.append(bindingId, eventId, String(fact.kind), fact);
  }

  // ---- managed pump (03 §3.3) ----

  /** One pump pass over pending managed deliveries for resume-mode requests.
   *  `proof` (03 §3.3 step 2) fetches a short-lived source scope/tombstone proof
   *  before the guard; Source unavailable defers deliveries whose registration
   *  requires a confirmable current scope. */
  async pumpManaged(
    eligibility: Eligibility,
    invoke: (packet: { event: ManagedRoutePacket['event']; options: ManagedRoutePacket['options'] }, deliveryRef: string) => Promise<{ evidence: 'runtime-entry' | 'file-entry'; observation?: unknown } | undefined>,
    proof?: (bindingId: string, eventIds: string[]) => Promise<ScopeProof | undefined>,
  ): Promise<{ claimed: number; deferred: boolean }> {
    if (
      !this.core.ready ||
      !eligibility.idle ||
      eligibility.pending ||
      eligibility.knownWait ||
      eligibility.strictNoAutoResume
    )
      return { claimed: 0, deferred: false };
    let claimed = 0;
    let deferred = false;
    for (;;) {
      const delivery = this.claimNextManaged();
      if (!delivery) break;
      claimed++;
      const request = JSON.parse(delivery.request_json) as {
        event: ManagedRoutePacket['event'];
        options: ManagedRoutePacket['options'];
      };
      // Scope proof (03 §3.3 step 2): shrink the stale window before the guard.
      const registration = this.store.get<{ require_current_scope: number }>(
        'SELECT require_current_scope FROM consumer_registrations WHERE profile_id=?',
        delivery.consumer_profile_id,
      );
      if (proof) {
        const fetched = await proof(this.bindingOf(delivery), [delivery.event_id]);
        const fresh =
          fetched && fetched.issuedAt + fetched.validForMs > this.core.clock.now();
        if (!fresh) {
          // Source not confirmable within the proof window (02 §2.5).
          if (registration?.require_current_scope) break;
        } else {
          const entry = fetched.proofs.find((p) => p.eventId === delivery.event_id);
          if (entry) {
            if (
              entry.tombstoned ||
              entry.scopeState !== 'active' ||
              entry.scopeRevision > delivery.scope_revision ||
              entry.audienceState !== 'open'
            ) {
              // Fenced at the source (03 §3.2): withdraw semantics, no invoke,
              // no budget — the control propagation will confirm the cut.
              this.setState(delivery.delivery_ref, 'withdrawn');
              continue;
            }
          } else if (registration?.require_current_scope) {
            deferred = true;
            break; // unknown at source: defer
          }
        }
      } else if (registration?.require_current_scope) {
        deferred = true;
        break; // no proof channel available and scope must be confirmable: defer
      }
      // Consumer gate (02 §2.5): registered guard decides per delivery.
      const gate = await this.runGuard(delivery, request);
      if (gate.decision === 'defer') {
        deferred = true;
        break; // BUSY/GUARD_UNAVAILABLE: stop this pass, delivery stays pending, no claim consumed
      }
      if (gate.decision === 'drop') {
        this.setState(delivery.delivery_ref, 'suppressed');
        continue;
      }
      // Guard said allow. Grant-gated, state-conditional intent commit (03 §3.3 step 4):
      // a control that landed while the guard was in flight has already marked this
      // delivery withdrawn — the conditional transition refuses to override it and
      // no budget is consumed. No await between this transition and the invoke boundary.
      if (!this.advanceToIntent(delivery)) break;
      this.core.options.fault?.('managed.after_intent_commit');
      let outcome: Awaited<ReturnType<typeof invoke>>;
      try {
        outcome = await invoke(request, delivery.delivery_ref);
      } catch {
        this.setState(delivery.delivery_ref, 'unknown');
        continue;
      }
      if (!outcome) {
        this.setState(delivery.delivery_ref, 'unknown');
        continue;
      }
      this.setState(delivery.delivery_ref, 'submitted');
      this.observeManaged(delivery.delivery_ref, outcome.evidence, outcome.observation);
    }
    return { claimed, deferred };
  }

  private async runGuard(
    delivery: ManagedDeliveryRow,
    request: { event: ManagedRoutePacket['event']; options: ManagedRoutePacket['options'] },
  ): Promise<GateResult> {
    const registration = this.store.get<{
      profile_id: string;
      timeout_ms: number;
      epoch: number;
      require_current_scope: number;
    }>('SELECT * FROM consumer_registrations WHERE profile_id=?', delivery.consumer_profile_id);
    if (!registration) return { decision: 'defer', reasonCode: 'GUARD_UNAVAILABLE', guardEpoch: 1 };
    const live = this.guards.get(registration.profile_id);
    if (!live || live.epoch !== registration.epoch)
      return { decision: 'defer', reasonCode: 'GUARD_UNAVAILABLE', guardEpoch: registration.epoch };
    if (registration.require_current_scope) {
      const fenced = this.store.get<{ state: string }>(
        'SELECT state FROM managed_scope_fence WHERE scope_id=? AND revision>=?',
        delivery.scope_id,
        delivery.scope_revision,
      );
      if (fenced && fenced.state !== 'active')
        return { decision: 'drop', reasonCode: 'CANCELLED', guardEpoch: registration.epoch };
    }
    const guardBindingId = this.bindingOf(delivery);
    const guardBinding = this.core.binding(guardBindingId);
    const context: ManagedGuardContext = {
      deliveryRef: delivery.delivery_ref,
      bindingId: guardBindingId,
      bindingRevision: guardBinding.revision,
      profileId: registration.profile_id,
      sourceId: guardBinding.proposal.sourceId,
      channelId: guardBinding.proposal.channelId,
      scopeId: delivery.scope_id,
      scopeRevision: delivery.scope_revision,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), registration.timeout_ms);
    try {
      const gate = validateManaged('GateResult', await live.guard(
        request.event,
        context,
        controller.signal,
      ));
      if (gate.decision === 'allow' && gate.validUntil && Date.parse(gate.validUntil) <= this.core.clock.now())
        return { decision: 'defer', reasonCode: 'STALE_REQUEST', guardEpoch: gate.guardEpoch };
      return gate;
    } catch {
      return { decision: 'defer', reasonCode: 'GUARD_UNAVAILABLE', guardEpoch: registration.epoch };
    } finally {
      clearTimeout(timer);
    }
  }

  private claimNextManaged(): ManagedDeliveryRow | undefined {
    const rows = this.store.all<ManagedDeliveryRow>(
      "SELECT * FROM managed_deliveries WHERE state IN ('pending','held') ORDER BY rowid",
    );
    for (const row of rows) {
      const request = JSON.parse(row.request_json) as {
        event: { type: string; validUntil?: string };
        options: { requestedMode: string };
      };
      // Event expiry during retry (03 §3.6): end auto-resume, keep local facts.
      if (request.event.validUntil && Date.parse(request.event.validUntil) <= this.core.clock.now()) {
        this.setState(row.delivery_ref, 'expired');
        continue;
      }
      // Display-mode managed events never auto-resume (02 §2.3 requestedMode).
      if (request.options.requestedMode !== 'resume') continue;
      // Owner authority + budget (01 §1.3 / 03 §3.7): managed resume claims consume
      // the same armed grants as the 1.1 pump — no auto-resume without owner arming.
      if (!this.eligibleForClaim(row, request.event.type)) continue;
      return row;
    }
    return undefined;
  }

  private eligibleForClaim(row: ManagedDeliveryRow, eventType: string): boolean {
    try {
      const bindingId = this.bindingOf(row);
      const b = this.core.binding(bindingId);
      if (b.state !== 'active' || b.authority !== 'valid' || b.expiresAt <= this.core.clock.now()) return false;
      if (this.core.holds(bindingId).length) return false;
      if (b.proposal.policy[eventType]?.model !== 'resume') return false;
      const grantRow = this.store.get<{ body: string; consumed: number }>(
        'SELECT body, consumed FROM grants WHERE binding=? AND active=1',
        bindingId,
      );
      if (!grantRow) return false;
      const grant = JSON.parse(grantRow.body) as {
        revision: number;
        attachmentId: string;
        foregroundEpoch: number;
        scopeRevision: number;
        expiresAt: number;
        request: { maxClaims: number; sessionScoped?: boolean; standing?: boolean; eventTypes: string[] };
      };
      return !(
        grant.revision !== b.revision ||
        grant.attachmentId !== this.core.attachmentId ||
        grant.scopeRevision !== b.scopeRevision ||
        (!grant.request.standing && grant.expiresAt <= this.core.clock.now()) ||
        (!grant.request.standing && grantRow.consumed >= grant.request.maxClaims) ||
        (!grant.request.sessionScoped && grant.foregroundEpoch !== this.core.foregroundEpoch) ||
        !grant.request.eventTypes.includes(eventType)
      );
    } catch {
      return false;
    }
  }

  /** Grant-gated, state-conditional pending→intent transition (03 §3.3 step 4).
   * Returns false when a control withdrew the delivery mid-guard (I17: the cut
   * wins, no invoke, no budget consumed) — callers must not invoke then. */
  private advanceToIntent(delivery: ManagedDeliveryRow): boolean {
    return this.store.tx(() => {
      const fresh = this.store.get<ManagedDeliveryRow>(
        'SELECT * FROM managed_deliveries WHERE delivery_ref=?',
        delivery.delivery_ref,
      );
      if (!fresh || !['pending', 'held'].includes(fresh.state)) return false;
      const request = JSON.parse(fresh.request_json) as { event: { type: string } };
      if (!this.eligibleForClaim(fresh, request.event.type)) return false;
      const changed = this.store
        .run(
          `UPDATE managed_deliveries SET state='intent', target_revision=target_revision+1,
             registration_epoch=COALESCE((SELECT epoch FROM consumer_registrations WHERE profile_id=?), registration_epoch)
           WHERE delivery_ref=? AND state IN ('pending','held')`,
          fresh.consumer_profile_id,
          fresh.delivery_ref,
        )
        .changes;
      if (!changed) return false;
      this.store.run(
        'UPDATE grants SET consumed=consumed+1 WHERE id=(SELECT id FROM grants WHERE binding=? AND active=1)',
        this.bindingOf(fresh),
      );
      this.appendManaged(this.bindingOf(fresh), fresh.event_id, {
        kind: 'managed-delivery',
        routeRef: fresh.route_ref,
        deliveryRef: fresh.delivery_ref,
        state: 'intent',
        targetRevision: fresh.target_revision + 1,
        admission: 'accepted',
        freshness: 'fresh',
        at: this.core.clock.now(),
      });
      return true;
    });
  }

  setState(deliveryRef: string, state: ManagedDeliveryRow['state']): void {
    this.store.tx(() => {
      const row = this.store.get<ManagedDeliveryRow>(
        'SELECT * FROM managed_deliveries WHERE delivery_ref=?',
        deliveryRef,
      );
      if (!row) return;
      this.store.run(
        'UPDATE managed_deliveries SET state=?, target_revision=target_revision+1 WHERE delivery_ref=?',
        state,
        deliveryRef,
      );
      this.appendManaged(this.bindingOf(row), row.event_id, {
        kind: 'managed-delivery',
        routeRef: row.route_ref,
        deliveryRef,
        state,
        targetRevision: row.target_revision + 1,
        admission: 'accepted',
        freshness: 'fresh',
        at: this.core.clock.now(),
      });
    });
    this.core.options.onChange?.();
  }

  /** Runtime/file observation entry for the Pi session port (M1/I18: recorded
   *  requires real evidence with an observation time). */
  observeSubmitted(deliveryRef: string, evidence: 'runtime-entry' | 'file-entry'): boolean {
    return this.observeManaged(deliveryRef, evidence, {
      evidence,
      observedAt: new Date(this.core.clock.now()).toISOString(),
    });
  }

  observeManaged(deliveryRef: string, evidence: string, observation: unknown): boolean {
    return this.store.tx(() => {
      const row = this.store.get<ManagedDeliveryRow>(
        'SELECT * FROM managed_deliveries WHERE delivery_ref=?',
        deliveryRef,
      );
      if (!row || row.state !== 'submitted') return false;
      this.store.run(
        'UPDATE managed_deliveries SET state=?, target_revision=target_revision+1 WHERE delivery_ref=?',
        'recorded',
        deliveryRef,
      );
      this.appendManaged(this.bindingOf(row), row.event_id, {
        kind: 'managed-delivery',
        routeRef: row.route_ref,
        deliveryRef,
        state: 'recorded',
        targetRevision: row.target_revision + 1,
        admission: 'accepted',
        freshness: 'fresh',
        evidence,
        observation: observation ?? { evidence },
        at: this.core.clock.now(),
      });
      return true;
    });
  }

  // ---- control propagation (03 §3.4) ----

  applyControl(params: {
    kind: 'event-withdraw' | 'scope-fence';
    eventId?: string;
    scopeId?: string;
    scopeRevision?: number;
    controlId: string;
  }): { cuts: Array<{ deliveryRef: string; disposition: string }>; appliedAt: number } {
    const result = this.store.tx(() => {
      // Control replay (03 §3.4): stable controlId is idempotent — a retried
      // push returns the recorded cuts without re-applying or re-emitting facts.
      const prefix = params.controlId + ':';
      const recorded = this.store.all<{ control_id: string; result_json: string }>(
        'SELECT control_id, result_json FROM target_controls WHERE substr(control_id,1,?)=?',
        prefix.length,
        prefix,
      );
      if (recorded.length) {
        const first = JSON.parse(recorded[0].result_json) as {
          cuts: Array<{ deliveryRef: string; disposition: string }>;
          appliedAt: number;
        };
        return first;
      }
      const now = this.core.clock.now();
      const cuts: Array<{ deliveryRef: string; disposition: string }> = [];
      let rows: ManagedDeliveryRow[];
      if (params.kind === 'event-withdraw') {
        invariant(params.eventId, 'invalid_payload');
        rows = this.store.all<ManagedDeliveryRow>(
          'SELECT * FROM managed_deliveries WHERE event_id=?',
          params.eventId,
        );
      } else {
        invariant(params.scopeId && params.scopeRevision, 'invalid_payload');
        rows = this.store.all<ManagedDeliveryRow>(
          'SELECT * FROM managed_deliveries WHERE scope_id=? AND scope_revision<?',
          params.scopeId,
          params.scopeRevision,
        );
        this.store.run(
          'INSERT OR REPLACE INTO managed_scope_fence VALUES(?,?,?)',
          params.scopeId,
          params.scopeRevision,
          'paused',
        );
      }
      for (const row of rows) {
        let disposition: string;
        if (['submitted', 'recorded'].includes(row.state)) disposition = 'too_late';
        else if (['withdrawn', 'suppressed', 'expired'].includes(row.state)) disposition = 'prevented';
        else {
          disposition = row.state === 'intent' ? 'unknown' : 'prevented';
          if (disposition === 'prevented') {
            this.store.run(
              'UPDATE managed_deliveries SET state=?, target_revision=target_revision+1 WHERE delivery_ref=?',
              'withdrawn',
              row.delivery_ref,
            );
          }
        }
        this.store.run(
          'INSERT OR IGNORE INTO target_controls VALUES(?,?,?,?,?)',
          params.controlId + ':' + row.delivery_ref,
          row.delivery_ref,
          disposition,
          row.target_revision,
          canonical({ cuts: [{ deliveryRef: row.delivery_ref, disposition }], appliedAt: now }),
        );
        cuts.push({ deliveryRef: row.delivery_ref, disposition });
        this.appendManaged(this.bindingOf(row), row.event_id, {
          kind: 'managed-cut',
          routeRef: row.route_ref,
          deliveryRef: row.delivery_ref,
          disposition,
          targetRevision: this.bumpTargetRevision(row.delivery_ref),
          at: now,
        });
      }
      return { cuts, appliedAt: now };
    });
    this.core.options.onChange?.();
    return result;
  }

  // ---- application ack (m9/A10) ----

  applyAck(params: { responseId: string; appliedAt: number; result: unknown }): { applied: boolean } {
    return this.store.tx(() => {
      const outbox = this.store.get<{ response_id: string; delivery_ref: string }>(
        'SELECT response_id,delivery_ref FROM consumer_response_outbox WHERE response_id=?',
        params.responseId,
      );
      if (!outbox) return { applied: false };
      const info = this.store.run(
        'INSERT OR IGNORE INTO application_ack_inbox VALUES(?,?,?,?)',
        params.responseId,
        outbox.delivery_ref,
        params.appliedAt,
        canonical(params.result),
      );
      if (info.changes === 1) {
        this.store.run(
          "UPDATE consumer_response_outbox SET state='application_applied', application_result_json=? WHERE response_id=?",
          canonical(params.result),
          params.responseId,
        );
      }
      return { applied: true };
    });
  }

  /** Receipt outbox projection for the source pump (stage 2 uses the 1.1 watch stream). */
  listManagedResponses(unsentOnly = true): Array<{ responseId: string; deliveryRef: string; state: string; bodyJson: string }> {
    return this.store
      .all<{ response_id: string; delivery_ref: string; state: string; body_json: string }>(
        unsentOnly
          ? "SELECT response_id,delivery_ref,state,body_json FROM consumer_response_outbox WHERE state IN ('target_staged','source_recorded')"
          : 'SELECT response_id,delivery_ref,state,body_json FROM consumer_response_outbox',
      )
      .map((r) => ({
        responseId: r.response_id,
        deliveryRef: r.delivery_ref,
        state: r.state,
        bodyJson: r.body_json,
      }));
  }
}
