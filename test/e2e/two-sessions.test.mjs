import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { childFixture } from '../fixtures/child.mjs';
import { providerFixture } from '../fixtures/provider.mjs';
import { event, eventually } from '../fixtures/system.mjs';
import { BUILTIN_TYPES } from '../../dist/source/index.js';
import { secret } from '../../dist/protocol/index.js';
import { installPrivate } from '../../dist/platform/atomic-file.js';
const exec = promisify(execFile);
let root,
  provider,
  children = [];
afterEach(async () => {
  for (const child of children.reverse()) await child.close();
  children = [];
  await provider?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});
async function spawn(args) {
  const c = await childFixture(args);
  children.push(c);
  return c;
}
it('[M01 M02 M03 M04 M05 M08 G07] one Source process, two real Pi processes and a finite CLI publisher remain independent', async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-e2e-')));
  const home = join(root, 'state');
  provider = await providerFixture();
  const config = {
    version: 1,
    sourceId: 'exec',
    realm: 'test',
    home,
    ownerToken: secret(),
    publisherTokens: { X: secret(), Y: secret() },
    channels: ['X', 'Y'].map((id) => ({
      id,
      types: BUILTIN_TYPES,
      allowedModes: ['display', 'resume'],
      maxAutoTargets: 2,
    })),
  };
  const source = await spawn({ role: 'source', config });
  const args = (i) => ({ role: 'pi', home, cwd: join(root, 'pi-' + i), url: provider.url });
  const a = await spawn(args('a'));
  let b = await spawn(args('b'));
  const bind = async (c, ch = 'X') =>
    c.call('bind', { invite: await source.call('invite', { channelId: ch }) });
  const aid = await bind(a),
    bid = await bind(b);
  await bind(a, 'Y');
  const arm = (c, id) =>
    c.call('control', {
      bindingId: id,
      command: { action: 'arm', grant: { eventTypes: ['process.exited.v1'], maxClaims: 1, ttlMs: 600000 } },
    });
  await arm(a, aid);
  await arm(b, bid);
  const handle = join(root, 'publisher.json'),
    input = join(root, 'event.json');
  installPrivate(handle, source.ready.publisher);
  writeFileSync(input, JSON.stringify(event('shared')));
  const published = JSON.parse(
    (
      await exec(
        process.execPath,
        ['dist/cli/index.js', 'publish', '--source-file', handle, '--event-file', input],
        { cwd: process.cwd() },
      )
    ).stdout,
  );
  expect(published.routes.map((r) => r.admission)).toEqual(['accepted', 'accepted']);
  await eventually(() => provider.requests.length === 2);
  for (const [c, id] of [
    [a, aid],
    [b, bid],
  ])
    await eventually(
      async () =>
        (await c.call('receipt', { bindingId: id, eventId: 'shared' })).delivery.observation?.evidence ===
        'file-entry',
    );
  const ar = await a.call('receipt', { bindingId: aid, eventId: 'shared' }),
    br = await b.call('receipt', { bindingId: bid, eventId: 'shared' });
  expect(ar.delivery.deliveryId).not.toBe(br.delivery.deliveryId);
  const file = b.ready.file;
  await b.close();
  const offline = await source.call('publish', { value: event('offline') });
  expect(offline.routes.map((r) => r.admission).sort()).toEqual(['accepted', 'staged']);
  b = await spawn({ ...args('b'), sessionFile: file });
  await eventually(
    async () => !!(await b.call('receipt', { bindingId: bid, eventId: 'offline' })).acceptedAt,
  );
  expect(provider.requests).toHaveLength(2);
  await b.call('control', { bindingId: bid, command: { action: 'resume', holdReason: 'recovery' } });
  await arm(b, bid);
  await eventually(() => provider.requests.length === 3);
  await a.call('control', { bindingId: aid, command: { action: 'revoke' } });
  await eventually(
    async () => (await source.call('memberships')).find((m) => m.binding === aid)?.state === 'revoked',
  );
  const next = await source.call('publish', { value: event('b-only') });
  expect(next.routes).toHaveLength(1);
  expect(next.routes[0].bindingId).toBe(bid);
  await b.call('control', { bindingId: bid, command: { action: 'revoke' } });
  await eventually(
    async () => (await source.call('memberships')).find((m) => m.binding === bid)?.state === 'revoked',
  );
  expect((await source.call('publish', { value: event('nobody') })).sourceState).toBe('empty-audience');
  expect(source.child.exitCode).toBe(null);
}, 30000);

