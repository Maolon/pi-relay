import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { piFixture } from '../fixtures/pi.mjs';
import { providerFixture } from '../fixtures/provider.mjs';
import { event, progress, eventually } from '../fixtures/system.mjs';
import { createSource, BUILTIN_TYPES } from '../../dist/source/index.js';
import { secret, newId } from '../../dist/protocol/index.js';

// Audit 2026-09-15 remediation: real-Pi-tier scenarios whose candidate tags
// asserted weaker tiers or different scenarios.
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
  root = mkdtempSync(join(tmpdir(), 'relay-pi-audit-'));
  const cwd = join(root, 'pi');
  mkdirSync(cwd, { mode: 0o700 });
  provider = await providerFixture({ ...options, delayMs: options.delayMs ?? 250 });
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
const bindOn = (pi) => pi.host.bind(invite(), { resume: true });
const controlOn = (pi, id, action, extra = {}) =>
  pi.host.core.control(id, {
    operationId: newId('op'),
    expectedRevision: pi.host.core.binding(id).revision,
    action,
    ...extra,
  });
const armOn = (pi, id, claims = 1) =>
  controlOn(pi, id, 'arm', { grant: { eventTypes: ['process.exited.v1'], maxClaims: claims, ttlMs: 600000 } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

it('[L04] a progress flood during a busy turn stays bounded and off the model; completion waits for policy', async () => {
  const pi = await setup();
  const id = await bindOn(pi);
  await pi.session.prompt('first turn'); // persists session, adds holds
  controlOn(pi, id, 'resume', { holdReason: 'recovery' });
  controlOn(pi, id, 'resume', { holdReason: 'foreground-changed' });
  armOn(pi, id);

  const run = pi.session.prompt('busy foreground work');
  await eventually(() => pi.session.isStreaming);
  // Flood while busy: many revisions across streams plus the durable completion.
  for (let i = 1; i <= 100; i++) await source.core.publish('X', progress(i, 'flood', 'tick-' + i));
  for (let s = 1; s <= 15; s++) await source.core.publish('X', progress(1, 'stream-' + s, 'open'));
  // The 17th concurrent stream exceeds the per-binding bound: bounded UI state.
  const overflow = await source.core
    .publish('X', progress(1, 'overflow', 'open'))
    .catch((e) => ({ code: e.code }));
  expect(JSON.stringify(overflow)).toContain('backpressure');
  await source.core.publish('X', event('flood-done'));
  await run; // the busy turn settles; its input re-held the binding and deactivated the grant
  controlOn(pi, id, 'resume', { holdReason: 'foreground-changed' });
  armOn(pi, id);

  // The completion was retained independently and delivered per policy after
  // settle (request 3: two user prompts precede the wake).
  await eventually(() => provider.requests.length === 3);
  await eventually(
    () => pi.host.core.receipt(id, 'flood-done').delivery.observation?.evidence === 'file-entry',
  );
  // Progress never entered the model context: the wake request itself is clean.
  const wakeRequest = JSON.stringify(provider.requests[2]);
  expect(wakeRequest).not.toContain('tick-'); // flood revisions never entered the model
  expect(wakeRequest).not.toContain('stream-');
  expect(wakeRequest).toContain('event=flood-done'); // the completion is the delivered fact
  expect(pi.errors).toEqual([]);
}, 30000);

it('[L16] ordinary user input during background wake work holds wake permission explicitly and cancels nothing', async () => {
  const pi = await setup();
  const id = await bindOn(pi);
  await pi.session.prompt('seed turn');
  controlOn(pi, id, 'resume', { holdReason: 'recovery' });
  controlOn(pi, id, 'resume', { holdReason: 'foreground-changed' });
  armOn(pi, id);

  await source.core.publish('X', event('bg-work'));
  await eventually(() => provider.requests.length === 2); // the background wake turn runs
  await eventually(() => pi.session.isStreaming);
  // Ordinary user input arrives while the background work is streaming.
  const queued = pi.session.prompt('user note during background work', { streamingBehavior: 'followUp' });
  await eventually(() => pi.host.core.holds(id).includes('foreground-changed'));
  // The external task is never claimed cancelled: its delivery stays recorded.
  await eventually(
    () => pi.host.core.receipt(id, 'bg-work').delivery.observation?.evidence === 'file-entry',
  );
  expect(pi.host.core.receipt(id, 'bg-work').delivery.disposition).toBe('recorded');
  // Wake permission is held for explicit foreground policy: a new event stays pending
  // until the owner resumes the hold and re-arms.
  await source.core.publish('X', event('after-input'));
  await sleep(300);
  expect(provider.requests.length).toBeLessThanOrEqual(3); // queued note turn at most; no auto wake
  expect(pi.host.core.receipt(id, 'after-input').delivery.disposition).toBe('held');
  await queued;
  await eventually(() => !pi.session.isStreaming);
  controlOn(pi, id, 'resume', { holdReason: 'foreground-changed' });
  armOn(pi, id);
  await eventually(() => provider.requests.length >= 3);
  await eventually(
    () => pi.host.core.receipt(id, 'after-input').delivery.observation?.evidence === 'file-entry',
  );
  expect(pi.errors).toEqual([]);
}, 30000);

it('[L18] compaction lifecycle gates claims: intermediate agent_end is not stable idle; failure holds honestly', async () => {
  const pi = await setup();
  const id = await bindOn(pi);
  await pi.session.prompt('seed turn');
  controlOn(pi, id, 'resume', { holdReason: 'recovery' });
  controlOn(pi, id, 'resume', { holdReason: 'foreground-changed' });
  armOn(pi, id, 2);
  await eventually(() => !pi.session.isStreaming);

  // An intermediate agent_end must NOT be treated as stable idle: while the
  // port is unsettled, a published event is not claimed.
  pi.port.settled = false; // as session_before_compact does
  await source.core.publish('X', event('during-compaction'));
  await sleep(250);
  expect(provider.requests).toHaveLength(1);
  expect(pi.host.core.receipt(id, 'during-compaction').delivery.disposition).toBe('pending');

  // A failed compaction is an honest host-aborted hold, never a silent resume.
  pi.session.extensionRunner.emit({ type: 'session_compact_failed' });
  await eventually(() => pi.host.core.holds(id).includes('host-aborted'));
  // Reconstruction (session_compact) re-schedules observation but does not
  // fabricate delivery; only an explicit re-claim delivers. The compacted
  // session settles afterwards (agent_settled), restoring stable-idle gating.
  pi.session.extensionRunner.emit({ type: 'session_compact' });
  pi.session.extensionRunner.emit({ type: 'agent_settled' });
  await sleep(200);
  expect(provider.requests).toHaveLength(1); // still gated by the abort hold
  controlOn(pi, id, 'resume', { holdReason: 'host-aborted' });
  armOn(pi, id);
  await eventually(() => provider.requests.length === 2);
  await eventually(
    () => pi.host.core.receipt(id, 'during-compaction').delivery.observation?.evidence === 'file-entry',
  );
  expect(pi.errors).toEqual([]);
}, 30000);

it('[L22] an ephemeral session\'s death never leaks events to the next session; unreachability is explicit', async () => {
  const pi = await setup();
  const id = await bindOn(pi); // bound without any model turn: nothing persisted yet
  const file = pi.manager.getSessionFile();
  await pi.close(); // the ephemeral session exits before its file ever exists
  fixtures = fixtures.filter((f) => f !== pi);
  expect(existsSync(file)).toBe(false); // explicitly unrecoverable: no session file was written

  // A brand-new session in the same home is a different identity.
  const next = await piFixture({ home: join(root, 'state'), cwd: join(root, 'pi2'), url: provider.url });
  mkdirSync(join(root, 'pi2'), { recursive: true, mode: 0o700 });
  fixtures.push(next);
  expect(next.host.core.options.fingerprint).not.toBe(pi.host.core.options.fingerprint);
  expect(next.host.core.list()).toHaveLength(0); // zero inheritance of bindings or credentials

  // The dead binding's event is captured and staged honestly for it, but the
  // new session can never receive it.
  const result = await source.core.publish('X', event('orphaned'));
  expect(result.routes.map((r) => r.bindingId)).toEqual([id]);
  await sleep(300);
  expect(provider.requests).toHaveLength(0); // nobody woke: the new session never sees the event
  expect(next.host.core.status().bindings).toHaveLength(0);
  // And the source records the audience truthfully: only the unreachable binding.
  const members = source.core.store.all('SELECT binding,state FROM memberships');
  expect(members).toEqual([{ binding: id, state: 'active' }]); // honest: not revoked, just unreachable
}, 30000);
