import { join, dirname, basename } from 'node:path';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import type {
  SourceConfig,
  SourceHandle,
  ChannelConfig,
  Invite,
  PreparedBinding,
  MembershipProof,
  RoutePacket,
  FanoutResult,
  FanoutRoute,
  Value,
  Event,
  Progress,
} from '../protocol/types.js';
import { authenticate, canonical, digest, newId, proof, secret, sha256 } from '../protocol/canonical.js';
import { deadline, LIMITS, Registry, validate } from '../protocol/validate.js';
import { invariant, fail, safeError, RelayError } from '../protocol/errors.js';
import { STANDING_EXPIRES_AT, STANDING_INVITE_ID } from '../protocol/constants.js';
import { readOwnerToken } from '../platform/owner-lock.js';
import { privateDir, privateJson } from '../platform/private-paths.js';
import { installPrivate } from '../platform/atomic-file.js';
import { wallClock, type Clock, type FaultHook } from '../platform/clock.js';
import { Store } from '../store/database.js';
import { BindingClient, openBinding } from '../client/index.js';
import { signPacket, stage } from '../staging/index.js';
interface Membership {
  bindingId: string;
  channelId: string;
  targetFingerprint: string;
  preparedDigest: string;
  operationId: string;
  capabilityRef: string;
  policy: PreparedBinding['proposal']['policy'];
  expiresAt: number;
  membershipRevision: number;
}
interface InviteRow {
  id: string;
  channel: string;
  token_digest: string;
  body: string;
  used_by: string | null;
}
interface RouteRow {
  fanout: string;
  binding: string;
  packet: string;
  disposition: string;
  reason: string | null;
}
interface EventRow {
  channel: string;
  id: string;
  digest: string;
  payload: string;
  fanout: string;
  cut: number;
  at: number;
  deadline: number;
  bytes: number;
}
export type SourcePrincipal =
  | { kind: 'owner' }
  | { kind: 'publisher'; channelId: string }
  | { kind: 'invite'; inviteId: string }
  | { kind: 'standing'; inviteId: string };
export interface SourceOptions {
  clock?: Clock;
  fault?: FaultHook;
}
/** Canonical source store location: <home>/sources/sha256(sourceId). */
function sourceStoreDir(home: string, sourceId: string): string {
  return join(privateDir(home), 'sources', sha256(sourceId));
}

/**
 * Same sourceId re-registered under different owner/publisher tokens. The wire
 * code stays the contract-stable `invalid_state`; the library-level class makes
 * the failure actionable (distinguishable, names the store, names the recovery).
 */
export class SourceAuthorityMismatch extends RelayError {
  constructor(
    readonly sourceId: string,
    readonly storeDir: string,
  ) {
    super('invalid_state');
    this.name = 'SourceAuthorityMismatch';
    this.message =
      `Source ${sourceId} is already owned under a different authority digest ` +
      `(store ${storeDir}). Re-registering with new tokens is a local recovery: ` +
      `run "pi-relay source reset --source <id> --home <home>" to quarantine the old ` +
      `store, then create the source again. Stop the process holding the old store first.`;
  }
}

export interface SourceResetResult {
  reset: boolean;
  sourceId: string;
  quarantined?: string;
}

/**
 * Local operator recovery for a source whose authority tokens were replaced
 * (root migration, secrets lost, an E2E run that used a production home). The
 * store is moved to <home>/sources/.quarantine/ — never deleted — so a mistaken
 * reset stays auditable. Requires filesystem access to the relay home private
 * dir, which is exactly the local-operator boundary the design grants.
 */
export function resetSource(sourceId: string, home: string): SourceResetResult {
  const dir = sourceStoreDir(home, sourceId);
  if (!existsSync(dir)) return { reset: false, sourceId };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const quarantineRoot = join(dirname(dir), '.quarantine');
  mkdirSync(quarantineRoot, { recursive: true });
  let target = join(quarantineRoot, `${basename(dir)}-${stamp}`);
  for (let n = 1; existsSync(target); n++) target = join(quarantineRoot, `${basename(dir)}-${stamp}-${n}`);
  renameSync(dir, target);
  return { reset: true, sourceId, quarantined: target };
}