it('[M02] channel Y delivers to its own binding without crossing receipts or identities', async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-e2e-')));
  const home = join(root, 'state');
  provider = await providerFixture();
  const config = {
    version: 1,
    sourceId: 'exec',
    realm: 'test',
    home,
    ownerToken: secret(),
    publisherTokens: { X: secret(), Y: secret() },
    channels: ['X', 'Y'].map((id) => ({
      id,
      types: BUILTIN_TYPES,
      allowedModes: ['display', 'resume'],
      maxAutoTargets: 2,
    })),
  };
  const source = await spawn({ role: 'source', config });
  const args = (i) => ({ role: 'pi', home, cwd: join(root, i), url: provider.url });

  const a = await spawn(args('a'));
  const b = await spawn(args('b'));
  const bind = async (c, ch = 'X') =>
    c.call('bind', { invite: await source.call('invite', { channelId: ch }) });
  const aid = await bind(a),
    bid = await bind(b),
    yid = await bind(a, 'Y');
  const arm = (c, id, claims = 1) =>
    c.call('control', {
      bindingId: id,
      command: { action: 'arm', grant: { eventTypes: ['process.exited.v1'], maxClaims: claims, ttlMs: 600000 } },
    });
  await arm(a, yid);
  await arm(b, bid);
  await source.call('publish', { channelId: 'Y', value: event('y-event') });
  await eventually(() => provider.requests.length === 1); // only A's Y binding woke
  await eventually(
    async () =>
      (await a.call('receipt', { bindingId: yid, eventId: 'y-event' })).delivery.observation
        ?.evidence === 'file-entry',
  );
  // Receipts never cross: neither A's X binding nor B received the Y event.
  await expect(a.call('receipt', { bindingId: aid, eventId: 'y-event' })).rejects.toBeTruthy();
  await expect(b.call('receipt', { bindingId: bid, eventId: 'y-event' })).rejects.toBeTruthy();
  expect(provider.requests).toHaveLength(1);
}, 45000);

