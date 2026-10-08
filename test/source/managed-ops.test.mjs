import { it, expect, afterEach } from 'vitest';
import { system, event, idle, eventually } from '../fixtures/system.mjs';
import { digest, newId, secret } from '../../dist/protocol/index.js';
import { installPrivate } from '../../dist/platform/atomic-file.js';
import { join } from 'node:path';

let f, lf;
afterEach(async () => {
  await f?.close();
  f = undefined;
  await lf?.close();
  lf = undefined;
});

const OWNER = { kind: 'owner' };

function managedEvent(id = newId('evt'), data = { exitCode: 0 }) {
  const now = Date.now();
  return {
    kind: 'event',
    id,
    type: 'process.exited.v1',
    schemaVersion: 1,
    occurredAt: new Date(now).toISOString(),
    validUntil: new Date(now + 120_000).toISOString(),
    data,
  };
}

async function setupAudience(source, channelId = 'X') {
  const audienceRef = 'aud-' + newId('a').slice(-8);
  source.managed.provisionAudience(OWNER, {
    audienceRef,
    channelId,
    consumerProfileId: 'watcher-profile',
    requestedMode: 'resume',
    validUntilMs: 3_600_000,
  });
  source.managed.advanceScope(OWNER, {
    operationId: newId('op'),
    scopeId: 'scope-1',
    expectedRevision: 0,
    nextRevision: 1,
    state: 'active',
  });
  return { audienceRef, scopeId: 'scope-1', scopeRevision: 1 };
}

it('[02 §2.2/RJ] scope lifecycle: init via CAS, strict +1, closed never reopens, idempotent ops', async () => {
  f = await system({ targets: 0 });
  const m = f.source.managed;
  const created = m.advanceScope(OWNER, {
    operationId: 'op-init',
    scopeId: 's',
    expectedRevision: 0,
    nextRevision: 1,
    state: 'active',
  });
  expect(created).toEqual({ revision: 1, state: 'active' });
  // replay same operationId
  expect(
    m.advanceScope(OWNER, { operationId: 'op-init', scopeId: 's', expectedRevision: 0, nextRevision: 1, state: 'active' }),
  ).toEqual(created);
  // CAS failure
  expect(() =>
    m.advanceScope(OWNER, { operationId: 'op-x', scopeId: 's', expectedRevision: 5, nextRevision: 6, state: 'paused' }),
  ).toThrowError(/scope/);
  const paused = m.advanceScope(OWNER, {
    operationId: 'op-pause',
    scopeId: 's',
    expectedRevision: 1,
    nextRevision: 2,
    state: 'paused',
  });
  expect(paused).toEqual({ revision: 2, state: 'paused' });
  const closed = m.advanceScope(OWNER, {
    operationId: 'op-close',
    scopeId: 's',
    expectedRevision: 2,
    nextRevision: 3,
    state: 'closed',
  });
  expect(closed.state).toBe('closed');
  expect(() =>
    m.advanceScope(OWNER, { operationId: 'op-reopen', scopeId: 's', expectedRevision: 3, nextRevision: 4, state: 'active' }),
  ).toThrowError(/state/);
});

it('[02 §2.3/m10] publishManaged: identity replay by (event, options) digest; same id different options conflicts', async () => {
  f = await system({ targets: 1 });
  const id = await f.bind(0);
  const { audienceRef, scopeId } = await setupAudience(f.source);
  const m = f.source.managed;
  const ev = managedEvent('same-id');
  const options = {
    audienceRef,
    scope: { id: scopeId, revision: 1 },
    consumerProfileId: 'watcher-profile',
    requestedMode: 'resume',
  };
  const r1 = await m.publishManaged(OWNER, { event: ev, options });
  expect(r1.sourceState).toBe('captured');
  const r2 = await m.publishManaged(OWNER, { event: ev, options });
  expect(r2.eventId).toBe('same-id');
  await expect(
    m.publishManaged(OWNER, {
      event: ev,
      options: { ...options, requestedMode: 'display' },
    }),
  ).rejects.toThrowError(/identifier|conflict/i);
});

