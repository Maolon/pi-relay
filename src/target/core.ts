import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { OwnerLock } from '../platform/owner-lock.js';
import type {
  AdmissionResult,
  BindingHandle,
  EventReceipt,
  GrantRequest,
  MembershipProof,
  OwnerCommand,
  PreparedBinding,
  Progress,
  RoutePacket,
  TargetProposal,
  TypeManifest,
  Observation,
} from '../protocol/types.js';
import {
  authenticate,
  canonical,
  digest,
  equalSecret,
  newId,
  proof,
  secret,
  sha256,
  withoutProof,
} from '../protocol/canonical.js';
import { deadline, LIMITS, Registry, validate } from '../protocol/validate.js';
import { STANDING_EXPIRES_AT } from '../protocol/constants.js';
import { invariant, fail } from '../protocol/errors.js';
import { privateDir, privateJson } from '../platform/private-paths.js';
import { installPrivate, replaceDiscovery } from '../platform/atomic-file.js';
import { wallClock, type Clock, type FaultHook } from '../platform/clock.js';
import { Store } from '../store/database.js';
import { deliveryContent } from '../protocol/format.js';
export interface BindingState {
  id: string;
  proposal: TargetProposal;
  state: 'provisioning' | 'active' | 'provisioning-failed';
  authority: 'valid' | 'revoked' | 'expired';
  expiresAt: number;
  /** Delta-2: local standing binding — sentinel expiresAt, exempt from the
   *  cross-target overlap guard, lifetime bounded by revoke/GC instead of TTL. */
  standing?: boolean;
  admission: 'open' | 'sealed';
  revision: number;
  preparedDigest: string;
  handleFile: string;
  scopeRevision: number;
  membershipRevision?: number;
}
export interface Attempt {
  deliveryId: string;
  bindingId: string;
  eventId: string;
  payloadDigest: string;
  targetFingerprint: string;
  attachmentId: string;
  ownerEpoch: number;
  revision: number;
  foregroundEpoch: number;
  scopeRevision: number;
  grantId: string;
  intentAt: number;
  invokedAt?: number;
  abortedAt?: number;
}
interface Grant {
  id: string;
  request: GrantRequest;
  revision: number;
  attachmentId: string;
  foregroundEpoch: number;
  scopeRevision: number;
  expiresAt: number;
}
interface EventRow {
  binding: string;
  id: string;
  digest: string;
  packet_digest: string;
  packet: string;
  seq: number;
  accepted_at: number;
  deadline: number;
  model: string;
  bytes: number;
  presentation: EventReceipt['presentation']['state'];
}
interface AttemptRow {
  id: string;
  binding: string;
  event: string;
  body: string;
  status: string;
  unblocked: number;
}
export interface Eligibility {
  idle: boolean;
  pending: boolean;
  knownWait: boolean;
  strictNoAutoResume: boolean;
}
export interface ControlReceipt {
  bindingId: string;
  revision: number;
  controlCut: number;
  prevented: string[];
  tooLate: string[];
  unknown: string[];
}
export interface TargetOptions {
  home: string;
  realm: string;
  fingerprint: string;
  clock?: Clock;
  fault?: FaultHook;
  onChange?: () => void;
  onProgress?: (bindingId: string, value: Progress) => void;
  /** Pre-acquired owner lock (createTarget takes over from earlier holders). */
  lock?: OwnerLock;
  /** Invoked when a newer session takes over ownership of this store. */
  onSuperseded?: () => void;
}
export class TargetCore {
  readonly store: Store;
  readonly attachmentId = newId('att');
  readonly clock: Clock;
  readonly options: TargetOptions;
  foregroundEpoch = 0;
  ready = true;
  private readonly registries = new Map<string, Registry>();
  private readonly progress = new Map<string, Map<string, { value: Progress; hash: string; at: number }>>();
  constructor(options: TargetOptions) {
    this.options = options;
    this.clock = options.clock ?? wallClock;
    this.store = new Store(
      join(privateDir(options.home), 'targets', options.fingerprint),
      'target',
      options.fingerprint,
      options.realm,
      options.lock,
    );
    try {
      this.store.tx(() => {
        this.store.run('UPDATE grants SET active=0');
        this.store.run(
          "UPDATE attempts SET status='unknown' WHERE status IN ('dispatch-intent','submitted','recorded')",
        );
        for (const binding of this.list()) {
          this.addHold(binding.id, 'recovery');
          this.registry(binding);
        }
      });
    } catch (error) {
      this.store.close();
      throw error;
    }
  }
  private changed(): void {
    try {
      this.options.onChange?.();
    } catch {
      /* presentation errors cannot undo admission */
    }
  }
  private registry(binding: BindingState): Registry {
    let registry = this.registries.get(binding.id);
    if (!registry) {
      registry = new Registry();
      registry.register(binding.proposal.types);
      this.registries.set(binding.id, registry);
    }
    return registry;
  }
  list(): BindingState[] {
    return this.store
      .all<{ body: string }>('SELECT body FROM bindings')
      .map((row) => JSON.parse(row.body) as BindingState);
  }
  binding(id: string): BindingState {
    const row = this.store.get<{ body: string }>('SELECT body FROM bindings WHERE id=?', id);
    invariant(row, 'not_found');
    return JSON.parse(row.body) as BindingState;
  }
  private save(binding: BindingState): void {
    this.store.run(
      'UPDATE bindings SET body=?,live=? WHERE id=?',
      canonical(binding),
      binding.authority === 'valid' ? 1 : 0,
      binding.id,
    );
  }
  usable(binding: BindingState): void {
    invariant(this.ready, 'attachment_stale');
    if (binding.authority === 'revoked') fail('binding_revoked');
    if (binding.authority === 'expired' || binding.expiresAt <= this.clock.now()) fail('binding_expired');
  }
  holds(id: string): string[] {
    return this.store
      .all<{ reason: string }>('SELECT reason FROM holds WHERE binding=? ORDER BY reason', id)
      .map((x) => x.reason);
  }
  addHold(id: string, reason: string): void {
    this.store.run('INSERT OR IGNORE INTO holds VALUES(?,?)', id, reason);
  }
  holdAll(reason: string): void {
    this.store.tx(() => {
      for (const b of this.list()) this.addHold(b.id, reason);
    });
    this.changed();
  }
  foregroundInput(): void {
    this.foregroundEpoch++;
    this.store.tx(() => {
      this.store.run(
        "UPDATE grants SET active=0 WHERE json_extract(body,'$.request.sessionScoped') IS NOT 1",
      );
      for (const b of this.list())
        if (b.proposal.affinity === 'branch') this.addHold(b.id, 'foreground-changed');
    });
    this.changed();
  }
  markProvisioningFailed(id: string, reason: string): void {
    this.store.tx(() => {
      const b = this.binding(id);
      if (b.state !== 'provisioning') return;
      b.state = 'provisioning-failed';
      this.save(b);
      this.store.run(
        'INSERT INTO receipts(binding,seq,event,kind,body,at) VALUES(?,?,?,?,?,?)',
        b.id,
        this.nextSeq(b.id),
        '',
        'provisioning-terminal',
        canonical({ state: 'provisioning-failed', reason }),
        this.clock.now(),
      );
    });
    this.changed();
  }
  private nextSeq(binding: string): number {
    const row = this.store.get<{ m: number }>(
      'SELECT max(seq) m FROM receipts WHERE binding=?',
      binding,
    );
    return (row?.m ?? 0) + 1;
  }
  handle(id: string): BindingHandle {
    return validate('BindingHandle', privateJson(this.binding(id).handleFile));
  }
  prepare(input: TargetProposal): PreparedBinding {
    const proposal = validate('TargetProposal', input);
    invariant(
      proposal.targetFingerprint === this.options.fingerprint && proposal.realm === this.options.realm,
      'unauthorized',
    );
    // Delta-2: standing proposals carry the sentinel expiry (no binding TTL);
    // the 30-day horizon stays binding for every invite-based proposal.
    invariant(
      proposal.expiresAt > this.clock.now() &&
        (input.standing === true || proposal.expiresAt <= this.clock.now() + 2592000000),
    );
    const registry = new Registry();
    registry.register(proposal.types);
    for (const [type, rule] of Object.entries(proposal.policy)) {
      invariant(
        proposal.types.some((t) => t.type === type),
        'unknown_type',
      );
      if (proposal.types.find((t) => t.type === type)?.kind === 'progress')
        invariant(rule.model === 'display');
    }
    const requestDigest = digest(proposal),
      prior = this.store.operation<{ bindingId: string }>(proposal.operationId, requestDigest);
    if (prior) {
      const b = this.binding(prior.bindingId);
      this.usable(b);
      return {
        bindingId: b.id,
        proposal: b.proposal,
        handle: this.handle(b.id),
        preparedDigest: b.preparedDigest,
      };
    }
    invariant(this.list().length < 128, 'backpressure');
    // Delta-2: standing proposals are exempt from the any-target overlap scan
    // (multi-session standing bindings share one localTrust channel); the
    // invite scan ignores standing bindings so the two paths never block
    // each other. The (source, channel, target) uniqueness below still holds.
    if (!input.standing)
      invariant(
        !this.list().some(
          (b) =>
            !b.standing &&
            b.authority === 'valid' &&
            b.expiresAt > this.clock.now() &&
            b.proposal.sourceId === proposal.sourceId &&
            b.proposal.channelId === proposal.channelId,
        ),
        'binding_overlap',
      );
    const id = newId('bnd'),
      dir = privateDir(join(this.store.dir, 'bindings', id));
    const spool = privateDir(join(dir, 'spool'));
    for (const name of ['pending', 'processed', 'quarantine']) privateDir(join(spool, name));
    const keyDir = privateDir(join(this.store.dir, 'keys')),
      keyId = newId('key'),
      keyFile = join(keyDir, keyId + '.json');
    const handle: BindingHandle = {
      version: 1,
      kind: 'binding',
      bindingId: id,
      sourceId: proposal.sourceId,
      channelId: proposal.channelId,
      targetFingerprint: proposal.targetFingerprint,
      realm: proposal.realm,
      discoveryFile: join(this.store.dir, 'attachment.json'),
      spoolDir: spool,
      credential: secret(),
      proofKeyId: keyId,
      proofKey: secret(),
      expiresAt: proposal.expiresAt,
    };
    const preparedDigest = digest({ bindingId: id, proposal, handle });
    const binding: BindingState = {
      id,
      proposal,
      expiresAt: proposal.expiresAt,
      ...(input.standing === true ? { standing: true as const } : {}),
      state: 'provisioning',
      authority: 'valid',
      admission: 'open',
      revision: 1,
      preparedDigest,
      handleFile: join(dir, 'handle.json'),
      scopeRevision: 0,
    };
    installPrivate(keyFile, { key: handle.proofKey });
    installPrivate(binding.handleFile, handle);
    this.store.tx(() => {
      for (const old of this.list())
        if (old.authority === 'valid' && old.expiresAt <= this.clock.now()) {
          old.authority = 'expired';
          this.save(old);
        }
      invariant(
        !this.store.get(
          'SELECT id FROM bindings WHERE source=? AND channel=? AND target=? AND live=1',
          proposal.sourceId,
          proposal.channelId,
          proposal.targetFingerprint,
        ),
        'binding_overlap',
      );
      invariant(this.list().length < 128, 'backpressure');
      this.store.run(
        'INSERT INTO bindings VALUES(?,?,?,?,?,?)',
        id,
        proposal.sourceId,
        proposal.channelId,
        proposal.targetFingerprint,
        1,
        canonical(binding),
      );
      this.store.run(
        'INSERT INTO credentials VALUES(?,?,?,?)',
        keyId,
        id,
        sha256(handle.credential),
        keyFile,
      );
      this.store.saveOperation(proposal.operationId, requestDigest, { bindingId: id });
    });
    this.options.fault?.('target.after_prepare_commit');
    this.registries.set(id, registry);
    return { bindingId: id, proposal, handle, preparedDigest };
  }
  finalize(input: MembershipProof): BindingState {
    const membership = validate('MembershipProof', input),
      b = this.binding(membership.bindingId);
    this.usable(b);
    const h = this.handle(b.id);
    invariant(
      membership.sourceId === b.proposal.sourceId &&
        membership.channelId === b.proposal.channelId &&
        membership.targetFingerprint === this.options.fingerprint &&
        membership.preparedDigest === b.preparedDigest &&
        membership.operationId === b.proposal.operationId &&
        membership.expiresAt === b.proposal.expiresAt,
      'unauthorized',
    );
    invariant(
      equalSecret(membership.proof, proof('pi-relay/membership/v1', withoutProof(membership), h.proofKey)),
      'unauthorized',
    );
    this.options.fault?.('target.before_finalize_commit');
    this.store.tx(() => {
      b.state = 'active';
      b.membershipRevision = membership.membershipRevision;
      this.save(b);
    });
    this.changed();
    return b;
  }
  authenticate(id: string, token: string): BindingState {
    const credential = this.store.get<{ token_digest: string }>(
      'SELECT token_digest FROM credentials WHERE binding=? ORDER BY rowid DESC LIMIT 1',
      id,
    );
    invariant(credential && authenticate(token, credential.token_digest), 'unauthorized');
    const b = this.binding(id);
    this.usable(b);
    return b;
  }
  fence(id: string, revision: number, attachmentId: string): BindingState {
    const b = this.binding(id);
    this.usable(b);
    invariant(attachmentId === this.attachmentId, 'attachment_stale');
    invariant(revision === b.revision, 'stale_binding_revision');
    return b;
  }
  append(id: string, event: string, kind: string, body: unknown, control = false): number {
    const seq =
      (this.store.get<{ n: number }>('SELECT coalesce(max(seq),0) n FROM receipts WHERE binding=?', id)?.n ??
        0) + 1;
    // Owner controls (revoke, disarm, ...) must stay possible on a full binding.
    invariant(control || seq <= LIMITS.receiptsPerBinding, 'backpressure');
    this.store.run(
      'INSERT INTO receipts VALUES(?,?,?,?,?,?)',
      id,
      seq,
      event,
      kind,
      canonical(body),
      this.clock.now(),
    );
    return seq;
  }
  admit(input: RoutePacket): AdmissionResult {
    const packet = validate('RoutePacket', input),
      b = this.binding(packet.bindingId);
    this.usable(b);
    invariant(b.state === 'active', 'subscription_provisioning');
    invariant(
      packet.sourceId === b.proposal.sourceId &&
        packet.channelId === b.proposal.channelId &&
        packet.membershipRevision === b.membershipRevision,
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
      equalSecret(packet.proof, proof('pi-relay/route-packet/v1', withoutProof(packet), material.key)),
      'unauthorized',
    );
    this.registry(b).check(packet.event);
    invariant(packet.sourceEventDigest === digest(packet.event), 'id_conflict');
    invariant(
      packet.routeValidUntil <= b.expiresAt &&
        packet.routeValidUntil <= deadline(packet.event.validUntil, packet.routeCreatedAt + 3600000) &&
        packet.routeCreatedAt <= this.clock.now() + 30000,
      'invalid_payload',
    );
    const result = this.store.tx((): AdmissionResult => {
      const old = this.event(b.id, packet.event.id);
      if (old) {
        invariant(old.digest === packet.sourceEventDigest, 'id_conflict');
        return {
          outcome: 'accepted',
          eventId: old.id,
          acceptedAt: old.accepted_at,
          bindingAdmissionSeq: old.seq,
          duplicate: true,
          receiptCursor: this.cursor(b.id),
        };
      }
      invariant(b.admission === 'open', 'binding_sealed');
      invariant(packet.routeValidUntil > this.clock.now(), 'binding_expired');
      invariant(b.proposal.policy[packet.event.type], 'unauthorized');
      const pending = this.store.get<{ n: number }>(
        "SELECT count(*) n FROM events e WHERE deadline>? AND model='resume' AND NOT EXISTS(SELECT 1 FROM attempts a WHERE a.binding=e.binding AND a.event=e.id)",
        this.clock.now(),
      )!.n;
      const perBinding = this.store.get<{ n: number }>(
        "SELECT count(*) n FROM events e WHERE binding=? AND deadline>? AND model='resume' AND NOT EXISTS(SELECT 1 FROM attempts a WHERE a.binding=e.binding AND a.event=e.id)",
        b.id,
        this.clock.now(),
      )!.n;
      const total = this.store.get<{ n: number; bytes: number }>(
        'SELECT count(*) n,coalesce(sum(bytes),0) bytes FROM events',
      )!;
      const bytes = Buffer.byteLength(canonical(packet));
      invariant(
        pending < LIMITS.pendingPerTarget &&
          perBinding < LIMITS.pendingPerBinding &&
          total.n < LIMITS.retainedEvents &&
          total.bytes + bytes <= LIMITS.journalBytes,
        'backpressure',
      );
      const seq =
          (this.store.get<{ n: number }>('SELECT coalesce(max(seq),0) n FROM events WHERE binding=?', b.id)
            ?.n ?? 0) + 1,
        at = this.clock.now();
      const model =
        packet.allowedModelModes.includes('resume') &&
        !!packet.sourceWakeReservationId &&
        b.proposal.policy[packet.event.type].model === 'resume'
          ? 'resume'
          : 'display';
      this.store.run(
        'INSERT INTO events(binding,id,digest,packet_digest,packet,seq,accepted_at,deadline,model,bytes) VALUES(?,?,?,?,?,?,?,?,?,?)',
        b.id,
        packet.event.id,
        packet.sourceEventDigest,
        digest(packet),
        canonical(packet),
        seq,
        at,
        packet.routeValidUntil,
        model,
        bytes,
      );
      const cursor = this.append(b.id, packet.event.id, 'accepted', { at, model });
      return {
        outcome: 'accepted',
        eventId: packet.event.id,
        acceptedAt: at,
        bindingAdmissionSeq: seq,
        duplicate: false,
        receiptCursor: cursor,
      };
    });
    this.options.fault?.('target.after_admission_commit_before_response');
    this.changed();
    return result;
  }
  admitProgress(id: string, value: Progress): AdmissionResult {
    const b = this.binding(id);
    this.usable(b);
    invariant(b.state === 'active', 'subscription_provisioning');
    invariant(b.admission === 'open', 'binding_sealed');
    this.registry(b).check(value);
    invariant(b.proposal.policy[value.type], 'unauthorized');
    let streams = this.progress.get(id);
    if (!streams) {
      streams = new Map();
      this.progress.set(id, streams);
    }
    const old = streams.get(value.streamId),
      hash = digest(value);
    if (old && value.revision < old.value.revision) return { outcome: 'dropped', reason: 'superseded' };
    if (old && value.revision === old.value.revision) {
      invariant(old.hash === hash, 'id_conflict');
      return { outcome: 'buffered', streamId: value.streamId, revision: value.revision, durability: 'none' };
    }
    invariant(old || streams.size < LIMITS.streamsPerBinding, 'backpressure');
    streams.set(value.streamId, { value, hash, at: this.clock.now() });
    try {
      this.options.onProgress?.(id, value);
    } catch {}
    return { outcome: 'buffered', streamId: value.streamId, revision: value.revision, durability: 'none' };
  }
  progressSnapshot(id: string): { value: Progress; at: number }[] {
    return [...(this.progress.get(id)?.values() ?? [])].map(({ value, at }) => ({ value, at }));
  }
  event(id: string, event: string): EventRow | undefined {
    return this.store.get<EventRow>('SELECT * FROM events WHERE binding=? AND id=?', id, event);
  }
  packet(id: string, event: string): RoutePacket {
    const row = this.event(id, event);
    invariant(row, 'not_found');
    return JSON.parse(row.packet) as RoutePacket;
  }
  cursor(id: string): number {
    return this.store.get<{ n: number }>('SELECT coalesce(max(seq),0) n FROM receipts WHERE binding=?', id)!
      .n;
  }
  receipt(id: string, event: string): EventReceipt {
    const b = this.binding(id),
      e = this.event(id, event);
    invariant(e, 'not_found');
    const a = this.store.get<AttemptRow>('SELECT * FROM attempts WHERE binding=? AND event=?', id, event);
    let disposition: EventReceipt['delivery']['disposition'] =
      e.model === 'display' ? 'not-requested' : 'pending';
    if (this.holds(id).length && disposition === 'pending') disposition = 'held';
    if (e.deadline <= this.clock.now()) disposition = 'expired';
    if (b.authority === 'revoked') disposition = 'suppressed';
    if (a)
      disposition =
        a.status === 'aborted-before-invoke'
          ? 'suppressed'
          : (a.status as EventReceipt['delivery']['disposition']);
    const delivery: EventReceipt['delivery'] = { disposition, holdReasons: this.holds(id) };
    if (a) {
      const attempt = JSON.parse(a.body) as Attempt;
      delivery.deliveryId = a.id;
      if (attempt.invokedAt !== undefined) delivery.submittedAt = attempt.invokedAt;
      const observation = this.store.get<{ body: string }>(
        "SELECT body FROM observations WHERE delivery=? ORDER BY CASE evidence WHEN 'file-entry' THEN 0 ELSE 1 END LIMIT 1",
        a.id,
      );
      if (observation) delivery.observation = JSON.parse(observation.body) as Observation;
      if (b.authority === 'revoked') delivery.controlAfterSubmission = 'revoked';
      else if (e.deadline <= this.clock.now()) delivery.controlAfterSubmission = 'expired';
      else if (this.holds(id).length) delivery.controlAfterSubmission = 'paused';
    }
    return {
      bindingId: id,
      sourceId: b.proposal.sourceId,
      channelId: b.proposal.channelId,
      eventId: event,
      acceptedAt: e.accepted_at,
      payloadDigest: e.digest,
      effectiveValidUntil: e.deadline,
      delivery,
      presentation: { state: e.presentation },
      cursor: this.cursor(id),
    };
  }
  receipts(id: string, after: number, limit = 128): { cursor: number; updates: unknown[] } {
    this.binding(id);
    invariant(Number.isSafeInteger(after) && after >= 0 && limit > 0 && limit <= 128);
    const cursor = this.cursor(id),
      min = this.store.get<{ n: number }>(
        'SELECT coalesce(min(seq),1) n FROM receipts WHERE binding=?',
        id,
      )!.n;
    invariant(after <= cursor && after >= min - 1, 'cursor_expired');
    const rows = this.store.all<{ seq: number; event: string; kind: string; body: string; at: number }>(
      'SELECT * FROM receipts WHERE binding=? AND seq>? ORDER BY seq LIMIT ?',
      id,
      after,
      limit,
    );
    return {
      cursor: rows.at(-1)?.seq ?? after,
      updates: rows.map((r) => ({
        cursor: r.seq,
        eventId: r.event,
        kind: r.kind,
        at: r.at,
        fact: JSON.parse(r.body),
      })),
    };
  }
  control(id: string, input: OwnerCommand): ControlReceipt {
    const command = validate('OwnerCommand', input),
      requestDigest = digest({ id, command });
    const prior = this.store.operation<ControlReceipt>(command.operationId, requestDigest);
    if (prior) return prior;
    const result = this.store.tx(() => {
      const b = this.binding(id);
      invariant(b.revision === command.expectedRevision, 'stale_binding_revision');
      if (command.action !== 'resolve-unknown') this.usable(b);
      const attempts = this.store.all<AttemptRow>('SELECT * FROM attempts WHERE binding=?', id);
      const tooLate = attempts
          .filter((a) => ['submitted', 'recorded'].includes(a.status))
          .map((a) => a.event),
        unknown = attempts
          .filter((a) => ['dispatch-intent', 'unknown'].includes(a.status))
          .map((a) => a.event);
      const prevented = this.store
        .all<{ id: string }>(
          'SELECT id FROM events e WHERE binding=? AND NOT EXISTS(SELECT 1 FROM attempts a WHERE a.binding=e.binding AND a.event=e.id)',
          id,
        )
        .map((e) => e.id);
      b.revision++;
      switch (command.action) {
        case 'pause':
          this.addHold(id, 'manual');
          break;
        case 'resume': {
          const reason = command.holdReason ?? 'manual';
          if (reason === 'navigation') {
            invariant(command.approveCurrentBranch, 'unauthorized');
            b.scopeRevision++;
          }
          this.store.run('DELETE FROM holds WHERE binding=? AND reason=?', id, reason);
          break;
        }
        case 'arm': {
          invariant(command.grant && command.grant.eventTypes.length > 0);
          for (const type of command.grant.eventTypes)
            invariant(b.proposal.policy[type]?.model === 'resume', 'unauthorized');
          const grant: Grant = {
            id: newId('grant'),
            request: command.grant,
            revision: b.revision,
            attachmentId: this.attachmentId,
            foregroundEpoch: this.foregroundEpoch,
            scopeRevision: b.scopeRevision,
            // Delta-2: standing grants never expire — budget is the eligibility
            // gates + fencing + managed guard, not a claim cap or TTL window.
            expiresAt: command.grant.standing ? STANDING_EXPIRES_AT : Math.min(this.clock.now() + command.grant.ttlMs, b.expiresAt),
          };
          this.store.run('UPDATE grants SET active=0 WHERE binding=?', id);
          this.store.run('INSERT INTO grants(id,binding,body) VALUES(?,?,?)', grant.id, id, canonical(grant));
          break;
        }
        case 'disarm':
          this.store.run('UPDATE grants SET active=0 WHERE binding=?', id);
          break;
        case 'seal':
          b.admission = 'sealed';
          break;
        case 'revoke':
          b.authority = 'revoked';
          this.store.run('UPDATE grants SET active=0 WHERE binding=?', id);
          break;
        case 'renew':
          invariant(
            command.expiresAt &&
              command.expiresAt > this.clock.now() &&
              command.expiresAt <= this.clock.now() + 2592000000,
          );
          b.expiresAt = command.expiresAt;
          break;
        case 'resolve-unknown': {
          invariant(command.resolution === 'skip-replay-and-unblock' && command.deliveryId);
          const a = attempts.find((a) => a.id === command.deliveryId);
          invariant(a?.status === 'unknown', 'invalid_state');
          this.store.run('UPDATE attempts SET unblocked=1 WHERE id=?', a.id);
          break;
        }
        case 'rotate-credential': {
          const handle = this.handle(id);
          handle.credential = secret();
          replaceDiscovery(b.handleFile, handle);
          this.store.run(
            'UPDATE credentials SET token_digest=? WHERE binding=?',
            sha256(handle.credential),
            id,
          );
          break;
        }
      }
      this.save(b);
      const cut = this.append(id, 'control', command.action, {
        revision: b.revision,
        operationId: command.operationId,
      }, true);
      const receipt = { bindingId: id, revision: b.revision, controlCut: cut, prevented, tooLate, unknown };
      this.store.saveOperation(command.operationId, requestDigest, receipt);
      return receipt;
    });
    this.changed();
    return result;
  }
  claimOne(eligibility: Eligibility): Attempt | undefined {
    if (
      !this.ready ||
      !eligibility.idle ||
      eligibility.pending ||
      eligibility.knownWait ||
      eligibility.strictNoAutoResume
    )
      return;
    const claim = this.store.tx(() => {
      if (
        this.store.get(
          "SELECT id FROM attempts WHERE unblocked=0 AND status IN ('dispatch-intent','submitted','unknown') LIMIT 1",
        )
      )
        return;
      const candidates = this.store.all<EventRow>(
        "SELECT * FROM events e WHERE model='resume' AND deadline>? AND NOT EXISTS(SELECT 1 FROM attempts a WHERE a.binding=e.binding AND a.event=e.id) ORDER BY accepted_at,seq",
        this.clock.now(),
      );
      for (const e of candidates) {
        const b = this.binding(e.binding);
        if (
          b.state !== 'active' ||
          b.authority !== 'valid' ||
          b.expiresAt <= this.clock.now() ||
          this.holds(b.id).length ||
          b.proposal.policy[this.packet(b.id, e.id).event.type]?.model !== 'resume'
        )
          continue;
        const row = this.store.get<{ body: string; consumed: number }>(
          'SELECT * FROM grants WHERE binding=? AND active=1',
          b.id,
        );
        if (!row) continue;
        const grant = JSON.parse(row.body) as Grant;
        if (
          grant.revision !== b.revision ||
          grant.attachmentId !== this.attachmentId ||
          grant.scopeRevision !== b.scopeRevision ||
          (!grant.request.standing && grant.expiresAt <= this.clock.now()) ||
          (!grant.request.standing && row.consumed >= grant.request.maxClaims) ||
          (!grant.request.sessionScoped && grant.foregroundEpoch !== this.foregroundEpoch) ||
          !grant.request.eventTypes.includes(this.packet(b.id, e.id).event.type)
        )
          continue;
        const attempt: Attempt = {
          deliveryId: newId('del'),
          bindingId: b.id,
          eventId: e.id,
          payloadDigest: e.digest,
          targetFingerprint: this.options.fingerprint,
          attachmentId: this.attachmentId,
          ownerEpoch: this.store.epoch,
          revision: b.revision,
          foregroundEpoch: this.foregroundEpoch,
          scopeRevision: b.scopeRevision,
          grantId: grant.id,
          intentAt: this.clock.now(),
        };
        this.store.run('UPDATE grants SET consumed=consumed+1 WHERE id=?', grant.id);
        this.store.run(
          "INSERT INTO attempts(id,binding,event,body,status) VALUES(?,?,?,?,'dispatch-intent')",
          attempt.deliveryId,
          b.id,
          e.id,
          canonical(attempt),
        );
        this.append(b.id, e.id, 'dispatch-intent', { deliveryId: attempt.deliveryId });
        return attempt;
      }
    });
    if (claim) this.options.fault?.('target.after_intent_commit');
    return claim;
  }
  canInvoke(a: Attempt, eligibility: Eligibility): boolean {
    const b = this.binding(a.bindingId),
      e = this.event(a.bindingId, a.eventId)!;
    const row = this.store.get<{ body: string; active: number; consumed: number }>(
      'SELECT * FROM grants WHERE id=?',
      a.grantId,
    );
    if (!row || !row.active) return false;
    const grant = JSON.parse(row.body) as Grant;
    if (grant.expiresAt <= this.clock.now() || row.consumed > grant.request.maxClaims) return false;
    return (
      this.ready &&
      eligibility.idle &&
      !eligibility.pending &&
      !eligibility.knownWait &&
      !eligibility.strictNoAutoResume &&
      a.attachmentId === this.attachmentId &&
      a.ownerEpoch === this.store.epoch &&
      a.revision === b.revision &&
      a.foregroundEpoch === this.foregroundEpoch &&
      b.authority === 'valid' &&
      b.expiresAt > this.clock.now() &&
      e.deadline > this.clock.now() &&
      this.holds(b.id).length === 0
    );
  }
  abortedBeforeInvoke(a: Attempt): void {
    this.store.tx(() => {
      a.abortedAt = this.clock.now();
      this.store.run(
        "UPDATE attempts SET status='aborted-before-invoke',body=? WHERE id=? AND status='dispatch-intent'",
        canonical(a),
        a.deliveryId,
      );
      this.append(a.bindingId, a.eventId, 'aborted-before-invoke', { deliveryId: a.deliveryId });
    });
  }
  invoked(a: Attempt): void {
    this.options.fault?.('pi.after_invoke_before_store_update');
    this.store.tx(() => {
      a.invokedAt = this.clock.now();
      this.store.run("UPDATE attempts SET status='submitted',body=? WHERE id=?", canonical(a), a.deliveryId);
      this.append(a.bindingId, a.eventId, 'submitted', { deliveryId: a.deliveryId, at: a.invokedAt });
    });
    this.changed();
  }
  unknown(a: Attempt): void {
    this.store.tx(() => {
      this.store.run("UPDATE attempts SET status='unknown' WHERE id=?", a.deliveryId);
      this.append(a.bindingId, a.eventId, 'unknown', { deliveryId: a.deliveryId });
    });
    this.changed();
  }
  observe(entry: unknown, evidence: 'runtime-entry' | 'file-entry'): boolean {
    if (!entry || typeof entry !== 'object') return false;
    const e = entry as {
      type?: string;
      id?: string;
      customType?: string;
      content?: unknown;
      details?: Partial<Attempt> & { namespace?: string; eventIds?: string[] };
    };
    if (
      e.type !== 'custom_message' ||
      e.customType !== 'pi-relay.delivery.v1' ||
      typeof e.id !== 'string' ||
      e.details?.namespace !== 'pi-relay/delivery/v1' ||
      e.details.targetFingerprint !== this.options.fingerprint ||
      !e.details.deliveryId
    )
      return false;
    const row = this.store.get<AttemptRow>('SELECT * FROM attempts WHERE id=?', e.details.deliveryId);
    if (!row) return false;
    const a = JSON.parse(row.body) as Attempt;
    if (
      e.details.bindingId !== a.bindingId ||
      e.details.eventId !== a.eventId ||
      e.details.payloadDigest !== a.payloadDigest ||
      !Array.isArray(e.details.eventIds) ||
      canonical(e.details.eventIds) !== canonical([a.eventId]) ||
      e.content !== deliveryContent(this.packet(a.bindingId, a.eventId), a.deliveryId)
    )
      return false;
    const observation: Observation = {
      evidence,
      entryKind: 'custom_message',
      entryId: e.id,
      observedAt: this.clock.now(),
    };
    const changed = this.store.tx(() => {
      const inserted = this.store.run(
        'INSERT OR IGNORE INTO observations VALUES(?,?,?,?)',
        a.deliveryId,
        evidence,
        e.id,
        canonical(observation),
      ).changes;
      if (evidence === 'file-entry' || a.ownerEpoch === this.store.epoch)
        this.store.run("UPDATE attempts SET status='recorded' WHERE id=?", a.deliveryId);
      if (inserted)
        this.append(a.bindingId, a.eventId, 'recorded', { deliveryId: a.deliveryId, ...observation });
      return (
        inserted > 0 ||
        (row.status !== 'recorded' && (evidence === 'file-entry' || a.ownerEpoch === this.store.epoch))
      );
    });
    if (changed && evidence === 'runtime-entry')
      this.options.fault?.('pi.after_runtime_entry_before_file_observation');
    if (changed) this.changed();
    return true;
  }
  markPresentation(id: string, event: string, state: EventReceipt['presentation']['state']): void {
    this.store.run('UPDATE events SET presentation=? WHERE binding=? AND id=?', state, id, event);
  }
  status(): unknown {
    return {
      targetFingerprint: this.options.fingerprint,
      attachmentId: this.attachmentId,
      ownerEpoch: this.store.epoch,
      bindings: this.list().map((b) => ({
        bindingId: b.id,
        sourceId: b.proposal.sourceId,
        channelId: b.proposal.channelId,
        state: b.state,
        authority: b.authority,
        admission: b.admission,
        revision: b.revision,
        expiresAt: b.expiresAt,
        ...(b.standing === true ? { standing: true as const } : {}),
        holds: this.holds(b.id),
        pending: this.store.get<{ n: number }>(
          'SELECT count(*) n FROM events e WHERE binding=? AND NOT EXISTS(SELECT 1 FROM attempts a WHERE a.binding=e.binding AND a.event=e.id)',
          b.id,
        )!.n,
        unknown: this.store.get<{ n: number }>(
          "SELECT count(*) n FROM attempts WHERE binding=? AND status='unknown' AND unblocked=0",
          b.id,
        )!.n,
        grants: this.store
          .all<{ body: string; consumed: number }>(
            'SELECT body,consumed FROM grants WHERE binding=? AND active=1',
            b.id,
          )
          .map((g) => ({
            expiresAt: (JSON.parse(g.body) as Grant).expiresAt,
            consumed: g.consumed,
            maxClaims: (JSON.parse(g.body) as Grant).request.maxClaims,
            standing: (JSON.parse(g.body) as Grant).request.standing === true ? true : undefined,
          })),
      })),
    };
  }
  close(): void {
    if (!this.ready) return;
    this.ready = false;
    this.progress.clear();
    this.store.close();
  }
}