it('[M08 M19] one capture fans out independently: A\'s ack never consumes B\'s staged copy', async () => {
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
    channels: [{ id: 'X', types: BUILTIN_TYPES, allowedModes: ['display', 'resume'], maxAutoTargets: 2 }],
  };
  const source = await spawn({ role: 'source', config });
  const args = (i) => ({ role: 'pi', home, cwd: join(root, i), url: provider.url });
  const a = await spawn(args('a'));
  let b = await spawn(args('b'));
  const bind = async (c) => c.call('bind', { invite: await source.call('invite', { channelId: 'X' }) });
  const aid = await bind(a);
  const bid = await bind(b);
  const control = (c, id, command) => c.call('control', { bindingId: id, command });
  const arm = (c, id, claims = 1) =>
    control(c, id, { action: 'arm', grant: { eventTypes: ['process.exited.v1'], maxClaims: claims, ttlMs: 600000 } });
  await a.call('prompt', { text: 'persist A' }); // request 1
  await control(a, aid, { action: 'resume', holdReason: 'recovery' });
  await control(a, aid, { action: 'resume', holdReason: 'foreground-changed' });
  await arm(a, aid);
  await b.call('prompt', { text: 'persist B' }); // request 2
  await control(b, bid, { action: 'resume', holdReason: 'recovery' });
  await control(b, bid, { action: 'resume', holdReason: 'foreground-changed' });

  // B goes offline before the single upstream capture.
  const bFile = b.ready.file;
  await b.close();
  const handle = join(root, 'publisher.json'),
    input = join(root, 'ack-race.json');
  installPrivate(handle, source.ready.publisher);
  writeFileSync(input, JSON.stringify(event('ack-race')));
  const published = JSON.parse(
    (
      await exec(process.execPath, ['dist/cli/index.js', 'publish', '--source-file', handle, '--event-file', input], {
        cwd: process.cwd(),
      })
    ).stdout,
  );
  expect(published.routes.map((r) => r.admission).sort()).toEqual(['accepted', 'staged']);

  // Exactly one durable capture exists; a CLI retry with the same identity is idempotent.
  const events = await source.call('memberships'); // keep source alive marker
  expect(events).toBeTruthy();
  const retry = JSON.parse(
    (
      await exec(process.execPath, ['dist/cli/index.js', 'publish', '--source-file', handle, '--event-file', input], {
        cwd: process.cwd(),
      })
    ).stdout,
  );
  expect(retry.fanoutId).toBe(published.fanoutId);

  // A acks (its wake runs and records) while B's staged copy stays untouched.
  await eventually(() => provider.requests.length === 3); // A's wake
  await eventually(
    async () =>
      (await a.call('receipt', { bindingId: aid, eventId: 'ack-race' })).delivery.observation?.evidence ===
      'file-entry',
  );
  const bStatus = await import('node:fs').then((fs) => {
    const handleFile = join(home, 'targets', b.ready.fingerprint, 'bindings', bid, 'handle.json');
    const spoolDir = JSON.parse(fs.readFileSync(handleFile, 'utf8')).spoolDir;
    const pending = join(spoolDir, 'pending');
    const files = fs.readdirSync(pending);
    return { spoolDir, files };
  });
  expect(bStatus.files).toHaveLength(1); // B's copy retained on disk (M08)

  // B returns as a new generation and claims its own copy — A's ack consumed nothing.
  b = await spawn({ ...args('b'), sessionFile: bFile });
  await control(b, bid, { action: 'resume', holdReason: 'recovery' });
  await control(b, bid, { action: 'resume', holdReason: 'foreground-changed' });
  await arm(b, bid);
  await eventually(() => provider.requests.length === 4); // B's own wake
  await eventually(
    async () =>
      (await b.call('receipt', { bindingId: bid, eventId: 'ack-race' })).delivery.observation?.evidence ===
      'file-entry',
  );
}, 60000);

it('[M11 M16] a busy subscriber never starves an armed peer; dual wakes dedupe under replay', async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-e2e-')));
  const home = join(root, 'state');
  provider = await providerFixture({ delayMs: 400 });
  const config = {
    version: 1,
    sourceId: 'exec',
    realm: 'test',
    home,
    ownerToken: secret(),
    publisherTokens: { X: secret() },
    channels: [{ id: 'X', types: BUILTIN_TYPES, allowedModes: ['display', 'resume'], maxAutoTargets: 2 }],
  };
  const source = await spawn({ role: 'source', config });
  const args = (i) => ({ role: 'pi', home, cwd: join(root, i), url: provider.url });
  const a = await spawn(args('a'));
  const b = await spawn(args('b'));
  const bind = async (c) => c.call('bind', { invite: await source.call('invite', { channelId: 'X' }) });
  const aid = await bind(a);
  const bid = await bind(b);
  const control = (c, id, command) => c.call('control', { bindingId: id, command });
  const arm = (c, id, claims = 1) =>
    control(c, id, { action: 'arm', grant: { eventTypes: ['process.exited.v1'], maxClaims: claims, ttlMs: 600000 } });
  await arm(a, aid);
  await arm(b, bid);

  // A is the slow subscriber: its own turn is streaming when the event arrives.
  const slow = a.call('prompt', { text: 'slow subscriber turn' });
  await eventually(() => provider.requests.length === 1);
  await source.call('publish', { value: event('dual') });
  // B is not starved: it wakes immediately while A is still busy.
  await eventually(() => provider.requests.length === 2);
  await eventually(
    async () =>
      (await b.call('receipt', { bindingId: bid, eventId: 'dual' })).delivery.observation?.evidence ===
      'file-entry',
  );
  await slow;
  // A's own prompt re-held its binding; its queued wake needs an explicit re-claim.
  await control(a, aid, { action: 'resume', holdReason: 'foreground-changed' });
  await arm(a, aid);
  await eventually(() => provider.requests.length === 3);
  await eventually(
    async () =>
      (await a.call('receipt', { bindingId: aid, eventId: 'dual' })).delivery.observation?.evidence ===
      'file-entry',
  );
  // Dual wake, single identity per target, and replay dedupes both.
  const ar = await a.call('receipt', { bindingId: aid, eventId: 'dual' });
  const br = await b.call('receipt', { bindingId: bid, eventId: 'dual' });
  expect(ar.delivery.deliveryId).not.toBe(br.delivery.deliveryId);
  await source.call('replay');
  await new Promise((r) => setTimeout(r, 400));
  expect(provider.requests).toHaveLength(3); // no duplicate wakes on either target
}, 60000);

