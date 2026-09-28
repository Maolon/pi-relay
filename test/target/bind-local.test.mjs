import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource } from '../../dist/source/host.js';
import { createTarget } from '../../dist/target/host.js';
import { BUILTIN_TYPES } from '../../dist/protocol/validate.js';
import { secret, newId, sha256 } from '../../dist/protocol/index.js';
import { connectChannel } from '../../dist/client/index.js';
import { STANDING_EXPIRES_AT } from '../../dist/protocol/constants.js';

// Delta-2 local standing binding (plans/managed-delivery-v0.3/delta-2, handoff
// 2026-09-21-relay-local-standing-binding): a channel whose owner opts in with
// localTrust may be bound directly by any same-home same-realm session — no
// invite, no TTLs, standing session-scoped grant, pid-GC of crashed neighbors.

let source, targets = [];
afterEach(async () => {
  for (const t of targets) await t?.close();
  await source?.close();
  targets = [];
  source = undefined;
});

function localTrustConfig(home) {
  return {
    version: 1,
    sourceId: 'watcher-local',
    realm: 'local',
    home,
    ownerToken: secret(),
    publisherTokens: { W: secret(), R: secret() },
    channels: [
      { id: 'W', types: BUILTIN_TYPES, allowedModes: ['display', 'resume'], maxAutoTargets: 1, localTrust: true },
      { id: 'R', types: BUILTIN_TYPES, allowedModes: ['display', 'resume'], maxAutoTargets: 1 },
    ],
  };
}

async function env({ targetCount = 1, realm = 'local' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'relay-standing-'));
  source = await createSource(localTrustConfig(home));
  for (let i = 0; i < targetCount; i++)
    targets.push(await createTarget({ home, realm, fingerprint: sha256('st-target-' + i) }));
  return { home, source, targets };
}

it('[delta-2] bindLocal arms a standing session-scoped grant and enrolls membership', async () => {
  const { source, targets: t } = await env();
  const r = await t[0].bindLocal({ sourceId: 'watcher-local', channelId: 'W' });
  expect(r.standing).toBe(true);
  expect(r.bindingId).toMatch(/^bnd-/);
  expect(r.armed).toBe(true);
  const b = t[0].core.binding(r.bindingId);
  expect(b.state).toBe('active');
  expect(b.standing).toBe(true);
  expect(b.expiresAt).toBe(STANDING_EXPIRES_AT);
  // standing grant: sessionScoped, sentinel expiry, ignored cap semantics
  const grant = t[0].core.store.get('SELECT body, consumed FROM grants WHERE binding=? AND active=1', r.bindingId);
  const g = JSON.parse(grant.body);
  expect(g.request.standing).toBe(true);
  expect(g.request.sessionScoped).toBe(true);
  expect(g.expiresAt).toBe(STANDING_EXPIRES_AT);
  // source-side membership active with sentinel expiry
  const m = source.core.membership(r.bindingId);
  expect(m.expiresAt).toBe(STANDING_EXPIRES_AT);
}, 10000);

it('[delta-2] bindLocal is idempotent per (source, channel, fingerprint)', async () => {
  const { targets: t } = await env();
  const a = await t[0].bindLocal({ sourceId: 'watcher-local', channelId: 'W' });
  const b = await t[0].bindLocal({ sourceId: 'watcher-local', channelId: 'W', operationId: newId('op') });
  expect(b.bindingId).toBe(a.bindingId);
  expect(t[0].core.list()).toHaveLength(1);
}, 10000);

it('[delta-2] multiple sessions hold standing bindings on one channel (no cross-target overlap)', async () => {
  const { source, targets: t } = await env({ targetCount: 2 });
  const a = await t[0].bindLocal({ sourceId: 'watcher-local', channelId: 'W' });
  const b = await t[1].bindLocal({ sourceId: 'watcher-local', channelId: 'W' });
  expect(b.bindingId).not.toBe(a.bindingId);
  const active = source.core.store.all("SELECT body FROM memberships WHERE channel='W' AND state='active'");
  expect(active).toHaveLength(2);
}, 10000);

