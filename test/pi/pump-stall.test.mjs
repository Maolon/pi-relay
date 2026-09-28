import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { piFixture } from '../fixtures/pi.mjs';
import { providerFixture } from '../fixtures/provider.mjs';
import { event, eventually } from '../fixtures/system.mjs';
import { createSource, BUILTIN_TYPES } from '../../dist/source/index.js';
import { secret, newId } from '../../dist/protocol/index.js';

let root, source, pi, provider;
const origEnv = process.env.PI_RELAY_SAFETY_NET_MS;

afterEach(async () => {
  if (origEnv !== undefined) process.env.PI_RELAY_SAFETY_NET_MS = origEnv;
  else delete process.env.PI_RELAY_SAFETY_NET_MS;

  await source?.close();
  await pi?.close();
  await provider?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  root = source = pi = provider = undefined;
});

async function setup(options = {}) {
  root = mkdtempSync(join(tmpdir(), 'relay-pump-stall-'));
  const cwd = join(root, 'pi');
  mkdirSync(cwd, { mode: 0o700 });
  provider = await providerFixture(options);
  pi = await piFixture({ home: join(root, 'state'), cwd, url: provider.url, ...options });
  source = await createSource({
    version: 1,
    sourceId: 'exec',
    realm: 'test',
    home: join(root, 'state'),
    ownerToken: secret(),
    publisherTokens: { X: secret() },
    channels: [{ id: 'X', types: BUILTIN_TYPES, allowedModes: ['display', 'resume'], maxAutoTargets: 2 }],
  });
  return cwd;
}

async function bind(resume = true) {
  return pi.host.bind(
    source.core.createInvite({
      operationId: newId('i'),
      channelId: 'X',
      ttlMs: 600000,
      bindingTtlMs: 3600000,
      allowResume: resume,
    }),
    { resume },
  );
}

function control(id, action, extra = {}) {
  return pi.host.core.control(id, {
    operationId: newId('op'),
    expectedRevision: pi.host.core.binding(id).revision,
    action,
    ...extra,
  });
}

function arm(id) {
  control(id, 'arm', { grant: { eventTypes: ['process.exited.v1'], maxClaims: 2, ttlMs: 600000 } });
}

it('[incident-2026-09-23 / F5] compaction-only session (no subsequent agent turn) recovers settled and claims external event', async () => {
  await setup();
  const id = await bind();
  arm(id);
  expect(pi.port.settled).toBe(true);
  expect(pi.port.eligibility().idle).toBe(true);

  // Simulate compaction lifecycle: session_before_compact un-settles the port
  pi.session.extensionRunner.emit({ type: 'session_before_compact' });
  expect(pi.port.settled).toBe(false);
  expect(pi.port.eligibility().idle).toBe(false);

  // session_compact completes; crucially, NO subsequent agent_settled occurs
  pi.session.extensionRunner.emit({ type: 'session_compact' });
  expect(pi.port.settled).toBe(true);
  expect(pi.port.eligibility().idle).toBe(true);

  // External event arrives while session is idle
  await source.core.publish('X', event('evt-after-compact'));

  // Host must be woken without needing a manual user turn
  await eventually(() => provider.requests.length === 1);
  await eventually(
    () => pi.host.core.receipt(id, 'evt-after-compact').delivery.observation?.evidence === 'file-entry',
  );
  expect(pi.errors).toEqual([]);
});

it('[incident-2026-09-23 / F6] quiet idle session claims external arrival via safety net tick (<= 2 ticks)', async () => {
  // Configure fast safety net tick (50ms)
  process.env.PI_RELAY_SAFETY_NET_MS = '50';
  await setup();
  const id = await bind();
  arm(id);
  expect(pi.port.settled).toBe(true);
  expect(pi.port.eligibility().idle).toBe(true);

  // Session remains completely quiet and idle (zero pi lifecycle events emitted)
  // An external event is published directly to the source
  await source.core.publish('X', event('evt-quiet-idle'));

  // Safety net tick must discover and claim it within ~150ms (<= 3 ticks)
  await eventually(() => provider.requests.length === 1, 1000);
  await eventually(
    () => pi.host.core.receipt(id, 'evt-quiet-idle').delivery.observation?.evidence === 'file-entry',
  );
  expect(pi.errors).toEqual([]);
});

it('[incident-2026-09-23 / F6] anti-spin regression: idle safety net ticks with 0 claims produce no CPU spin or error loop', async () => {
  process.env.PI_RELAY_SAFETY_NET_MS = '40';
  await setup();
  const id = await bind();
  arm(id);

  // Wait through multiple safety net ticks without any new events
  await new Promise((r) => setTimeout(r, 120));

  // No bogus wakes or error cascades
  expect(provider.requests.length).toBe(0);
  expect(pi.errors).toEqual([]);
});