it('[M17] a conflicting payload for the same eventId is a conflict across every publishing surface', async () => {
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
    channels: [{ id: 'X', types: BUILTIN_TYPES, allowedModes: ['display', 'resume'], maxAutoTargets: 2 }],
  };
  const source = await spawn({ role: 'source', config });
  const handle = join(root, 'publisher.json');
  installPrivate(handle, source.ready.publisher);
  const input = join(root, 'm17.json');
  writeFileSync(input, JSON.stringify(event('m17-id', { exitCode: 0 })));
  const first = JSON.parse(
    (
      await exec(process.execPath, ['dist/cli/index.js', 'publish', '--source-file', handle, '--event-file', input], {
        cwd: process.cwd(),
      })
    ).stdout,
  );
  expect(first.sourceState).toBe('empty-audience'); // no subscribers bound: capture is still durable
  // SDK surface: different payload, same identity => id_conflict through the transport.
  await expect(source.call('publish', { value: event('m17-id', { exitCode: 5 }) })).rejects.toMatchObject({
    code: 'id_conflict',
  });
  // CLI surface: same conflict, classified exit code.
  const conflictInput = join(root, 'm17-conflict.json');
  writeFileSync(conflictInput, JSON.stringify(event('m17-id', { exitCode: 5 })));
  const conflict = await exec(process.execPath, [
    'dist/cli/index.js',
    'publish',
    '--source-file',
    handle,
    '--event-file',
    conflictInput,
  ]).catch((e) => e);
  expect(conflict.code).toBe(2);
  expect(JSON.parse(conflict.stderr).error.code).toBe('id_conflict');
  // The original fact is untouched: one capture, original payload retained.
  const still = await source.call('publish', { value: event('m17-id', { exitCode: 0 }) });
  expect(still.fanoutId).toBe(first.fanoutId);
}, 45000);