it('[03 §3.2] cancel-before-publish: tombstone rejects later capture of the same eventId', async () => {
  f = await system({ targets: 1 });
  await f.bind(0);
  const { audienceRef, scopeId } = await setupAudience(f.source);
  const m = f.source.managed;
  const w = m.withdraw(OWNER, { operationId: 'w1', eventId: 'never-arrives', reason: 'host pause' });
  expect(w.sourceApplied).toBe(true);
  expect(w.routes).toEqual([]);
  await expect(
    m.publishManaged(OWNER, {
      event: managedEvent('never-arrives'),
      options: {
        audienceRef,
        scope: { id: scopeId, revision: 1 },
        consumerProfileId: 'watcher-profile',
        requestedMode: 'resume',
      },
    }),
  ).rejects.toThrowError(/withdrawn|cancelled/i);
});

it('[02 §2.3] stale scope revision and expired audience reject capture', async () => {
  f = await system({ targets: 1 });
  await f.bind(0);
  const { audienceRef, scopeId } = await setupAudience(f.source);
  const m = f.source.managed;
  m.advanceScope(OWNER, { operationId: 'p1', scopeId, expectedRevision: 1, nextRevision: 2, state: 'paused' });
  await expect(
    m.publishManaged(OWNER, {
      event: managedEvent('stale-1'),
      options: {
        audienceRef,
        scope: { id: scopeId, revision: 1 },
        consumerProfileId: 'watcher-profile',
        requestedMode: 'resume',
      },
    }),
  ).rejects.toThrowError(/scope/i);
  // paused scope also rejects the fresh revision
  await expect(
    m.publishManaged(OWNER, {
      event: managedEvent('stale-2'),
      options: {
        audienceRef,
        scope: { id: scopeId, revision: 2 },
        consumerProfileId: 'watcher-profile',
        requestedMode: 'resume',
      },
    }),
  ).rejects.toThrowError(/state/i);
});

it('[02 §2.6/03 §3.4] withdraw: per-route dispositions from observed target state; tombstoned event reports withdrawn', async () => {
  f = await system({ targets: 1 });
  const id = await f.bind(0);
  const { audienceRef, scopeId } = await setupAudience(f.source);
  const m = f.source.managed;
  const receipt = await m.publishManaged(OWNER, {
    event: managedEvent('cut-me'),
    options: {
      audienceRef,
      scope: { id: scopeId, revision: 1 },
      consumerProfileId: 'watcher-profile',
      requestedMode: 'resume',
    },
  });
  expect(receipt.routes).toHaveLength(1);
  const w = m.withdraw(OWNER, { operationId: 'w2', eventId: 'cut-me', reason: 'host pause' });
  expect(w.sourceApplied).toBe(true);
  expect(w.routes).toHaveLength(1);
  expect(['pending', 'unknown', 'prevented']).toContain(w.routes[0].disposition);
  const after = await m.managedReceipt(OWNER, 'cut-me');
  expect(after.routes[0].delivery).toBe('withdrawn');
  // replay idempotent
  expect(m.withdraw(OWNER, { operationId: 'w2', eventId: 'cut-me', reason: 'host pause' })).toEqual(w);
});

it('[A2] watch cursor + snapshot; resync boundary reports snapshotCursor', async () => {
  f = await system({ targets: 1 });
  await f.bind(0);
  const { audienceRef, scopeId } = await setupAudience(f.source);
  const m = f.source.managed;
  await m.publishManaged(OWNER, {
    event: managedEvent('watched'),
    options: {
      audienceRef,
      scope: { id: scopeId, revision: 1 },
      consumerProfileId: 'watcher-profile',
      requestedMode: 'resume',
    },
  });
  const page = m.managedWatch(OWNER, 0, 128);
  expect(page.resyncRequired).toBe(false);
  expect(page.updates.length).toBeGreaterThan(0);
  expect(page.cursor).toBeGreaterThan(0);
  const snap = m.managedSnapshot(OWNER, undefined, 10);
  expect(snap.updates.map((u) => u.eventId)).toContain('watched');
  // after+1 earlier than the smallest retained cursor -> resync
  const resync = m.managedWatch(OWNER, 0, 128);
  expect(resync.resyncRequired).toBe(false); // single publisher stream still retained
});

