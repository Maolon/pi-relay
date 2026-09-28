import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childFixture } from '../fixtures/child.mjs';
import { providerFixture } from '../fixtures/provider.mjs';
import { event, eventually } from '../fixtures/system.mjs';
import { BUILTIN_TYPES } from '../../dist/source/index.js';
import { secret } from '../../dist/protocol/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let root, provider, children = [];
afterEach(async () => {
  for (const child of children.reverse()) await child.close();
  children = [];
  await provider?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  root = provider = undefined;
});
async function spawn(args) {
  const child = await childFixture(args);
  children.push(child);
  return child;
}
const arm = (c, id, claims = 1) =>
  c.call('control', {
    bindingId: id,
    command: {
      action: 'arm',
      grant: { eventTypes: ['process.exited.v1'], maxClaims: claims, ttlMs: 600000 },
    },
  });

it('[M10] reconnect generation and channel identity stay separate across a CLI restart', async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-e2e-')));
  const home = join(root, 'state');
  provider = await providerFixture();
  const config = {
    version: 1,
    sourceId: 'exec',
    realm: 'test',
    home,
    ownerToken: secret(),
    publisherTokens: { X: secret() },
    channels: [
      { id: 'X', types: BUILTIN_TYPES, allowedModes: ['display', 'resume'], maxAutoTargets: 2 },
    ],
  };
  const source = await spawn({ role: 'source', config });
  const piArgs = (name) => ({ role: 'pi', home, cwd: join(root, name), url: provider.url });

  // First CLI run binds and arms; a real turn persists the session file first
  // (an unpersisted session has no stable identity to reconnect to).
  const a = await spawn(piArgs('a'));
  const aid = await a.call('bind', { invite: await source.call('invite', { channelId: 'X' }) });
  await arm(a, aid);
  await a.call('prompt', { text: 'seed turn' }); // request 1
  const file = a.ready.file;
  const fp = a.ready.fingerprint;
  await a.close(); // that CLI run exits

  // A new CLI run resuming the same session file is a reconnect generation of the same identity.
  const a2 = await spawn({ ...piArgs('a'), sessionFile: file });
  expect(a2.ready.fingerprint).toBe(fp);
  const status = await a2.call('status');
  expect(status.bindings.map((b) => b.bindingId)).toContain(aid);

  // Reconnect import holds the binding for recovery; the seed turn's foreground input
  // left its own hold and deactivated the old grant. Re-claim both, then arm fresh.
  await a2.call('control', { bindingId: aid, command: { action: 'resume', holdReason: 'recovery' } });
  await a2.call('control', { bindingId: aid, command: { action: 'resume', holdReason: 'foreground-changed' } });
  await arm(a2, aid);

  await source.call('publish', { value: event('gen') });
  await eventually(() => provider.requests.length === 2);
  await eventually(
    async () =>
      (await a2.call('receipt', { bindingId: aid, eventId: 'gen' })).delivery.observation
        ?.evidence === 'file-entry',
  );

  // Source-side replay is idempotent for the resumed connection: no duplicate delivery.
  await source.call('replay');
  await sleep(300);
  expect(provider.requests).toHaveLength(2);

  // A fresh CLI run is a new channel identity, never mistaken for the old one.
  const c = await spawn(piArgs('c'));
  const cid = await c.call('bind', { invite: await source.call('invite', { channelId: 'X' }) });
  expect(cid).not.toBe(aid);
  await source.call('publish', { value: event('c-own') });
  await sleep(300);
  expect(provider.requests).toHaveLength(2); // a2's one-claim grant is spent; c is unarmed
  const a2r = await a2.call('receipt', { bindingId: aid, eventId: 'c-own' });
  expect(a2r.delivery.observation?.evidence).toBeUndefined();
  await arm(c, cid);
  await eventually(() => provider.requests.length === 3);
  await eventually(
    async () =>
      (await c.call('receipt', { bindingId: cid, eventId: 'c-own' })).delivery.observation
        ?.evidence === 'file-entry',
  );
}, 45000);