it('[M06] one CLI-published capture partitions accepted/staged/rejected across three real processes', async () => {
  // M06 at the frozen multi-process-e2e tier, with the scenario's literal
  // timing — C is revoked AFTER the capture commits but BEFORE dispatch —
  // enforced by a fault barrier that SIGSTOPs the Source Host process at
  // source.after_capture_commit. A is online, B's process is down (its staged
  // copy must survive on disk), the event itself is published by an external
  // CLI process.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-e2e-m06-')));
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
      { id: 'X', types: BUILTIN_TYPES, allowedModes: ['display', 'resume'], maxAutoTargets: 3 },
    ],
  };
  const source = await spawn({ role: 'source', config });
  const args = (i) => ({ role: 'pi', home, cwd: join(root, 'pi-' + i), url: provider.url });
  const a = await spawn(args('a'));
  const b = await spawn(args('b'));
  const c = await spawn(args('c'));
  const invite = () => source.call('invite', { channelId: 'X' });
  const aid = await a.call('bind', { invite: await invite() });
  const bid = await b.call('bind', { invite: await invite() });
  const cid = await c.call('bind', { invite: await invite() });
  // Arm A so the accepted route also exercises the real wake path.
  await a.call('control', {
    bindingId: aid,
    command: { action: 'arm', grant: { eventTypes: ['process.exited.v1'], maxClaims: 1, ttlMs: 600000 } },
  });
  // B warms up first (pi persists the session file only after a completed
  // assistant turn) and then goes offline; its staged copy must be importable.
  await b.call('prompt', { text: 'warm up so the session file persists' });
  const bFile = b.ready.file;
  await b.close();
  // Freeze the Source Host between capture-commit and dispatch.
  const barrier = join(root, 'm06-barrier');
  await source.call('armFault', { point: 'source.after_capture_commit', barrier });
  const handle = join(root, 'publisher.json'),
    input = join(root, 'event.json');
  installPrivate(handle, source.ready.publisher);
  writeFileSync(input, JSON.stringify(event('m06-three-way')));
  const publication = exec(
    process.execPath,
    ['dist/cli/index.js', 'publish', '--source-file', handle, '--event-file', input],
    { cwd: process.cwd() },
  );
  await eventually(() => existsSync(barrier));
  // Inside the frozen window: C revokes locally. The Source cannot learn yet
  // (it is SIGSTOPed), so the route stays captured — dispatch must discover
  // the revocation itself and record rejected/binding_revoked.
  await c.call('control', { bindingId: cid, command: { action: 'revoke' } });
  source.child.kill('SIGCONT');
  // The sealed CLI classification maps a rejected route in an otherwise
  // delivered fanout to exit code 4 — success here would be a defect, and a
  // vacuous non-zero check is not allowed (reviewer P1 fix).
  const { stdout, exitCode } = await publication.then(
    () => {
      throw new Error('CLI publish unexpectedly exited 0 on a rejected partition');
    },
    (e) => {
      if (e.stdout !== undefined) return { stdout: e.stdout, exitCode: e.code };
      throw e;
    },
  );
  expect(exitCode).toBe(4);
  const published = JSON.parse(stdout);
  expect(published.sourceState).toBe('source-staged');
  // The publication response itself must carry the same partition (publisher
  // responses omit binding ids, not dispositions — reviewer P1 fix).
  expect(published.routes.map((r) => r.admission).sort()).toEqual(['accepted', 'rejected', 'staged']);
  expect(published.routes.find((r) => r.admission === 'rejected').reason).toBe('binding_revoked');
  // The authoritative per-route partition (bindingId + rejection reason) comes
  // from the Source Host process once dispatch settles.
  const detailed = await eventually(async () => {
    const r = await source.call('fanoutResult', { eventId: 'm06-three-way' });
    if (!r.routes.some((x) => x.bindingId === cid && x.admission === 'rejected')) throw new Error('pending');
    return r;
  });
  const admission = Object.fromEntries(detailed.routes.map((r) => [r.bindingId, r.admission]));
  expect(admission[aid]).toBe('accepted');
  expect(admission[bid]).toBe('staged');
  expect(admission[cid]).toBe('rejected');
  // No global false success: the per-route partition is the only truth.
  expect(detailed.routes.map((r) => r.admission).sort()).toEqual(['accepted', 'rejected', 'staged']);
  expect(detailed.routes.find((r) => r.bindingId === cid).reason).toBe('binding_revoked');
  // The online route is real: A's receipt reaches file-entry evidence.
  await eventually(
    async () =>
      (await a.call('receipt', { bindingId: aid, eventId: 'm06-three-way' })).delivery.observation
        ?.evidence === 'file-entry',
  );
  // The staged route is real: B remounts its persisted session and imports the event.
  const b2 = await spawn({ ...args('b'), sessionFile: bFile });
  await eventually(async () => !!(await b2.call('receipt', { bindingId: bid, eventId: 'm06-three-way' })).acceptedAt);
  // The revoked route stays rejected: no receipt ever exists for C.
  await expect(c.call('receipt', { bindingId: cid, eventId: 'm06-three-way' })).rejects.toBeTruthy();
}, 30000);