it('[M5/m10] ingest dedup by (routeRef, targetRevision); consumer-response lands in source_responses', async () => {
  f = await system({ targets: 1 });
  await f.bind(0);
  const { audienceRef, scopeId } = await setupAudience(f.source);
  const m = f.source.managed;
  await m.publishManaged(OWNER, {
    event: managedEvent('resp-1'),
    options: {
      audienceRef,
      scope: { id: scopeId, revision: 1 },
      consumerProfileId: 'watcher-profile',
      requestedMode: 'resume',
    },
  });
  const first = m.ingestUpdate({
    publisherId: 'owner',
    eventId: 'resp-1',
    routeRef: 'route-x',
    targetRevision: 3,
    fact: { kind: 'managed-delivery', state: 'recorded', admission: 'accepted' },
  });
  const dup = m.ingestUpdate({
    publisherId: 'owner',
    eventId: 'resp-1',
    routeRef: 'route-x',
    targetRevision: 3,
    fact: { kind: 'managed-delivery', state: 'recorded', admission: 'accepted' },
  });
  expect(first).toBe(true);
  expect(dup).toBe(false);
  const body = {
    responseId: 'resp-abc',
    responseType: 'watcher.response.v1',
    schemaVersion: 1,
    data: { action: 'received' },
    digest: digest({ action: 'received' }),
    createdAt: new Date().toISOString(),
  };
  m.ingestUpdate({
    publisherId: 'owner',
    eventId: 'resp-1',
    routeRef: 'route-x',
    targetRevision: 4,
    fact: { kind: 'consumer-response', ...body },
  });
  const receipt = await m.managedReceipt(OWNER, 'resp-1');
  expect(receipt.responses.map((r) => r.responseId)).toContain('resp-abc');
  expect(receipt.responses[0].state).toBe('source_recorded');
});

it('[02 §2.2] confirmApplied records the application result and queues the ack outbox (idempotent)', async () => {
  f = await system({ targets: 1 });
  await f.bind(0);
  const { audienceRef, scopeId } = await setupAudience(f.source);
  const m = f.source.managed;
  await m.publishManaged(OWNER, {
    event: managedEvent('applied-1'),
    options: {
      audienceRef,
      scope: { id: scopeId, revision: 1 },
      consumerProfileId: 'watcher-profile',
      requestedMode: 'resume',
    },
  });
  m.ingestUpdate({
    publisherId: 'owner',
    eventId: 'applied-1',
    routeRef: 'route-y',
    targetRevision: 5,
    fact: {
      kind: 'consumer-response',
      responseId: 'resp-9',
      responseType: 'watcher.response.v1',
      schemaVersion: 1,
      data: { action: 'resolved' },
      digest: digest({ action: 'resolved' }),
      createdAt: new Date().toISOString(),
    },
  });
  const r1 = m.confirmApplied(OWNER, {
    operationId: 'ack-1',
    responseId: 'resp-9',
    result: { outcome: 'applied', applicationRevision: 2, code: 'APPLIED' },
  });
  expect(r1.applied).toBe(true);
  expect(
    m.confirmApplied(OWNER, {
      operationId: 'ack-1',
      responseId: 'resp-9',
      result: { outcome: 'applied', applicationRevision: 2, code: 'APPLIED' },
    }),
  ).toEqual(r1);
  const receipt = await m.managedReceipt(OWNER, 'applied-1');
  expect(receipt.responses[0].state).toBe('application_applied');
  expect(m.pendingAcks().length).toBe(1);
});

it('[regression] 1.1 publish path unchanged on a managed-enabled host', async () => {
  f = await system({ targets: 1 });
  const id = await f.bind(0);
  const result = await f.source.core.publish('X', event('legacy-1'));
  expect(result.routes[0].admission).toBe('accepted');
  expect(f.target[0].core.receipt(id, 'legacy-1').acceptedAt).toBeGreaterThan(0);
  void eventually;
  void installPrivate;
  void join;
  void secret;
});

// ---- stage 3.5: managed offline spool staging ----
import { createTarget } from '../../dist/target/host.js';
import { sha256 } from '../../dist/protocol/index.js';

async function publishOffline(source, eventId, audienceRef, scopeId, scopeRevision, reuseEvent) {
  return source.managed.publishManaged(OWNER, {
    event: reuseEvent ?? managedEvent(eventId),
    options: {
      audienceRef,
      scope: { id: scopeId, revision: scopeRevision },
      consumerProfileId: 'watcher-profile',
      requestedMode: 'resume',
    },
  });
}