export class SourceCore {
  readonly store: Store;
  readonly attachmentId = newId('source-att');
  readonly clock: Clock;
  readonly config: SourceConfig;
  private readonly registries = new Map<string, Registry>();
  private readonly progress = new Map<
    string,
    Map<string, { value: Progress; hash: string; dirty: boolean }>
  >();
  private readonly activeFanouts = new Map<string, Promise<FanoutResult>>();
  private closed = false;
  private routeRunning = 0;
  private readonly routeWaiters: (() => void)[] = [];
  constructor(
    configInput: SourceConfig,
    readonly options: SourceOptions = {},
  ) {
    this.config = validate('SourceConfig', configInput);
    this.clock = options.clock ?? wallClock;
    this.store = new Store(
      sourceStoreDir(this.config.home, this.config.sourceId),
      'source',
      this.config.sourceId,
      this.config.realm,
    );
    try {
      this.store.tx(() => {
        const authorityDigest = digest({
          owner: sha256(this.config.ownerToken),
          publishers: Object.fromEntries(
            Object.entries(this.config.publisherTokens).map(([k, v]) => [k, sha256(v)]),
          ),
        });
        const old = this.store.meta('authorityDigest');
        if (old !== undefined && old !== authorityDigest)
          throw new SourceAuthorityMismatch(this.config.sourceId, this.store.dir);
        this.store.setMeta('authorityDigest', authorityDigest);
        for (const channel of this.config.channels) {
          invariant(this.config.publisherTokens[channel.id], 'invalid_payload');
          const registry = new Registry();
          registry.register(channel.types);
          this.registries.set(channel.id, registry);
          const prior = this.store.get<{ body: string }>('SELECT body FROM channels WHERE id=?', channel.id);
          invariant(!prior || digest(JSON.parse(prior.body)) === digest(channel), 'invalid_state');
          this.store.run(
            'INSERT OR IGNORE INTO channels(id,body) VALUES(?,?)',
            channel.id,
            canonical(channel),
          );
        }
      });
    } catch (e) {
      this.store.close();
      throw e;
    }
  }
  get discoveryFile(): string {
    return join(this.store.dir, 'host.json');
  }
  ownerHandle(): SourceHandle {
    return {
      version: 1,
      kind: 'source',
      sourceId: this.config.sourceId,
      realm: this.config.realm,
      discoveryFile: this.discoveryFile,
      credential: this.config.ownerToken,
    };
  }
  publisherHandle(channelId: string): SourceHandle {
    this.channel(channelId);
    return { ...this.ownerHandle(), credential: this.config.publisherTokens[channelId], channelId };
  }
  channel(id: string): ChannelConfig {
    const row = this.store.get<{ body: string }>('SELECT body FROM channels WHERE id=?', id);
    invariant(row, 'unauthorized');
    return JSON.parse(row.body) as ChannelConfig;
  }
  private channelOpen(id: string): void {
    const row = this.store.get<{ closed: number; revoked: number }>(
      'SELECT closed,revoked FROM channels WHERE id=?',
      id,
    );
    invariant(row && !row.closed && !row.revoked, 'channel_closed');
  }
  authenticate(token: string, inviteId?: string): SourcePrincipal {
    invariant(!this.closed, 'source_unavailable');
    // Delta-2 local standing principal: the transport endpoint IS the identity —
    // the source socket lives inside the 0700 home, so a reachable connect is
    // already same-uid local trust. The inviteId literal 'local' names the
    // standing path; the channel-level localTrust opt-in and the enroll-time
    // credential/probe checks below are the remaining guard rails.
    if (inviteId === 'local') {
      invariant(this.config.channels.some((c) => c.localTrust === true), 'local_trust_disabled');
      return { kind: 'standing', inviteId };
    }
    if (inviteId) {
      const invite = this.store.get<InviteRow>('SELECT * FROM invites WHERE id=?', inviteId);
      invariant(invite && authenticate(token, invite.token_digest), 'unauthorized');
      const body = JSON.parse(invite.body) as Omit<Invite, 'credential'>;
      invariant(
        body.bindingExpiresAt > this.clock.now() && (invite.used_by || body.expiresAt > this.clock.now()),
        'unauthorized',
      );
      return { kind: 'invite', inviteId };
    }
    if (authenticate(token, sha256(this.config.ownerToken))) return { kind: 'owner' };
    for (const [channelId, credential] of Object.entries(this.config.publisherTokens))
      if (authenticate(token, sha256(credential))) return { kind: 'publisher', channelId };
    fail('unauthorized');
  }
  authorize(principal: SourcePrincipal, channel: string): void {
    invariant(
      principal.kind === 'owner' || (principal.kind === 'publisher' && principal.channelId === channel),
      'unauthorized',
    );
  }
  createInvite(request: {
    operationId: string;
    channelId: string;
    ttlMs: number;
    bindingTtlMs: number;
    allowResume: boolean;
  }): Invite {
    const requestDigest = digest(request),
      old = this.store.operation<{ id: string }>(request.operationId, requestDigest);
    if (old) return validate('Invite', privateJson(join(this.store.dir, 'capabilities', old.id + '.json')));
    this.channelOpen(request.channelId);
    const channel = this.channel(request.channelId);
    invariant(
      request.ttlMs > 0 &&
        request.ttlMs <= 86400000 &&
        request.bindingTtlMs > 0 &&
        request.bindingTtlMs <= 2592000000,
    );
    invariant(!request.allowResume || channel.allowedModes.includes('resume'), 'unauthorized');
    const invite: Invite = {
      version: 1,
      kind: 'invite',
      inviteId: newId('invite'),
      sourceId: this.config.sourceId,
      channelId: channel.id,
      realm: this.config.realm,
      discoveryFile: this.discoveryFile,
      credential: secret(),
      expiresAt: this.clock.now() + request.ttlMs,
      bindingExpiresAt: this.clock.now() + request.bindingTtlMs,
      types: channel.types,
      allowedModes: request.allowResume ? ['display', 'resume'] : ['display'],
    };
    const dir = privateDir(join(this.store.dir, 'capabilities'));
    installPrivate(join(dir, invite.inviteId + '.json'), invite);
    const { credential, ...body } = invite;
    this.store.tx(() => {
      invariant(this.store.get<{ n: number }>('SELECT count(*) n FROM invites')!.n < 10000, 'backpressure');
      this.store.run(
        'INSERT INTO invites(id,channel,token_digest,body) VALUES(?,?,?,?)',
        invite.inviteId,
        channel.id,
        sha256(credential),
        canonical(body),
      );
      this.store.saveOperation(request.operationId, requestDigest, { id: invite.inviteId });
    });
    return invite;
  }
  async enroll(inviteId: string, input: PreparedBinding): Promise<MembershipProof> {
    const prepared = validate('PreparedBinding', input),
      p = prepared.proposal,
      requestDigest = digest(prepared),
      op = 'enroll:' + p.operationId;
    const inviteRow = this.store.get<InviteRow>('SELECT * FROM invites WHERE id=?', inviteId);
    // Delta-2: a standing proposal carries no invite row. The channel-level
    // localTrust opt-in (written by the source owner) plus same-home realm
    // equality replace the single-use invite as the authorization anchor; the
    // probe below still proves the submitted target endpoint really holds the
    // prepared handle. Everything else is the shared membership path.
    const standing = !inviteRow && inviteId === STANDING_INVITE_ID && p.standing === true;
    let invite: Omit<Invite, 'credential'> | undefined;
    if (standing) {
      const channel = this.config.channels.find((c) => c.id === p.channelId);
      invariant(channel?.localTrust === true, 'local_trust_disabled');
      invariant(p.realm === this.config.realm, 'unauthorized');
      invariant(p.expiresAt === STANDING_EXPIRES_AT, 'unauthorized');
      invariant(digest(p.types) === digest(channel.types), 'unauthorized');
      for (const [type, rule] of Object.entries(p.policy))
        invariant(
          channel.types.some((t) => t.type === type) && channel.allowedModes.includes(rule.model),
          'unauthorized',
        );
    } else {
      invariant(inviteRow, 'unauthorized');
      invite = JSON.parse(inviteRow!.body) as Omit<Invite, 'credential'>;
      invariant(
        inviteId === p.inviteId &&
          p.sourceId === this.config.sourceId &&
          p.channelId === invite.channelId &&
          p.realm === this.config.realm &&
          p.expiresAt <= invite.bindingExpiresAt &&
          p.expiresAt > this.clock.now(),
        'unauthorized',
      );
    }
    invariant(
      prepared.preparedDigest ===
        digest({ bindingId: prepared.bindingId, proposal: p, handle: prepared.handle }),
      'id_conflict',
    );
    invariant(
      prepared.bindingId === prepared.handle.bindingId &&
        p.targetFingerprint === prepared.handle.targetFingerprint &&
        p.sourceId === prepared.handle.sourceId &&
        p.channelId === prepared.handle.channelId,
      'unauthorized',
    );
    if (!standing) invariant(digest(p.types) === digest(invite!.types), 'unauthorized');
    for (const [type, policy] of Object.entries(p.policy)) {
      if (standing) break; // already validated against the channel above
      invariant(
        invite!.types.some((t) => t.type === type) && invite!.allowedModes.includes(policy.model),
        'unauthorized',
      );
    }
    // A channel name or a self-asserted prepared object is not target proof: authenticate the exact target endpoint.
    const probe = await openBinding(prepared.handle);
    try {
      invariant(probe.hello.preparedDigest === prepared.preparedDigest, 'unauthorized');
    } finally {
      probe.rpc.dispose();
    }
    const prior = this.store.operation<MembershipProof>(op, requestDigest);
    if (prior) {
      const membership = this.store.get<{ state: string }>(
        'SELECT state FROM memberships WHERE binding=?',
        prepared.bindingId,
      );
      invariant(membership?.state === 'active', 'binding_revoked');
      return prior;
    }
    this.channelOpen(p.channelId);
    if (!standing) invariant(invite!.expiresAt > this.clock.now(), 'unauthorized');
    invariant(this.store.get<{ n: number }>('SELECT count(*) n FROM memberships')!.n < 10000, 'backpressure');
    const capDir = privateDir(join(this.store.dir, 'capabilities', 'routes')),
      capabilityRef = join(capDir, prepared.bindingId + '.json');
    installPrivate(capabilityRef, prepared.handle);
    const result = this.store.tx(() => {
      for (const row of this.store.all<{ binding: string; body: string }>(
        "SELECT binding,body FROM memberships WHERE state='active'",
      )) {
        if ((JSON.parse(row.body) as Membership).expiresAt <= this.clock.now())
          this.store.run("UPDATE memberships SET state='expired' WHERE binding=?", row.binding);
      }
      // Delta-2 pid-GC: a standing enroll also sweeps same-channel standing
      // memberships whose target store has no live owner (crashed session).
      // Keeps provisionAudience route sets fresh without any TTL churn.
      if (standing)
        for (const row of this.store.all<{ binding: string; body: string }>(
          "SELECT binding,body FROM memberships WHERE channel=? AND state='active'",
          p.channelId,
        )) {
          const m = JSON.parse(row.body) as Membership;
          if (m.expiresAt !== STANDING_EXPIRES_AT) continue;
          const token = readOwnerToken(join(this.config.home, 'targets', m.targetFingerprint));
          const alive = token
            ? (() => {
                try {
                  process.kill(token.pid, 0);
                  return true;
                } catch {
                  return false;
                }
              })()
            : false;
          if (!alive) this.store.run("UPDATE memberships SET state='expired' WHERE binding=?", row.binding);
        }
      invariant(
        !this.store.get(
          "SELECT binding FROM memberships WHERE channel=? AND target=? AND state='active'",
          p.channelId,
          p.targetFingerprint,
        ),
        'binding_overlap',
      );
      invariant(
        this.store.get<{ n: number }>("SELECT count(*) n FROM memberships WHERE state='active'")!.n <
          LIMITS.bindingsPerSource,
        'backpressure',
      );
      const cut = Number(this.store.meta('membershipCut') ?? 0) + 1;
      this.store.setMeta('membershipCut', String(cut));
      const membership: Membership = {
        bindingId: prepared.bindingId,
        channelId: p.channelId,
        targetFingerprint: p.targetFingerprint,
        preparedDigest: prepared.preparedDigest,
        operationId: p.operationId,
        capabilityRef,
        policy: p.policy,
        expiresAt: p.expiresAt,
        membershipRevision: cut,
      };
      this.store.run(
        "INSERT INTO memberships(binding,channel,target,state,cut,last_seen,body) VALUES(?,?,?,'active',?,?,?)",
        prepared.bindingId,
        p.channelId,
        p.targetFingerprint,
        cut,
        this.clock.now(),
        canonical(membership),
      );
      // Single-use consumption must be transactional: a guarded update inside the
      // write transaction is the single point of truth, so two concurrent enrolls
      // (distinct operationIds and/or targets) can never both activate one invite.
      if (!standing) {
        const consumed = this.store.run(
          'UPDATE invites SET used_by=? WHERE id=? AND used_by IS NULL',
          prepared.bindingId,
          inviteId,
        );
        invariant(consumed.changes === 1, 'unauthorized');
      }
      const unsigned = {
        bindingId: prepared.bindingId,
        sourceId: this.config.sourceId,
        channelId: p.channelId,
        targetFingerprint: p.targetFingerprint,
        operationId: p.operationId,
        preparedDigest: prepared.preparedDigest,
        membershipRevision: cut,
        expiresAt: p.expiresAt,
      };
      const result: MembershipProof = {
        ...unsigned,
        proof: proof('pi-relay/membership/v1', unsigned, prepared.handle.proofKey),
      };
      this.store.saveOperation(op, requestDigest, result);
      return result;
    });
    this.options.fault?.('source.after_membership_commit');
    return result;
  }
  membership(id: string): Membership {
    const row = this.store.get<{ body: string }>('SELECT body FROM memberships WHERE binding=?', id);
    invariant(row, 'not_found');
    return JSON.parse(row.body) as Membership;
  }
  capture(channelId: string, event: Event, autoRequired = false): EventRow {
    this.registries.get(channelId)?.check(event);
    this.channel(channelId);
    const eventDigest = digest(event);
    const captured = this.store.tx(() => {
      const old = this.store.get<EventRow>(
        'SELECT * FROM source_events WHERE channel=? AND id=?',
        channelId,
        event.id,
      );
      if (old) {
        invariant(old.digest === eventDigest, 'id_conflict');
        return old;
      }
      this.channelOpen(channelId);
      const channel = this.channel(channelId),
        now = this.clock.now(),
        expires = Math.min(deadline(event.validUntil, now + 3600000), now + 3600000);
      invariant(expires > now, 'binding_expired');
      const memberships = this.store
        .all<{ body: string; cut: number; lastSeen: number | null }>(
          "SELECT body,cut,last_seen AS lastSeen FROM memberships WHERE channel=? AND state='active' ORDER BY cut,binding",
          channelId,
        )
        .map((r) => ({ ...JSON.parse(r.body), cut: r.cut, lastSeen: r.lastSeen }) as Membership & { cut: number; lastSeen: number | null })
        .filter((m) => m.expiresAt > now && m.policy[event.type]);
      const resume = memberships.filter(
        (m) => m.policy[event.type]?.model === 'resume' && channel.allowedModes.includes('resume'),
      );
      invariant(!autoRequired || resume.length <= channel.maxAutoTargets, 'backpressure');
      // Wake allocation (fix-wake-budget-v0.2.1 T02): presence recency first — the most
      // recently seen targets (enroll probe or successful dispatch contact) win the
      // limited reservations; never-contacted memberships sort last; age never confers
      // priority. Non-selected routes still freeze display-only exactly as before.
      const wake = new Set(
        [...resume]
          .sort(
            (a, b) =>
              (b.lastSeen ?? -Infinity) - (a.lastSeen ?? -Infinity) ||
              b.cut - a.cut ||
              (a.bindingId < b.bindingId ? -1 : 1),
          )
          .slice(0, channel.maxAutoTargets)
          .map((m) => m.bindingId),
      );
      const fanout = newId('fanout'),
        cut = Number(this.store.meta('membershipCut') ?? 0);
      const packets = memberships.map((m) => {
        const handle = validate('BindingHandle', privateJson(m.capabilityRef));
        return signPacket(
          {
            packetVersion: 1,
            bindingId: m.bindingId,
            sourceId: this.config.sourceId,
            channelId,
            event,
            sourceEventDigest: eventDigest,
            fanoutId: fanout,
            membershipRevision: m.membershipRevision,
            routeCreatedAt: now,
            routeValidUntil: Math.min(expires, m.expiresAt),
            policySnapshotId: digest(m.policy),
            allowedModelModes: wake.has(m.bindingId) ? ['display', 'resume'] : ['display'],
            ...(wake.has(m.bindingId) ? { sourceWakeReservationId: newId('reservation') } : {}),
            proofKeyId: handle.proofKeyId,
          },
          handle.proofKey,
        );
      });
      const bytes = Buffer.byteLength(canonical(event)),
        packetBytes = packets.reduce((n, p) => n + Buffer.byteLength(canonical(p)), 0);
      const current = this.store.get<{ bytes: number; n: number }>(
          'SELECT coalesce(sum(bytes),0) bytes,count(*) n FROM source_events',
        )!,
        routes = this.store.get<{ bytes: number }>('SELECT coalesce(sum(bytes),0) bytes FROM routes')!;
      invariant(
        current.bytes + routes.bytes + bytes + packetBytes <= LIMITS.journalBytes &&
          current.n < LIMITS.retainedEvents,
        'backpressure',
      );
      this.store.run(
        'INSERT INTO source_events VALUES(?,?,?,?,?,?,?,?,?)',
        channelId,
        event.id,
        eventDigest,
        canonical(event),
        fanout,
        cut,
        now,
        expires,
        bytes,
      );
      for (const p of packets) {
        this.store.run(
          "INSERT INTO routes(fanout,binding,packet,disposition,bytes) VALUES(?,?,?,'source-staged',?)",
          fanout,
          p.bindingId,
          canonical(p),
          Buffer.byteLength(canonical(p)),
        );
        if (p.sourceWakeReservationId)
          this.store.run(
            'INSERT INTO reservations VALUES(?,?,?,?,?)',
            p.sourceWakeReservationId,
            fanout,
            p.bindingId,
            1,
            now,
          );
      }
      this.store.run(
        'INSERT INTO source_receipts(channel,event,kind,body,at) VALUES(?,?,?,?,?)',
        channelId,
        event.id,
        'source-staged',
        canonical({ fanoutId: fanout, membershipRevision: cut, recipients: packets.length }),
        now,
      );
      return this.store.get<EventRow>('SELECT * FROM source_events WHERE fanout=?', fanout)!;
    });
    this.options.fault?.('source.after_capture_commit');
    return captured;
  }
  fanoutResult(channelId: string, eventId: string, detailed = true): FanoutResult {
    const event = this.store.get<EventRow>(
      'SELECT * FROM source_events WHERE channel=? AND id=?',
      channelId,
      eventId,
    );
    invariant(event, 'not_found');
    const routes = this.store
      .all<RouteRow>('SELECT * FROM routes WHERE fanout=? ORDER BY binding', event.fanout)
      .map((r) => ({
        routeId: digest({ fanout: event.fanout, binding: r.binding }),
        ...(detailed ? { bindingId: r.binding } : {}),
        admission: r.disposition as FanoutRoute['admission'],
        ...(r.reason ? { reason: r.reason } : {}),
      }));
    return {
      sourceState: routes.length ? 'source-staged' : 'empty-audience',
      eventId,
      fanoutId: event.fanout,
      membershipRevision: event.cut,
      routes,
    };
  }
  async dispatch(event: EventRow, detailed = true): Promise<FanoutResult> {
    const active = this.activeFanouts.get(event.fanout);
    if (active) {
      await active;
      return this.fanoutResult(event.channel, event.id, detailed);
    }
    const run = async () => {
      const rows = this.store.all<RouteRow>(
        "SELECT * FROM routes WHERE fanout=? AND disposition NOT IN ('accepted','rejected') ORDER BY binding",
        event.fanout,
      );
      await parallel(rows, LIMITS.fanoutConcurrency, (row) =>
        this.routeSlot(async () => {
          const m = this.membership(row.binding),
            state = this.store.get<{ state: string }>(
              'SELECT state FROM memberships WHERE binding=?',
              row.binding,
            )!.state;
          const packet = JSON.parse(row.packet) as RoutePacket;
          let disposition: FanoutRoute['admission'] = row.disposition as FanoutRoute['admission'],
            reason: string | null = null;
          let presenceConfirmed = false;
          if (state !== 'active') {
            disposition = 'rejected';
            reason = 'binding_revoked';
          } else if (packet.routeValidUntil <= this.clock.now()) {
            if (disposition === 'unknown') {
              reason = 'expired-with-unknown-admission';
            } else {
              disposition = 'rejected';
              reason = 'binding_expired';
            }
          } else {
            let client: BindingClient | undefined;
            try {
              const handle = validate('BindingHandle', privateJson(m.capabilityRef));
              stage(handle, packet, this.options.fault);
              this.options.fault?.('source.after_route_materialize');
              // Probe before send distinguishes an offline target from a possibly admitted request.
              let online: Awaited<ReturnType<typeof openBinding>> | undefined;
              try {
                online = await openBinding(handle);
              } catch (e) {
                if (
                  (e as NodeJS.ErrnoException).code === 'ENOENT' ||
                  (e instanceof Error &&
                    ['transport_unavailable', 'target_offline'].includes((e as { code?: string }).code ?? ''))
                ) {
                  disposition = 'staged';
                } else throw e;
              }
              if (online) {
                online.rpc.dispose();
                presenceConfirmed = true;
                client = new BindingClient(
                  handle,
                  (h, p) => stage(h, p, this.options.fault),
                  () => {
                    invariant(
                      this.store.get<{ state: string }>(
                        'SELECT state FROM memberships WHERE binding=?',
                        m.bindingId,
                      )?.state === 'active',
                      'binding_revoked',
                    );
                  },
                );
                const result = await client.publishPacket(packet);
                if (result.outcome === 'accepted') disposition = 'accepted';
                else if (result.outcome === 'admission-unknown') {
                  disposition = 'unknown';
                  reason = 'admission_unknown';
                } else if (result.outcome === 'rejected') {
                  disposition =
                    result.error.code === 'subscription_provisioning'
                      ? 'pending-registration'
                      : result.error.retryable
                        ? 'unknown'
                        : 'rejected';
                  reason = result.error.code;
                } else disposition = 'staged';
              }
            } catch (e) {
              const error = safeError(e);
              disposition = error.retryable ? 'unknown' : 'rejected';
              reason = error.code;
            } finally {
              client?.dispose();
            }
          }
          this.store.tx(() => {
            if (presenceConfirmed)
              this.store.run('UPDATE memberships SET last_seen=? WHERE binding=?', this.clock.now(), row.binding);
            this.store.run(
              'UPDATE routes SET disposition=?,reason=? WHERE fanout=? AND binding=?',
              disposition,
              reason,
              event.fanout,
              row.binding,
            );
            if (row.disposition !== disposition || row.reason !== reason)
              this.store.run(
                'INSERT INTO source_receipts(channel,event,kind,body,at) VALUES(?,?,?,?,?)',
                event.channel,
                event.id,
                'route-update',
                canonical({ bindingId: row.binding, disposition, reason }),
                this.clock.now(),
              );
          });
        }),
      );
      return this.fanoutResult(event.channel, event.id, true);
    };
    invariant(this.activeFanouts.size < 64, 'backpressure');
    const running = run();
    this.activeFanouts.set(event.fanout, running);
    try {
      await running;
      return this.fanoutResult(event.channel, event.id, detailed);
    } finally {
      this.activeFanouts.delete(event.fanout);
    }
  }
  private async routeSlot<T>(work: () => Promise<T>): Promise<T> {
    if (this.routeRunning >= LIMITS.fanoutConcurrency) {
      invariant(this.routeWaiters.length < 256, 'backpressure');
      await new Promise<void>((resolve) => this.routeWaiters.push(resolve));
    } else this.routeRunning++;
    try {
      return await work();
    } finally {
      const next = this.routeWaiters.shift();
      if (next) next();
      else this.routeRunning--;
    }
  }
  async publish(
    channelId: string,
    value: Value,
    autoRequired = false,
    detailed = true,
  ): Promise<FanoutResult> {
    validate('Value', value);
    this.channel(channelId);
    this.registries.get(channelId)!.check(value);
    if (value.kind === 'event') return this.dispatch(this.capture(channelId, value, autoRequired), detailed);
    this.channelOpen(channelId);
    let streams = this.progress.get(channelId);
    if (!streams) {
      streams = new Map();
      this.progress.set(channelId, streams);
    }
    const old = streams.get(value.streamId),
      hash = digest(value);
    if (old && value.revision < old.value.revision) return { sourceState: 'dropped', routes: [] };
    if (old && value.revision === old.value.revision) invariant(old.hash === hash, 'id_conflict');
    invariant(old || streams.size < LIMITS.streamsPerBinding, 'backpressure');
    streams.set(value.streamId, { value, hash, dirty: true });
    return { sourceState: 'buffered', routes: [] };
  }
  async flushProgress(): Promise<void> {
    for (const [channelId, streams] of this.progress) {
      for (const snapshot of streams.values()) {
        if (!snapshot.dirty) continue;
        snapshot.dirty = false;
        const members = this.store
          .all<{ body: string }>("SELECT body FROM memberships WHERE channel=? AND state='active'", channelId)
          .map((r) => JSON.parse(r.body) as Membership)
          .filter((m) => m.expiresAt > this.clock.now() && m.policy[snapshot.value.type]);
        await parallel(members, 4, async (m) => {
          let client: BindingClient | undefined;
          try {
            client = new BindingClient(validate('BindingHandle', privateJson(m.capabilityRef)));
            await client.publish(snapshot.value);
          } catch {
          } finally {
            client?.dispose();
          }
        });
      }
    }
  }
  async replay(channelId?: string): Promise<FanoutResult[]> {
    const events = this.store.all<EventRow>(
      'SELECT * FROM source_events' + (channelId ? ' WHERE channel=?' : '') + ' ORDER BY at',
      ...(channelId ? [channelId] : []),
    );
    const results: FanoutResult[] = [];
    for (const e of events) results.push(await this.dispatch(e));
    return results;
  }
  withdraw(bindingId: string, operationId: string, preparedDigest: string): void {
    const requestDigest = digest({ bindingId, preparedDigest });
    if (this.store.operation(operationId, requestDigest)) return;
    const m = this.membership(bindingId);
    invariant(m.preparedDigest === preparedDigest, 'unauthorized');
    this.store.tx(() => {
      this.store.run("UPDATE memberships SET state='revoked' WHERE binding=?", bindingId);
      this.store.setMeta('membershipCut', String(Number(this.store.meta('membershipCut') ?? 0) + 1));
      this.store.saveOperation(operationId, requestDigest, { revoked: true });
    });
  }
  get revision(): number {
    return Number(this.store.meta('controlRevision') ?? 1);
  }
  status(): unknown {
    return {
      sourceId: this.config.sourceId,
      realm: this.config.realm,
      ownerEpoch: this.store.epoch,
      revision: this.revision,
      channels: this.store.all<{ id: string; closed: number; revoked: number }>(
        'SELECT id,closed,revoked FROM channels',
      ),
      memberships: this.store.get('SELECT count(*) n FROM memberships'),
      events: this.store.get('SELECT count(*) n,coalesce(sum(bytes),0) bytes FROM source_events'),
      routes: this.store.all('SELECT disposition,count(*) n FROM routes GROUP BY disposition'),
      inflight: this.routeRunning,
      queued: this.routeWaiters.length,
    };
  }
  async control(
    channelId: string,
    operationId: string,
    action: 'close' | 'revoke' | 'replay',
    expectedRevision: number,
  ): Promise<unknown> {
    this.channel(channelId);
    const requestDigest = digest({ channelId, action, expectedRevision }),
      prior = this.store.operation<unknown>(operationId, requestDigest);
    if (prior) return prior;
    type Cut = { revision: number; members: { binding: string; body: string }[] };
    const existing = this.store.get<{ digest: string; body: string }>(
      'SELECT * FROM pending_controls WHERE id=?',
      operationId,
    );
    if (existing) invariant(existing.digest === requestDigest, 'id_conflict');
    const cut: Cut = existing
      ? (JSON.parse(existing.body) as Cut)
      : this.store.tx(() => {
          invariant(expectedRevision === this.revision, 'stale_binding_revision');
          const members =
            action === 'revoke'
              ? this.store.all<{ binding: string; body: string }>(
                  "SELECT binding,body FROM memberships WHERE channel=? AND state='active'",
                  channelId,
                )
              : [];
          if (action !== 'replay')
            this.store.run(
              'UPDATE channels SET closed=1,revoked=max(revoked,?) WHERE id=?',
              action === 'revoke' ? 1 : 0,
              channelId,
            );
          if (action === 'revoke')
            this.store.run("UPDATE memberships SET state='revoked' WHERE channel=?", channelId);
          const revision = this.revision + 1;
          this.store.setMeta('controlRevision', String(revision));
          const result = { revision, members };
          this.store.run(
            'INSERT INTO pending_controls VALUES(?,?,?)',
            operationId,
            requestDigest,
            canonical(result),
          );
          return result;
        });
    const routes: unknown[] = [];
    if (action === 'replay') routes.push(...(await this.replay(channelId)));
    if (action === 'revoke')
      await parallel(cut.members, 4, async (row) => {
        const m = JSON.parse(row.body) as Membership;
        let client: BindingClient | undefined;
        try {
          client = new BindingClient(validate('BindingHandle', privateJson(m.capabilityRef)));
          routes.push({
            bindingId: m.bindingId,
            result: await client.revoke('source-revoke-' + sha256(operationId + m.bindingId).slice(0, 32)),
          });
        } catch (e) {
          routes.push({ bindingId: m.bindingId, outcome: 'unknown', reason: safeError(e).code });
        } finally {
          client?.dispose();
        }
      });
    const result = { channelId, action, revision: cut.revision, routes };
    this.store.tx(() => {
      this.store.saveOperation(operationId, requestDigest, result);
      this.store.run('DELETE FROM pending_controls WHERE id=?', operationId);
    });
    return result;
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.activeFanouts.values()]);
    this.progress.clear();
    this.store.close();
  }
}
export async function parallel<T>(
  items: T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(items.length, concurrency) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        await work(item);
      }
    }),
  );
}