it('[owner-takeover] a later session with the same fingerprint takes over; the earlier one detaches', async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-e2e-')));
  const home = join(root, 'state');
  provider = await providerFixture({ script: [{ text: 'ok' }, { text: 'ok' }, { text: 'ok' }] });
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
  const args = (i) => ({ role: 'pi', home, cwd: join(root, 'pi-' + i), url: provider.url });
  const a = await spawn(args('a'));
  // Warm up so the session file exists (pi persists it only after an assistant turn).
  await a.call('prompt', { text: 'warm A' });
  const file = a.ready.file;

  // B opens the SAME session file: same sessionId + same path = same
  // fingerprint. The takeover path must win ownership for B instead of
  // failing with owner_conflict.
  const b = await spawn({ ...args('b'), sessionFile: file });
  expect(b.ready.fingerprint).toBe(a.ready.fingerprint);

  // The durable token now names B's process as the owner.
  const { readOwnerToken } = await import('../../dist/platform/owner-lock.js');
  const token = readOwnerToken(join(home, 'targets', b.ready.fingerprint));
  expect(token.pid).toBe(b.child.pid);

  // A's supervisor stepped down: its store is closed, so further relay
  // operations on A fail instead of writing alongside B.
  await new Promise((r) => setTimeout(r, 800));
  await expect(a.call('bind', { invite: await source.call('invite', { channelId: 'X' }) })).rejects.toThrow();

  // B is the sole owner and can bind + arm normally.
  const bid = await b.call('bind', { invite: await source.call('invite', { channelId: 'X' }) });
  await b.call('control', {
    bindingId: bid,
    command: { action: 'arm', grant: { eventTypes: ['process.exited.v1'], maxClaims: 1, ttlMs: 600000 } },
  });
  const status = await b.call('status');
  expect(status.bindings.length).toBe(1);
}, 30000);

it('[owner-takeover] a publish during takeover is reconcilable, never terminally rejected', async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-e2e-')));
  const home = join(root, 'state');
  provider = await providerFixture({ script: [{ text: 'ok' }, { text: 'ok' }] });
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
  const args = (i) => ({ role: 'pi', home, cwd: join(root, 'pi-' + i), url: provider.url });
  const a = await spawn(args('a'));
  await a.call('prompt', { text: 'warm A' });
  const file = a.ready.file;
  const aid = await a.call('bind', { invite: await source.call('invite', { channelId: 'X' }) });

  // Challenge A with a live higher generation (a new session is taking over).
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const storeDir = join(home, 'targets', a.ready.fingerprint);
  mkdirSync(join(storeDir, 'owner-challenges'), { recursive: true });
  writeFileSync(
    join(storeDir, 'owner-challenges', 'incoming.json'),
    JSON.stringify({ generation: 99, pid: process.pid, at: Date.now(), deadline: Date.now() + 30_000 }),
  );
  // Dispatch while A is fenced: the route must not be terminally rejected.
  const captured = await source.call('publish', { value: event('takeover-mid') });
  const rows = (await source.call('fanoutResult', { eventId: 'takeover-mid' })).routes;
  const aRow = rows.find((r) => r.bindingId === aid);
  expect(aRow.admission).not.toBe('rejected');
  expect(['unknown', 'staged', 'pending-registration']).toContain(aRow.admission);

  // The real successor attaches (the synthetic challenge is withdrawn first —
  // B's own generation must not be evicted by it); the inherited binding
  // serves again.
  const { unlinkSync } = await import('node:fs');
  try { unlinkSync(join(storeDir, 'owner-challenges', 'incoming.json')); } catch {}
  const b = await spawn({ ...args('b'), sessionFile: file });
  expect(b.ready.fingerprint).toBe(a.ready.fingerprint);
  await new Promise((r) => setTimeout(r, 600));
  const captured2 = await source.call('publish', { value: event('takeover-after') });
  expect(captured2).toBeTruthy();
  const rows2 = (await source.call('fanoutResult', { eventId: 'takeover-after' })).routes;
  const bRow = rows2.find((r) => r.bindingId === aid);
  expect(bRow.admission).toBe('accepted');
}, 30000);