it('[M18] an independent Source Host outlives its targets; events are not migrated between targets', async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-e2e-')));
  const home = join(root, 'state');
  provider = await providerFixture();
  const config = {
    version: 1,
    sourceId: 'exec',
    realm: 'test',
    home,
    ownerToken: secret(),
    publisherTokens: { X: secret() },
    channels: [
      { id: 'X', types: BUILTIN_TYPES, allowedModes: ['display', 'resume'], maxAutoTargets: 2 },
    ],
  };
  const source = await spawn({ role: 'source', config });
  const piArgs = (name) => ({ role: 'pi', home, cwd: join(root, name), url: provider.url });
  const a = await spawn(piArgs('a'));
  const b = await spawn(piArgs('b'));
  const aid = await a.call('bind', { invite: await source.call('invite', { channelId: 'X' }) });
  const bid = await b.call('bind', { invite: await source.call('invite', { channelId: 'X' }) });
  await arm(a, aid);
  await arm(b, bid, 4);

  await source.call('publish', { value: event('e1') });
  await eventually(() => provider.requests.length === 2);

  await a.close(); // one target exits; the independent host and B continue
  await source.call('publish', { value: event('e2') });
  await eventually(() => provider.requests.length === 3);
  await eventually(
    async () =>
      (await b.call('receipt', { bindingId: bid, eventId: 'e2' })).delivery.observation?.evidence ===
      'file-entry',
  );

  // While A stays down, its route is staged; B gets its own route. No migration.
  const split = await source.call('publish', { value: event('a-late') });
  expect(split.routes.map((r) => r.admission).sort()).toEqual(['accepted', 'staged']);

  await source.close(); // the host itself dies; restart from the same durable home
  const source2 = await spawn({ role: 'source', config });
  await source2.call('publish', { value: event('e3') });
  await eventually(() => provider.requests.length === 4);
  await eventually(
    async () =>
      (await b.call('receipt', { bindingId: bid, eventId: 'e3' })).delivery.observation?.evidence ===
      'file-entry',
  );

  // A returns with its own session: its staged event was waiting, not handed to anyone else.
  const a2 = await spawn({ ...piArgs('a'), sessionFile: a.ready.file });
  expect((await a2.call('receipt', { bindingId: aid, eventId: 'a-late' })).acceptedAt).toBeGreaterThan(
    0,
  );
  const memberships = await source2.call('memberships');
  expect(memberships.filter((m) => m.state === 'active').length).toBe(2);
}, 45000);

const sourceConfig = (home) => ({
  version: 1,
  sourceId: 'exec',
  realm: 'test',
  home,
  ownerToken: secret(),
  publisherTokens: { X: secret() },
  channels: [
    { id: 'X', types: BUILTIN_TYPES, allowedModes: ['display', 'resume'], maxAutoTargets: 2 },
  ],
});

it('[M10] upstream transport reconnect: a crashed Source Host recovers its journal; continuation dedupes', async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-e2e-')));
  const home = join(root, 'state');
  provider = await providerFixture();
  const config = sourceConfig(home);
  const source = await spawn({ role: 'source', config });
  const piArgs = (name) => ({ role: 'pi', home, cwd: join(root, name), url: provider.url });
  const a = await spawn(piArgs('a'));
  const aid = await a.call('bind', { invite: await source.call('invite', { channelId: 'X' }) });
  await a.call('prompt', { text: 'seed turn' });
  await a.call('control', { bindingId: aid, command: { action: 'resume', holdReason: 'recovery' } });
  await a.call('control', { bindingId: aid, command: { action: 'resume', holdReason: 'foreground-changed' } });
  await arm(a, aid, 2); // one claim per continuation event across the crash
  await source.call('publish', { value: event('pre-crash') });
  await eventually(() => provider.requests.length === 2); // 1 = seed turn, 2 = wake
  await eventually(
    async () =>
      (await a.call('receipt', { bindingId: aid, eventId: 'pre-crash' })).delivery.observation
        ?.evidence === 'file-entry',
  );

  // The upstream transport host crashes (SIGKILL) while the target stays attached.
  await source.kill();
  const source2 = await spawn({ role: 'source', config }); // same home: journal recovery
  const members = await source2.call('memberships');
  expect(members).toEqual([{ binding: aid, state: 'active' }]);

  // Continuation events dedupe across the source restart: exactly one delivery each.
  await source2.call('publish', { value: event('post-crash') });
  await eventually(() => provider.requests.length === 3);
  await source2.call('replay');
  await source2.call('replay');
  await sleep(400);
  expect(provider.requests).toHaveLength(3); // dedup: replay never re-delivers a recorded wake
  await eventually(
    async () =>
      (await a.call('receipt', { bindingId: aid, eventId: 'post-crash' })).delivery.observation
        ?.evidence === 'file-entry',
  );
}, 60000);