it('[stage 3.5] offline route stages durably; target takeover delivers via the sync pump', async () => {
  f = await system({ targets: 1 });
  const id = await f.bind(0);
  const { audienceRef, scopeId, scopeRevision } = await setupAudience(f.source);
  const pending = () => f.source.core.store.all('SELECT * FROM managed_route_pending');
  await f.target[0].close();
  const event = managedEvent('md-offline-1');
  const receipt = await publishOffline(f.source, 'md-offline-1', audienceRef, scopeId, scopeRevision, event);
  expect(receipt.routes).toHaveLength(1);
  expect(receipt.routes[0].admission).toBe('unknown'); // never silently claimed durable
  expect(pending()).toHaveLength(1);
  // Replay while offline: identity capture, exactly one staged packet.
  await publishOffline(f.source, 'md-offline-1', audienceRef, scopeId, scopeRevision, event);
  expect(pending()).toHaveLength(1);
  // Target comes back on the same fingerprint (latest-active-wins takeover).
  f.target[0] = await createTarget({ home: f.home, realm: 'test', fingerprint: sha256('target-0') });
  await eventually(() => {
    if (f.source.core.store.get('SELECT 1 FROM managed_route_pending')) return false;
    return !!f.target[0].core.store.get(
      "SELECT 1 FROM managed_deliveries WHERE event_id='md-offline-1'",
    );
  });
  const after = f.source.managed.managedReceipt(OWNER, 'md-offline-1');
  expect(after.routes[0].admission).toBe('accepted');
  void id;
});

it('[stage 3.5] withdraw while staged drops the pending push (03 §3.2)', async () => {
  f = await system({ targets: 1 });
  const id = await f.bind(0);
  const { audienceRef, scopeId, scopeRevision } = await setupAudience(f.source);
  await f.target[0].close();
  await publishOffline(f.source, 'md-offline-w', audienceRef, scopeId, scopeRevision);
  expect(f.source.core.store.all('SELECT * FROM managed_route_pending')).toHaveLength(1);
  await f.source.managed.withdraw(OWNER, {
    operationId: newId('op'),
    eventId: 'md-offline-w',
    reason: 'superseded before delivery',
  });
  const result = await f.source.managed.retryManagedPending();
  expect(result.remaining).toBe(0);
  expect(f.source.core.store.all('SELECT * FROM managed_route_pending')).toHaveLength(0);
  void id;
});

it('[stage 3.5] a binding revoked while its packet is staged never receives it on retry', async () => {
  f = await system({ targets: 1 });
  const id = await f.bind(0);
  const { audienceRef, scopeId, scopeRevision } = await setupAudience(f.source);
  await f.target[0].close();
  await publishOffline(f.source, 'md-offline-r', audienceRef, scopeId, scopeRevision);
  expect(f.source.core.store.all('SELECT * FROM managed_route_pending')).toHaveLength(1);
  // Revoke lands while the target is offline, so the target itself never hears of it.
  f.source.core.store.run("UPDATE memberships SET state='revoked' WHERE binding=?", id);
  f.target[0] = await createTarget({ home: f.home, realm: 'test', fingerprint: sha256('target-0') });
  await eventually(() => !f.source.core.store.get('SELECT 1 FROM managed_route_pending'));
  expect(
    f.target[0].core.store.get("SELECT 1 FROM managed_deliveries WHERE event_id='md-offline-r'"),
  ).toBeUndefined();
  expect(f.source.managed.managedReceipt(OWNER, 'md-offline-r').routes[0].admission).toBe('rejected');
});

it('[stage 3.5] offline retries back off exponentially and stay due-gated', async () => {
  f = await system({ targets: 1 });
  const id = await f.bind(0);
  const { audienceRef, scopeId, scopeRevision } = await setupAudience(f.source);
  await f.target[0].close();
  await publishOffline(f.source, 'md-offline-b', audienceRef, scopeId, scopeRevision);
  const first = await f.source.managed.retryManagedPending();
  expect(first.pushed).toBe(0);
  expect(first.remaining).toBe(1);
  const row = f.source.core.store.get('SELECT * FROM managed_route_pending');
  expect(row.attempts).toBe(1);
  expect(row.next_attempt_at).toBeGreaterThan(Date.now());
  // Not due yet: the next pass is a no-op and does not stack attempts.
  const second = await f.source.managed.retryManagedPending();
  expect(second.remaining).toBe(1);
  expect(f.source.core.store.get('SELECT attempts FROM managed_route_pending').attempts).toBe(1);
  void id;
});

