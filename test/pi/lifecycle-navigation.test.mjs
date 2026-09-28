import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { piFixture } from '../fixtures/pi.mjs';
import { providerFixture } from '../fixtures/provider.mjs';
import { event, eventually } from '../fixtures/system.mjs';
import { createSource, BUILTIN_TYPES } from '../../dist/source/index.js';
import { secret, newId } from '../../dist/protocol/index.js';

let root, source, provider, fixtures = [];
afterEach(async () => {
  for (const f of fixtures.reverse()) await f?.close();
  fixtures = [];
  await source?.close();
  await provider?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  root = source = provider = undefined;
});
async function setup(options = {}) {
  root = mkdtempSync(join(tmpdir(), 'relay-pi-nav-'));
  const cwd = join(root, 'pi');
  mkdirSync(cwd, { mode: 0o700 });
  provider = await providerFixture(options);
  const pi = await piFixture({ home: join(root, 'state'), cwd, url: provider.url, ...options });
  fixtures.push(pi);
  source = await createSource({
    version: 1,
    sourceId: 'exec',
    realm: 'test',
    home: join(root, 'state'),
    ownerToken: secret(),
    publisherTokens: { X: secret() },
    channels: [{ id: 'X', types: BUILTIN_TYPES, allowedModes: ['display', 'resume'], maxAutoTargets: 2 }],
  });
  return pi;
}
const invite = () =>
  source.core.createInvite({
    operationId: newId('i'),
    channelId: 'X',
    ttlMs: 600000,
    bindingTtlMs: 3600000,
    allowResume: true,
  });
const bindOn = (pi, resume = true) => pi.host.bind(invite(), { resume });
const controlOn = (pi, id, action, extra = {}) =>
  pi.host.core.control(id, {
    operationId: newId('op'),
    expectedRevision: pi.host.core.binding(id).revision,
    action,
    ...extra,
  });
