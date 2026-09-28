import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childFixture } from '../fixtures/child.mjs';
import { providerFixture } from '../fixtures/provider.mjs';
import { event, eventually } from '../fixtures/system.mjs';
import { BUILTIN_TYPES } from '../../dist/source/index.js';
import { secret } from '../../dist/protocol/index.js';

let root, provider, children = [];
afterEach(async () => {
  for (const c of children.reverse()) await c.close();
  children = [];
  await provider?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  root = provider = undefined;
});
async function spawn(args) {
  const c = await childFixture(args);
  children.push(c);
  return c;
}
const control = (t, id, command) => t.call('control', { bindingId: id, command });
const arm = (t, id, claims = 1) =>
  control(t, id, {
    action: 'arm',
    grant: { eventTypes: ['process.exited.v1'], maxClaims: claims, ttlMs: 600000 },
  });
const deliveryEntries = (file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.includes('pi-relay.delivery.v1')).length;

// L08 remediation: the crash window between invoking Pi and persisting the
// submission. Recovery must reconcile against session-file evidence instead of
// blindly resending.
it('[L08] SIGKILL after invoke but before the store update reconciles from evidence, never blind-resends', async () => {
  root = mkdtempSync(join(tmpdir(), 'relay-l08-'));
  provider = await providerFixture();
  const home = join(root, 'state');
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
  const args = { role: 'pi', home, cwd: join(root, 'a'), url: provider.url };
  let target = await spawn(args);
  await target.call('prompt', { text: 'flush session before binding' }); // request 1, no holds on the later binding
  const file = target.ready.file;
  const id = await target.call('bind', { invite: await source.call('invite', { channelId: 'X' }) });
  await arm(target, id, 2);

  // Crash exactly between sendMessage() returning and core.invoked() committing.
  const barrier = join(root, 'invoke-barrier');
  await target.call('armFault', { point: 'pi.after_invoke_before_store_update', barrier });
  const publication = source.call('publish', { value: event('invoke-crash') }).catch(() => undefined);
  await eventually(() => existsSync(barrier));
  const requestsAtCrash = provider.requests.length;
  await target.kill();
  await publication;
  expect(deliveryEntries(file)).toBe(0); // no session-file evidence was flushed
  expect(requestsAtCrash).toBeLessThanOrEqual(2); // at most the wake turn barely started

  // Reopen: the epoch recovery downgrades the uncommitted intent to unknown
  // (never 'recorded'), and nothing resends on its own.
  target = await spawn({ ...args, sessionFile: file });
  const crashed = await target.call('receipt', { bindingId: id, eventId: 'invoke-crash' });
  expect(['unknown', 'held']).toContain(crashed.delivery.disposition);
  expect(crashed.delivery.observation).toBeUndefined(); // no fabricated evidence
  await control(target, id, { action: 'resume', holdReason: 'recovery' });
  await new Promise((r) => setTimeout(r, 300));
  expect(provider.requests.length).toBeLessThanOrEqual(requestsAtCrash); // no blind resend
  expect(deliveryEntries(file)).toBe(0);

  // The owner reconciles explicitly: no file evidence => skip replay, unblock.
  // (Resolve before re-arming: every control cut bumps the binding revision,
  // and a grant only claims against the revision it was armed at.)
  await control(target, id, {
    action: 'resolve-unknown',
    deliveryId: crashed.delivery.deliveryId,
    resolution: 'skip-replay-and-unblock',
  });
  await arm(target, id);
  // The queue is unblocked for the NEXT event, and the crashed one never wakes.
  await source.call('publish', { value: event('after-resolve') });
  await eventually(() => provider.requests.length === requestsAtCrash + 1);
  await eventually(
    async () =>
      (await target.call('receipt', { bindingId: id, eventId: 'after-resolve' })).delivery.observation
        ?.evidence === 'file-entry',
  );
  const final = await target.call('receipt', { bindingId: id, eventId: 'invoke-crash' });
  expect(final.delivery.observation).toBeUndefined(); // skipped: still no fabricated delivery
  expect(deliveryEntries(file)).toBe(1); // exactly the one legitimate delivery
}, 45000);