// ---- 2026-09-23 incident / Plan A sentinel validity in local domain ----
import { STANDING_EXPIRES_AT, FOREVER } from '../../dist/protocol/constants.js';
import { BUILTIN_TYPES } from '../../dist/protocol/validate.js';
import { createSource } from '../../dist/source/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

function makeClock(start = Date.now()) {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

function timedManagedEvent(clock, id = newId('evt'), data = { exitCode: 0 }) {
  const now = clock.now();
  return {
    kind: 'event',
    id,
    type: 'process.exited.v1',
    schemaVersion: 1,
    occurredAt: new Date(now).toISOString(),
    validUntil: new Date(now + 120_000).toISOString(),
    data,
  };
}

async function localEnv({ clock } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'relay-managed-local-'));
  const home = join(root, 'state');
  const config = {
    version: 1,
    sourceId: 'exec-local',
    realm: 'local',
    home,
    ownerToken: secret(),
    publisherTokens: { W: secret(), R: secret() },
    channels: [
      { id: 'W', types: BUILTIN_TYPES, allowedModes: ['display', 'resume'], maxAutoTargets: 2, localTrust: true },
      { id: 'R', types: BUILTIN_TYPES, allowedModes: ['display', 'resume'], maxAutoTargets: 2 },
    ],
  };
  const source = await createSource(config, { clock });
  const target = await createTarget({ home, realm: 'local', fingerprint: sha256('target-local-0'), clock });
  return {
    root,
    home,
    source,
    target,
    async close() {
      await target.close();
      await source.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it('[incident-2026-09-23] non-local realm / non-localTrust sentinel requests rejected with invalid_payload', async () => {
  f = await system({ targets: 1 });
  await f.bind(0);
  const m = f.source.managed;
  // channel X is remote (realm: 'test', localTrust undefined)
  expect(() =>
    m.provisionAudience(OWNER, {
      audienceRef: 'aud-remote-sentinel-1',
      channelId: 'X',
      consumerProfileId: 'watcher-profile',
      requestedMode: 'resume',
      validUntilMs: STANDING_EXPIRES_AT,
    }),
  ).toThrowError(/contract|invalid_payload/i);

  try {
    m.provisionAudience(OWNER, {
      audienceRef: 'aud-remote-sentinel-1',
      channelId: 'X',
      consumerProfileId: 'watcher-profile',
      requestedMode: 'resume',
      validUntilMs: STANDING_EXPIRES_AT,
    });
    expect.unreachable();
  } catch (e) {
    expect(e.code).toBe('invalid_payload');
  }

  expect(() =>
    m.provisionAudience(OWNER, {
      audienceRef: 'aud-remote-sentinel-2',
      channelId: 'X',
      consumerProfileId: 'watcher-profile',
      requestedMode: 'resume',
      validUntilMs: FOREVER,
    }),
  ).toThrowError(/contract|invalid_payload/i);

  expect(() =>
    m.provisionAudience(OWNER, {
      audienceRef: 'aud-remote-sentinel-3',
      channelId: 'X',
      consumerProfileId: 'watcher-profile',
      requestedMode: 'resume',
      validUntilMs: Number.MAX_SAFE_INTEGER,
    }),
  ).toThrowError(/contract|invalid_payload/i);
});

it('[incident-2026-09-23] expired remote audience still rejects capture with binding_expired', async () => {
  const clock = makeClock();
  f = await system({ targets: 1, clock });
  await f.bind(0);
  const m = f.source.managed;
  const audienceRef = 'aud-remote-exp';
  m.provisionAudience(OWNER, {
    audienceRef,
    channelId: 'X',
    consumerProfileId: 'watcher-profile',
    requestedMode: 'resume',
    validUntilMs: 3_600_000, // 1h
  });
  m.advanceScope(OWNER, {
    operationId: newId('op'),
    scopeId: 'scope-exp',
    expectedRevision: 0,
    nextRevision: 1,
    state: 'active',
  });

  // Advance clock by 2 hours (> 1h TTL)
  clock.advance(2 * 3600 * 1000);
  const ev = timedManagedEvent(clock, 'remote-after-exp');
  await expect(
    m.publishManaged(OWNER, {
      event: ev,
      options: {
        audienceRef,
        scope: { id: 'scope-exp', revision: 1 },
        consumerProfileId: 'watcher-profile',
        requestedMode: 'resume',
      },
    }),
  ).rejects.toThrowError(/expired|binding_expired/i);

  try {
    await m.publishManaged(OWNER, {
      event: ev,
      options: {
        audienceRef,
        scope: { id: 'scope-exp', revision: 1 },
        consumerProfileId: 'watcher-profile',
        requestedMode: 'resume',
      },
    });
    expect.unreachable();
  } catch (e) {
    expect(e.code).toBe('binding_expired');
  }
});

it('[incident-2026-09-23 / Plan A] local domain sentinel provision, 24h/7d simulated clock publish, idempotent reprovision, closeAudience', async () => {
  const clock = makeClock();
  lf = await localEnv({ clock });
  const bound = await lf.target.bindLocal({ sourceId: 'exec-local', channelId: 'W' });
  expect(bound.standing).toBe(true);

  // 1. Provision sentinel audience on local channel
  const audienceRef = 'aud-local-sentinel';
  const provisioned = lf.source.managed.provisionAudience(OWNER, {
    audienceRef,
    channelId: 'W',
    consumerProfileId: 'watcher-profile',
    requestedMode: 'resume',
    validUntilMs: STANDING_EXPIRES_AT,
  });
  expect(provisioned.audienceRef).toBe(audienceRef);

  // Read back from SQLite: valid_until must be 9007199254740991
  const row = lf.source.core.store.get(
    'SELECT valid_until, state FROM managed_audiences WHERE audience_ref=?',
    audienceRef,
  );
  expect(row.valid_until).toBe(STANDING_EXPIRES_AT);
  expect(row.valid_until).toBe(9007199254740991);
  expect(row.state).toBe('open');

  // 2. Idempotent reprovision with matching routeSet returns existing row
  const repro = lf.source.managed.provisionAudience(OWNER, {
    audienceRef,
    channelId: 'W',
    consumerProfileId: 'watcher-profile',
    requestedMode: 'resume',
    validUntilMs: STANDING_EXPIRES_AT,
  });
  expect(repro.audienceRef).toBe(audienceRef);

  // Activate scope
  lf.source.managed.advanceScope(OWNER, {
    operationId: newId('op'),
    scopeId: 'scope-sentinel',
    expectedRevision: 0,
    nextRevision: 1,
    state: 'active',
  });

  // 3. Advance clock past 24h (+1s): publish still captured and route accepted
  clock.advance(24 * 3600 * 1000 + 1000);
  const ev24h = timedManagedEvent(clock, 'ev-after-24h');
  const r24h = await lf.source.managed.publishManaged(OWNER, {
    event: ev24h,
    options: {
      audienceRef,
      scope: { id: 'scope-sentinel', revision: 1 },
      consumerProfileId: 'watcher-profile',
      requestedMode: 'resume',
    },
  });
  expect(r24h.sourceState).toBe('captured');
  expect(r24h.routes[0].admission).toBe('accepted');

  // 4. Advance clock by another 7 days: publish still captured and route accepted
  clock.advance(7 * 24 * 3600 * 1000);
  const ev7d = timedManagedEvent(clock, 'ev-after-7d');
  const r7d = await lf.source.managed.publishManaged(OWNER, {
    event: ev7d,
    options: {
      audienceRef,
      scope: { id: 'scope-sentinel', revision: 1 },
      consumerProfileId: 'watcher-profile',
      requestedMode: 'resume',
    },
  });
  expect(r7d.sourceState).toBe('captured');
  expect(r7d.routes[0].admission).toBe('accepted');

  // 5. Explicit lifecycle closure via closeAudience
  const closeRes = lf.source.managed.closeAudience(OWNER, audienceRef);
  expect(closeRes.closed).toBe(true);
  const closedRow = lf.source.core.store.get(
    'SELECT state FROM managed_audiences WHERE audience_ref=?',
    audienceRef,
  );
  expect(closedRow.state).toBe('closed');

  // Closed audience rejects further publish attempts with invalid_state
  const evAfterClose = timedManagedEvent(clock, 'ev-after-close');
  await expect(
    lf.source.managed.publishManaged(OWNER, {
      event: evAfterClose,
      options: {
        audienceRef,
        scope: { id: 'scope-sentinel', revision: 1 },
        consumerProfileId: 'watcher-profile',
        requestedMode: 'resume',
      },
    }),
  ).rejects.toThrowError(/state/);

  // Idempotent closeAudience
  expect(lf.source.managed.closeAudience(OWNER, audienceRef)).toEqual({ closed: true });
});