const armOn = (pi, id, claims = 1) =>
  controlOn(pi, id, 'arm', {
    grant: { eventTypes: ['process.exited.v1'], maxClaims: claims, ttlMs: 600000 },
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userEntries = (pi) =>
  pi.manager.getEntries().filter((e) => e.type === 'message' && e.message?.role === 'user');

it('[L11] a new session never receives another session’s late event; the original inbox keeps it', async () => {
  const a = await setup();
  const id = await bindOn(a);
  armOn(a, id);
  await source.core.publish('X', event('warm'));
  await eventually(() => provider.requests.length === 1);
  await eventually(
    () => a.host.core.receipt(id, 'warm').delivery.observation?.evidence === 'file-entry',
  );
  const fileA = a.manager.getSessionFile();
  const fpA = a.host.core.options.fingerprint;
  await a.close();

  // A different session on the same relay home is a different target identity.
  const cwdB = join(root, 'pi-b');
  mkdirSync(cwdB, { mode: 0o700 });
  const b = await piFixture({ home: join(root, 'state'), cwd: cwdB, url: provider.url });
  fixtures.push(b);
  expect(b.host.core.options.fingerprint).not.toBe(fpA);
  expect(b.host.core.status().bindings).toHaveLength(0);

  await source.core.publish('X', event('late-a')); // A offline → staged for A; B is not a member
  await sleep(200);
  expect(provider.requests).toHaveLength(1); // nothing delivered to B
  expect(b.errors).toEqual([]);
  await b.close();

  // A returns with its own session file: its inbox retained the event (outbox/inbox responsibility).
  const a2 = await piFixture({
    home: join(root, 'state'),
    cwd: join(root, 'pi'),
    url: provider.url,
    sessionFile: fileA,
  });
  fixtures.push(a2);
  expect(a2.host.core.holds(id)).toContain('recovery');
  controlOn(a2, id, 'resume', { holdReason: 'recovery' });
  armOn(a2, id);
  await eventually(() => provider.requests.length === 2);
  await eventually(
    () => a2.host.core.receipt(id, 'late-a').delivery.observation?.evidence === 'file-entry',
  );
}, 20000);

it('[L13] fork creates a fresh session identity that inherits no bindings or credentials', async () => {
  const parent = await setup();
  await parent.session.prompt('seed turn'); // a real turn so the session file has content to fork
  const id = await bindOn(parent);
  const file = parent.manager.getSessionFile();
  const forkDir = join(root, 'pi-fork');
  mkdirSync(forkDir, { mode: 0o700 });
  const forked = SessionManager.forkFrom(file, forkDir, join(forkDir, 'sessions'));
  const child = await piFixture({
    home: join(root, 'state'),
    cwd: forkDir,
    url: provider.url,
    sessionFile: forked.getSessionFile(),
  });
  fixtures.push(child);
  expect(child.host.core.options.fingerprint).not.toBe(parent.host.core.options.fingerprint);
  expect(child.host.core.status().bindings).toHaveLength(0);
  const credential = parent.host.core.handle(id).credential;
  expect(JSON.stringify(child.host.core.status())).not.toContain(credential);
  expect(child.manager.getSessionFile() && true).toBe(true);

  await source.core.publish('X', event('fork-time'));
  await sleep(200);
  expect(provider.requests).toHaveLength(1); // only the seed turn; no wake reached the fork
  expect(child.errors).toEqual([]);
}, 20000);

it('[L14] tree navigation to a common ancestor pauses model delivery until explicitly re-claimed', async () => {
  const pi = await setup();
  await pi.session.prompt('pre-origin turn'); // request 1
  const id = await bindOn(pi);
  armOn(pi, id);
  await pi.session.prompt('post-origin turn'); // request 2; also foreground input
  const target = userEntries(pi).at(-1); // branch point after the origin anchor
  await pi.session.navigateTree(target.id);
  expect(pi.host.core.holds(id)).toContain('navigation');

  await source.core.publish('X', event('ancestor-hold'));
  await sleep(200);
  expect(provider.requests).toHaveLength(2); // paused: ancestor relation alone does not deliver

  // Foreground input from the prompts added its own hold and deactivated the grant;
  // clearing navigation alone is not enough — delivery resumes only after both are
  // explicitly re-claimed and a fresh grant is armed at the current epoch.
  controlOn(pi, id, 'resume', { holdReason: 'navigation', approveCurrentBranch: true });
  armOn(pi, id);
  await sleep(200);
  expect(provider.requests).toHaveLength(2);
  controlOn(pi, id, 'resume', { holdReason: 'foreground-changed' });
  armOn(pi, id);
  await eventually(() => provider.requests.length === 3);
  await eventually(
    () => pi.host.core.receipt(id, 'ancestor-hold').delivery.observation?.evidence === 'file-entry',
  );
}, 20000);

it('[L15] tree navigation before the origin anchor never auto-delivers to the new branch', async () => {
  const pi = await setup();
  await pi.session.prompt('before-the-task'); // request 1
  await pi.session.prompt('second turn'); // request 2
  const id = await bindOn(pi);
  armOn(pi, id);
  await pi.session.prompt('origin turn'); // request 3
  const earliest = userEntries(pi)[0]; // branch predating the origin anchor
  await pi.session.navigateTree(earliest.id);
  expect(pi.host.core.holds(id)).toContain('navigation');

  await source.core.publish('X', event('pre-origin-ev'));
  await sleep(200);
  expect(provider.requests).toHaveLength(3); // no auto delivery onto the new branch

  // The pause is the navigation hold itself, not a side effect of foreground input:
  // clear foreground-changed and re-arm, and the navigation hold alone still blocks.
  controlOn(pi, id, 'resume', { holdReason: 'foreground-changed' });
  armOn(pi, id);
  await sleep(200);
  expect(provider.requests).toHaveLength(3);
  expect(pi.host.core.holds(id)).toContain('navigation');
  expect(pi.host.core.receipt(id, 'pre-origin-ev').delivery.deliveryId).toBeUndefined();
}, 20000);

it('[L21] a copied session file is a distinct identity; association only through an explicit invite', async () => {
  const original = await setup();
  const id = await bindOn(original);
  armOn(original, id);
  await source.core.publish('X', event('warm'));
  await eventually(() => provider.requests.length === 1);
  const file = original.manager.getSessionFile();
  const fp = original.host.core.options.fingerprint;
  await original.close();

  const copyDir = join(root, 'pi-copy');
  mkdirSync(copyDir, { mode: 0o700 });
  const copied = join(copyDir, 'copied-session.jsonl');
  copyFileSync(file, copied);
  const copy = await piFixture({
    home: join(root, 'state'),
    cwd: copyDir,
    url: provider.url,
    sessionFile: copied,
  });
  fixtures.push(copy);
  expect(copy.host.core.options.fingerprint).not.toBe(fp); // ambiguous identity refused: copy does not follow
  expect(copy.host.core.status().bindings).toHaveLength(0);

  // Owner re-association is explicit: a fresh invite produces a new binding for the copy.
  const id2 = await bindOn(copy);
  expect(id2).not.toBe(id);
  const memberships = await source.core.store.all('SELECT binding,state FROM memberships');
  const states = Object.fromEntries(memberships.map((m) => [m.binding, m.state]));
  expect(states[id]).toBe('active'); // original untouched
  expect(states[id2]).toBe('active');
}, 20000);

it('[L24] bare abort and Esc-style clear-then-abort never retract relay deliveries', async () => {
  const pi = await setup({ delayMs: 250 });
  const id = await bindOn(pi);
  armOn(pi, id, 4);
  await source.core.publish('X', event('committed'));
  await eventually(
    () => pi.host.core.receipt(id, 'committed').delivery.observation?.evidence === 'file-entry',
  );

  // Bare abort mid-turn: the core abort does not touch relay delivery state.
  const run = pi.session.prompt('long turn'); // request 2
  await eventually(() => pi.session.isStreaming);
  await pi.session.abort();
  await run;
  expect(pi.host.core.receipt(id, 'committed').delivery.disposition).toBe('recorded');

  // Esc shape: clearQueue then abort. The bridge offers no per-item retraction by design.
  const run2 = pi.session.prompt('second turn'); // request 3
  await eventually(() => pi.session.isStreaming);
  pi.session.clearQueue();
  await pi.session.abort();
  await run2;
  expect(pi.host.core.receipt(id, 'committed').delivery.disposition).toBe('recorded');

  // Abort and other foreground input are never a non-delivery verdict: later auto-wakes
  // are held under inspectable reasons (foreground input also deactivates the grant)
  // instead of the relay treating anything as undelivered.
  expect(pi.host.core.holds(id)).toEqual(expect.arrayContaining(['foreground-changed', 'host-aborted']));
  await source.core.publish('X', event('after-abort'));
  await sleep(200);
  expect(provider.requests).toHaveLength(3);
  expect(pi.host.core.receipt(id, 'committed').delivery.disposition).toBe('recorded');

  // Explicit re-claim of both abort-related holds restores delivery; nothing was lost.
  controlOn(pi, id, 'resume', { holdReason: 'foreground-changed' });
  controlOn(pi, id, 'resume', { holdReason: 'host-aborted' });
  armOn(pi, id);
  await eventually(() => provider.requests.length === 4);
  await eventually(
    () => pi.host.core.receipt(id, 'after-abort').delivery.observation?.evidence === 'file-entry',
  );
  expect(pi.errors).toEqual([]);
}, 20000);

it('[L24] queued followUp/nextTurn matrix: pending wakes wait for settle; abort holds, never retracts', async () => {
  const pi = await setup({ delayMs: 250 });
  const id = await bindOn(pi);
  await pi.session.prompt('first turn'); // persists the session and adds holds
  controlOn(pi, id, 'resume', { holdReason: 'recovery' });
  controlOn(pi, id, 'resume', { holdReason: 'foreground-changed' });
  armOn(pi, id, 2);

  // Mode 1 — queued during streaming: the wake attempt stays pending in the
  // target store (claim requires idle) and the user turn re-held the binding
  // and deactivated the grant. After graceful settle, one explicit re-claim
  // fires the queued wake as the followUp/nextTurn — nothing was dropped.
  const run = pi.session.prompt('long turn');
  await eventually(() => pi.session.isStreaming);
  await source.core.publish('X', event('queued-graceful'));
  await sleep(150);
  expect(provider.requests).toHaveLength(2); // 1 = first turn, still streaming: no wake yet
  await run; // graceful settle
  await sleep(150);
  expect(provider.requests).toHaveLength(2); // still gated by the turn's foreground-changed hold
  controlOn(pi, id, 'resume', { holdReason: 'foreground-changed' });
  armOn(pi, id);
  await eventually(() => provider.requests.length === 3); // queued followUp fired as nextTurn
  await eventually(
    () => pi.host.core.receipt(id, 'queued-graceful').delivery.observation?.evidence === 'file-entry',
  );
  await eventually(() => !pi.session.isStreaming); // let the auto nextTurn settle

  // Mode 2 — queued during streaming, then bare abort: the pending wake is NOT
  // auto-fired, NOT dropped, and never counted as undelivered; it waits for an
  // explicit re-claim of the abort hold.
  controlOn(pi, id, 'resume', { holdReason: 'foreground-changed' }); // the second prompt re-held
  armOn(pi, id, 2);
  const run2 = pi.session.prompt('second turn'); // request 4
  await eventually(() => pi.session.isStreaming);
  // Deterministic gate: the turn's foreground hold must land before publishing.
  await eventually(() => pi.host.core.holds(id).includes('foreground-changed'));
  await source.core.publish('X', event('queued-abort'));
  await sleep(150);
  expect(provider.requests).toHaveLength(4); // still pending: no claim while streaming
  await pi.session.abort();
  await run2;
  await eventually(() => pi.host.core.holds(id).includes('host-aborted'));
  await sleep(150);
  expect(provider.requests).toHaveLength(4); // abort does not auto-fire the queued wake
  expect(pi.host.core.holds(id)).toEqual(expect.arrayContaining(['host-aborted']));
  const held = pi.host.core.receipt(id, 'queued-abort').delivery;
  expect(held.disposition).toBe('held');
  expect(held.holdReasons).toEqual(expect.arrayContaining(['host-aborted']));
  // Explicit re-claim: the queued wake then delivers — nothing was lost or retracted.
  controlOn(pi, id, 'resume', { holdReason: 'foreground-changed' });
  controlOn(pi, id, 'resume', { holdReason: 'host-aborted' });
  armOn(pi, id);
  await eventually(() => provider.requests.length === 5);
  await eventually(
    () => pi.host.core.receipt(id, 'queued-abort').delivery.observation?.evidence === 'file-entry',
  );
  await eventually(() => !pi.session.isStreaming); // let the reclaimed wake settle

  // Mode 3 — already submitted followUp vs Esc shape: clearQueue+abort cannot
  // retract a submitted relay delivery either; the record stays non-retracted.
  const run3 = pi.session.prompt('third turn'); // request 6
  await eventually(() => pi.session.isStreaming);
  await eventually(() => pi.host.core.holds(id).includes('foreground-changed'));
  await source.core.publish('X', event('esc-target'));
  await run3;
  await sleep(150);
  expect(provider.requests).toHaveLength(6); // Esc shape: pending wake not auto-fired yet
  controlOn(pi, id, 'resume', { holdReason: 'foreground-changed' });
  armOn(pi, id);
  await eventually(() => provider.requests.length === 7); // followUp submitted as nextTurn
  await eventually(() => pi.session.isStreaming);
  pi.session.clearQueue();
  await pi.session.abort();
  await eventually(() => !pi.session.isStreaming);
  const esc = pi.host.core.receipt(id, 'esc-target').delivery;
  expect(['recorded', 'submitted']).toContain(esc.disposition); // no retraction verdict exists
  expect(pi.errors).toEqual([]);
}, 30000);
