import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { piFixture } from '../fixtures/pi.mjs';
import { providerFixture } from '../fixtures/provider.mjs';
import { event, eventually } from '../fixtures/system.mjs';
import { createSource, BUILTIN_TYPES } from '../../dist/source/index.js';
import { secret, newId } from '../../dist/protocol/index.js';

// T04 of fix-wake-budget-v0.2.1: the previously starved offline path now wakes.
// The newest-bound target (latest presence confirmation) keeps its wake
// reservation while offline; restoring the same session and re-claiming
// delivers the event to the provider end-to-end.
let root, source, provider, fixtures = [];
afterEach(async () => {
  for (const f of fixtures.reverse()) await f?.close();
  fixtures = [];
  await source?.close();
  await provider?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  root = source = provider = undefined;
});
async function fixture(name, options = {}) {
  const cwd = join(root, name);
  mkdirSync(cwd, { mode: 0o700, recursive: true });
  const pi = await piFixture({ home: join(root, 'state'), cwd, url: provider.url, ...options });
  fixtures.push(pi);
  return pi;
}
const bindOn = (pi, resume = true) =>
  pi.host.bind(
    source.core.createInvite({
      operationId: newId('i'),
      channelId: 'X',
      ttlMs: 600000,
      bindingTtlMs: 3600000,
      allowResume: resume,
    }),
    { resume },
  );
const controlOn = (pi, id, action, extra = {}) =>
  pi.host.core.control(id, {
    operationId: newId('op'),
    expectedRevision: pi.host.core.binding(id).revision,
    action,
    ...extra,
  });

it('[T04] offline-staged route of the most recent binding wakes after restore', async () => {
  root = mkdtempSync(join(tmpdir(), 'relay-alloc-'));
  provider = await providerFixture();
  source = await createSource({
    version: 1,
    sourceId: 'exec',
    realm: 'test',
    home: join(root, 'state'),
    ownerToken: secret(),
    publisherTokens: { X: secret() },
    channels: [{ id: 'X', types: BUILTIN_TYPES, allowedModes: ['display', 'resume'], maxAutoTargets: 1 }],
  });

  const older = await fixture('older');
  const olderId = await bindOn(older); // earlier presence confirmation

  const victim = await fixture('victim'); // later enroll: most recent presence
  const victimId = await bindOn(victim);
  await victim.session.prompt('seed turn'); // persist the session file
  const file = victim.manager.getSessionFile();
  await victim.close();

  const published = await source.core.publish('X', event('alloc-off'));
  const victimRoute = published.routes.find((r) => r.bindingId === victimId);
  expect(victimRoute.admission).toBe('staged'); // offline at publish
  const packet = JSON.parse(
    source.core.store.get('SELECT packet FROM routes WHERE binding=?', victimId).packet,
  );
  // The F2 fix: this staged route must still carry the wake reservation.
  expect(packet.allowedModelModes).toEqual(['display', 'resume']);
  expect(packet.sourceWakeReservationId).toBeTruthy();

  const restored = await fixture('victim', { sessionFile: file });
  await eventually(() => restored.host.core.holds(victimId).includes('recovery'));
  controlOn(restored, victimId, 'resume', { holdReason: 'recovery' });
  controlOn(restored, victimId, 'resume', { holdReason: 'foreground-changed' }); // seed turn was foreground input
  controlOn(restored, victimId, 'arm', {
    grant: { eventTypes: ['process.exited.v1'], maxClaims: 1, ttlMs: 600000 },
  });
  await eventually(() => provider.requests.length === 1);
  await eventually(
    () =>
      restored.host.core.receipt(victimId, 'alloc-off').delivery.observation?.evidence ===
      'file-entry',
  );
}, 30000);
