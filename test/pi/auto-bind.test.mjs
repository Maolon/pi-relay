import { it, expect, afterEach } from 'vitest';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { system } from '../fixtures/system.mjs';
import { registerAutoBindListener } from '../../dist/pi/auto-bind.js';
import { newId, secret, sha256 } from '../../dist/protocol/index.js';
import { createSource } from '../../dist/source/host.js';
import { createTarget } from '../../dist/target/host.js';
import { BUILTIN_TYPES } from '../../dist/protocol/validate.js';

// Handoff 2026-09-21 (pi-watcher 4a9c1da): an owner pre-authorized binding by
// minting a single-use invite; the watcher requests this session bind+arm over
// the pi.events bus. The listener must behave exactly like the model-facing
// relay_bindings bind (resume bind + 4-claim/30-min arm), never bind the same
// invite twice, and answer with the contract's reply codes.

let sys, lsource, ltarget;
afterEach(async () => {
  await sys?.close();
  sys = undefined;
  await ltarget?.close();
  ltarget = undefined;
  await lsource?.close();
  lsource = undefined;
});

function harness(opts = {}) {
  const host = opts.host;
  const sessionFile = 'sessionFile' in opts ? opts.sessionFile : '/persisted/session.jsonl';
  const handlers = new Map();
  const emitted = [];
  const bus = {
    on: (channel, fn) => {
      const list = handlers.get(channel) ?? [];
      list.push(fn);
      handlers.set(channel, list);
      return () => handlers.set(channel, (handlers.get(channel) ?? []).filter((f) => f !== fn));
    },
    emit: (channel, data) => {
      emitted.push({ channel, data });
      for (const fn of handlers.get(channel) ?? []) fn(data);
    },
  };
  let attached = host;
  let file = sessionFile;
  const off = registerAutoBindListener(
    bus,
    () => attached,
    () => file,
  );
  const request = async (payload, timeoutMs = 3000) => {
    const before = emitted.length;
    const deadline = Date.now() + timeoutMs;
    bus.emit('pi-relay:bind-request', payload);
    for (;;) {
      const replies = emitted.slice(before).filter((x) => x.channel === 'pi-relay:bind-result');
      if (replies.length > 0) return replies[0].data;
      if (Date.now() > deadline) return undefined;
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return { bus, emitted, off, request, detach: () => (attached = undefined), unsetFile: () => (file = undefined) };
}

function inviteFile(sys, name = 'invite.json') {
  const invite = sys.source.core.createInvite({
    operationId: newId('inv'),
    channelId: 'X',
    ttlMs: 600000,
    bindingTtlMs: 3600000,
    allowResume: true,
  });
  const path = join(sys.root, name);
  writeFileSync(path, JSON.stringify(invite), { mode: 0o600 });
  return path;
}

it('binds and arms with tool-identical semantics on a valid request', async () => {
  sys = await system({ targets: 1 });
  const host = sys.target[0];
  const h = harness({ host });
  const path = inviteFile(sys);
  const r = await h.request({ requestId: 'auto-bind-s1-0', source: 'pi-watcher', invitePath: path, projectRoot: '/x' });
  expect(r.ok).toBe(true);
  expect(r.bindingId).toMatch(/^bnd-/);
  expect(r.armed).toBe(true);
  const [b] = host.core.list();
  expect(b.state).toBe('active');
  const status = host.core.status();
  expect(status.bindings[0].grants).toHaveLength(1);
  expect(status.bindings[0].grants[0].maxClaims).toBe(4);
  expect(Number.isFinite(status.bindings[0].grants[0].expiresAt)).toBe(true);
  h.off();
}, 10000);

it('replies not_attached / no_session_file so the requester can retry or surface once', async () => {
  sys = await system({ targets: 1 });
  const host = sys.target[0];
  const h = harness({ host, sessionFile: undefined });
  const path = inviteFile(sys);
  const noFile = await h.request({ requestId: 'r1', source: 'pi-watcher', invitePath: path });  expect(noFile).toEqual({
    requestId: 'r1',
    ok: false,
    error: { code: 'no_session_file', message: expect.any(String) },
  });
  const withFile = harness({ host });
  withFile.detach();
  const noHost = await withFile.request({ requestId: 'r2', source: 'pi-watcher', invitePath: path });
  expect(noHost.error.code).toBe('not_attached');
  h.off();
  withFile.off();
}, 10000);

it('rejects malformed envelopes and bad paths without touching the host', async () => {
  sys = await system({ targets: 1 });
  const h = harness({ host: sys.target[0] });
  // garbage: no reply channel data, must not throw
  expect(await h.request(null, 200)).toBeUndefined();
  expect(await h.request({ source: 'pi-watcher', invitePath: '/x' }, 200)).toBeUndefined();
  const bad = await h.request({ requestId: 'r3', source: 'pi-watcher', invitePath: 'relative/invite.json' });
  expect(bad.error.code).toBe('invalid_payload');
  const missing = await h.request({ requestId: 'r4', source: 'pi-watcher', invitePath: '/abs/no-such-invite.json' });
  expect(missing.error.code).toBe('invalid_payload');
  expect(sys.target[0].core.list()).toHaveLength(0);
  h.off();
}, 10000);

it('never binds the same invite twice from one listener', async () => {
  sys = await system({ targets: 1 });
  const host = sys.target[0];
  const h = harness({ host });
  const path = inviteFile(sys);
  const first = await h.request({ requestId: 'a-0', source: 'pi-watcher', invitePath: path });
  expect(first.ok).toBe(true);
  const second = await h.request({ requestId: 'a-1', source: 'pi-watcher', invitePath: path });
  expect(second).toEqual({
    requestId: 'a-1',
    ok: false,
    error: { code: 'invite_consumed', message: expect.any(String) },
  });
  expect(host.core.status().bindings).toHaveLength(1);
  h.off();
}, 10000);

it('passes bind failures through canonically (watcher regex already matches "already")', async () => {
  sys = await system({ targets: 1 });
  const host = sys.target[0];
  const h = harness({ host });
  const path = inviteFile(sys);
  // bind once (a different session consumed it, e.g. bound elsewhere)
  const invite2 = JSON.parse((await import('node:fs')).readFileSync(path, 'utf8'));
  const h2 = harness({ host });
  const first = await h2.request({ requestId: 'b-0', source: 'pi-watcher', invitePath: path });
  expect(first.ok).toBe(true);
  h2.off();
  // same channel now occupied: a fresh listener on a fresh invite for the same
  // channel must surface binding_overlap whose canonical message says "already"
  const stalePath = join(sys.root, 'invite-stale.json');
  writeFileSync(stalePath, JSON.stringify(invite2), { mode: 0o600 });
  // consume-on-disk replay: listener did not bind this path, so it attempts and
  // the store rejects the replayed single-use invite via the canonical error
  const replay = await h.request({ requestId: 'b-1', source: 'pi-watcher', invitePath: stalePath });
  expect(replay.ok).toBe(false);
  expect(replay.error.code).toMatch(/^(binding_overlap|unauthorized|invalid_payload|invalid_state)$/);
  expect(/already|used|consumed|invite/i.test(`${replay.error.code} ${replay.error.message}`)).toBe(true);
  h.off();
}, 10000);

it('detaching the listener stops the surface entirely', async () => {
  sys = await system({ targets: 1 });
  const h = harness({ host: sys.target[0] });
  h.off();
  const path = inviteFile(sys);
  const before = h.emitted.length;
  await h.request({ requestId: 'z-0', source: 'pi-watcher', invitePath: path }, 300);
  expect(h.emitted.length).toBe(before + 1); // request only, no result
  expect(sys.target[0].core.list()).toHaveLength(0);
}, 10000);

// ---- contract v2: kind 'local' (delta-2 local standing binding) ----
async function localEnv() {
  const home = mkdtempSync(join(tmpdir(), 'relay-ab-local-'));
  lsource = await createSource({
    version: 1, sourceId: 'watcher-w', realm: 'local', home,
    ownerToken: secret(), publisherTokens: { W: secret() },
    channels: [
      { id: 'W', types: BUILTIN_TYPES, allowedModes: ['display', 'resume'], maxAutoTargets: 1, localTrust: true },
    ],
  });
  ltarget = await createTarget({ home, realm: 'local', fingerprint: sha256('ab-local-t') });
  return { home };
}

it('v2 kind local binds a standing binding and reports standing:true', async () => {
  await localEnv();
  const h = harness({ host: ltarget });
  const r = await h.request({
    kind: 'local', requestId: 'ab-l0', source: 'pi-watcher',
    sourceId: 'watcher-w', channelId: 'W', realm: 'local', projectRoot: '/x',
  });
  expect(r).toEqual({ requestId: 'ab-l0', ok: true, bindingId: expect.stringMatching(/^bnd-/), armed: true, standing: true });
  expect(ltarget.core.list()).toHaveLength(1);
  h.off();
}, 10000);

it('v2 kind local maps local_trust_disabled through for the watcher fallback', async () => {
  const home = mkdtempSync(join(tmpdir(), 'relay-ab-nolt-'));
  lsource = await createSource({
    version: 1, sourceId: 'watcher-nolt', realm: 'local', home,
    ownerToken: secret(), publisherTokens: { W: secret() },
    channels: [
      { id: 'W', types: BUILTIN_TYPES, allowedModes: ['display', 'resume'], maxAutoTargets: 1 },
    ],
  });
  ltarget = await createTarget({ home, realm: 'local', fingerprint: sha256('ab-nolt-t') });
  const h = harness({ host: ltarget });
  const r = await h.request({
    kind: 'local', requestId: 'ab-l1', source: 'pi-watcher',
    sourceId: 'watcher-nolt', channelId: 'W', realm: 'local',
  });
  expect(r.ok).toBe(false);
  expect(r.error.code).toBe('local_trust_disabled');
  expect(ltarget.core.list()).toHaveLength(0);
  h.off();
}, 10000);

it('v1 requests (no kind) still take the invite path unchanged', async () => {
  sys = await system({ targets: 1 });
  const h = harness({ host: sys.target[0] });
  const path = inviteFile(sys);
  const r = await h.request({ requestId: 'ab-v1', source: 'pi-watcher', invitePath: path });
  expect(r.ok).toBe(true);
  expect(r.standing).toBeUndefined();
  expect(r.armed).toBe(true);
  h.off();
}, 10000);