it('[delta-2] standing and invite paths never block each other', async () => {
  const { source, targets: t } = await env();
  await t[0].bindLocal({ sourceId: 'watcher-local', channelId: 'W' });
  // invite bind on the SAME channel still works (overlap scan ignores standing)
  const invite = source.core.createInvite({
    operationId: newId('inv'), channelId: 'W', ttlMs: 600000, bindingTtlMs: 3600000, allowResume: true,
  });
  const inviteTarget = await createTarget({ home: t[0].core.options.home, realm: 'local', fingerprint: sha256('st-invite') });
  targets.push(inviteTarget);
  const inviteBinding = await inviteTarget.bind(invite, { operationId: newId('op'), resume: true });
  expect(inviteBinding).toMatch(/^bnd-/);
  expect(inviteTarget.core.binding(inviteBinding).standing).toBeUndefined();
}, 10000);

it('[delta-2] non-opted channel / wrong realm / missing source fail with actionable codes', async () => {
  const { targets: t } = await env();
  await expect(t[0].bindLocal({ sourceId: 'watcher-local', channelId: 'R' })).rejects.toMatchObject({
    detail: { code: 'local_trust_disabled' },
  });
  await expect(t[0].bindLocal({ sourceId: 'no-such-source', channelId: 'W' })).rejects.toMatchObject({
    detail: { code: 'source_not_found' },
  });
  const otherRealm = await createTarget({ home: t[0].core.options.home, realm: 'elsewhere', fingerprint: sha256('st-x') });
  targets.push(otherRealm);
  await expect(otherRealm.bindLocal({ sourceId: 'watcher-local', channelId: 'W' })).rejects.toMatchObject({
    detail: { code: 'unauthorized' },
  });
}, 10000);

it('[delta-2] a standing enroll pid-GCs crashed same-channel neighbors', async () => {
  const { home, source, targets: t } = await env();
  // simulate a crashed incumbent: standing membership pointing at a target
  // store whose owner token names a dead pid
  const deadFp = sha256('st-dead');
  const deadDir = join(home, 'targets', deadFp);
  mkdirSync(deadDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(deadDir, 'owner.lock'), JSON.stringify({ generation: 1, pid: 999999 }), { mode: 0o600 });
  const cut = 1;
  source.core.store.run(
    "INSERT INTO memberships(binding,channel,target,state,cut,last_seen,body) VALUES(?,?,?,'active',?,0,?)",
    'bnd-dead', 'W', deadFp, cut,
    JSON.stringify({
      bindingId: 'bnd-dead', channelId: 'W', targetFingerprint: deadFp, preparedDigest: 'x',
      operationId: 'op-dead', capabilityRef: 'x', policy: {}, expiresAt: STANDING_EXPIRES_AT, membershipRevision: cut,
    }),
  );
  const r = await t[0].bindLocal({ sourceId: 'watcher-local', channelId: 'W' });
  const state = source.core.store.get("SELECT state FROM memberships WHERE binding='bnd-dead'");
  expect(state.state).toBe('expired');
  const live = source.core.store.get('SELECT state FROM memberships WHERE binding=?', r.bindingId);
  expect(live.state).toBe('active');
}, 10000);

it('[delta-2] standing grant claims survive beyond the nominal claim cap', async () => {
  const { source, targets: t } = await env();
  const r = await t[0].bindLocal({ sourceId: 'watcher-local', channelId: 'W' });
  const grantRow = t[0].core.store.get('SELECT id FROM grants WHERE binding=? AND active=1', r.bindingId);
  // saturate the nominal cap, then confirm claimOne still passes the grant gate
  t[0].core.store.run('UPDATE grants SET consumed=999 WHERE id=?', grantRow.id);
  // publish five events; claimOne must still find a usable grant
  // publish five events through the real fanout; claimOne must still find a usable grant
  const publisher = connectChannel(source.core.ownerHandle(), 'W');
  for (let i = 0; i < 5; i++) {
    await publisher.publish({
      kind: 'event', id: 'st-evt-' + i, type: 'process.exited.v1', schemaVersion: 1,
      occurredAt: new Date().toISOString(), validUntil: new Date(Date.now() + 60000).toISOString(),
      data: { exitCode: 0 },
    });
  }
  publisher.dispose();
  const eligibility = { idle: true, pending: false, knownWait: false, strictNoAutoResume: false };
  // consumed=999 far exceeds the nominal cap (4); a standing grant must still claim.
  const attempt = t[0].core.claimOne(eligibility);
  expect(attempt).toBeTruthy();
  expect(attempt.bindingId).toBe(r.bindingId);
  const after = t[0].core.store.get('SELECT consumed FROM grants WHERE id=?', grantRow.id);
  expect(after.consumed).toBe(1000); // incremented past the nominal cap without rejection
}, 10000);