it('[M18] parasitic half: source dies with A; independent B keeps serving, nothing migrates', async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-e2e-')));
  const home = join(root, 'state');
  provider = await providerFixture();
  const config = sourceConfig(home);
  const source = await spawn({ role: 'source', config });
  const piArgs = (name) => ({ role: 'pi', home, cwd: join(root, name), url: provider.url });
  const a = await spawn(piArgs('a'));
  const b = await spawn(piArgs('b'));
  const aid = await a.call('bind', { invite: await source.call('invite', { channelId: 'X' }) });
  const bid = await b.call('bind', { invite: await source.call('invite', { channelId: 'X' }) });
  for (const [c, id] of [[a, aid], [b, bid]]) {
    await c.call('prompt', { text: 'seed turn' });
    await c.call('control', { bindingId: id, command: { action: 'resume', holdReason: 'recovery' } });
    await c.call('control', { bindingId: id, command: { action: 'resume', holdReason: 'foreground-changed' } });
  }
  await arm(a, aid);
  await arm(b, bid, 4);

  // The parasitic host terminates together with its host process A; B survives.
  await source.kill();
  await a.kill();
  const status = await b.call('status');
  expect(status.bindings.map((x) => ({ id: x.bindingId, state: x.state }))).toContainEqual({
    id: bid,
    state: 'active',
  });

  // A restarted Source Host recovers from the same home; memberships persist.
  const source2 = await spawn({ role: 'source', config });
  const members = await source2.call('memberships');
  const states = Object.fromEntries(members.map((m) => [m.binding, m.state]));
  expect(states[aid]).toBe('active');
  expect(states[bid]).toBe('active');

  // Events while A is down wake only B: nothing migrates to the dead binding.
  await source2.call('publish', { value: event('b-only') });
  await eventually(() => provider.requests.length === 3); // 1-2 = seed turns, 3 = B's wake
  await eventually(
    async () =>
      (await b.call('receipt', { bindingId: bid, eventId: 'b-only' })).delivery.observation
        ?.evidence === 'file-entry',
  );

  // A returns as a new connection generation: it must re-claim explicitly and
  // only then does its own continuation deliver — B's records stay untouched.
  const file = a.ready.file;
  const a2 = await spawn({ ...piArgs('a'), sessionFile: file });
  expect(a2.ready.fingerprint).toBe(a.ready.fingerprint);
  const holds = (await a2.call('status')).bindings.find((x) => x.bindingId === aid);
  expect(holds.holds).toEqual(expect.arrayContaining(['recovery']));
  await a2.call('control', { bindingId: aid, command: { action: 'resume', holdReason: 'recovery' } });
  await a2.call('control', { bindingId: aid, command: { action: 'resume', holdReason: 'foreground-changed' } });
  await arm(a2, aid, 2); // one claim for the imported continuation, one for the fresh event
  await source2.call('publish', { value: event('a-back') });
  // A's reclaim wakes both its imported continuation and the fresh event (the
  // requests counter can jump past 4 between polls); require the fresh record.
  await eventually(() => provider.requests.length >= 4);
  await eventually(
    async () =>
      (await a2.call('receipt', { bindingId: aid, eventId: 'a-back' })).delivery.observation
        ?.evidence === 'file-entry',
  );
  await eventually(
    async () =>
      (await a2.call('receipt', { bindingId: aid, eventId: 'b-only' })).delivery.observation
        ?.evidence === 'file-entry',
  );
  // B keeps receiving channel events through its own grant (independent host);
  // A's reclaim delivered the same event only through A's own explicit claim —
  // that is co-delivery under channel membership, not state migration.
  await eventually(
    async () =>
      (await b.call('receipt', { bindingId: bid, eventId: 'a-back' })).delivery.observation
        ?.evidence === 'file-entry',
  );
}, 60000);
