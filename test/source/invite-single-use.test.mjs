import { it, expect, afterEach } from 'vitest';
import { system, event } from '../fixtures/system.mjs';
import { newId } from '../../dist/protocol/index.js';

let world;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

it('[S1] one single-use invite cannot be consumed by two concurrent enrolls', async () => {
  world = await system({ targets: 2, maxAutoTargets: 2 });
  const invite = world.source.core.createInvite({
    operationId: newId('invite'),
    channelId: 'X',
    ttlMs: 600000,
    bindingTtlMs: 3600000,
    allowResume: true,
  });
  // Distinct targets (different fingerprints) and distinct operationIds, fired
  // concurrently so both probes interleave before either commit: only one may win.
  const settled = await Promise.allSettled([
    world.target[0].bind(invite, { operationId: newId('bind'), resume: true }),
    world.target[1].bind(invite, { operationId: newId('bind'), resume: true }),
  ]);
  const fulfilled = settled.filter((s) => s.status === 'fulfilled');
  const rejected = settled.filter((s) => s.status === 'rejected');
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(rejected[0].reason.code).toBe('unauthorized');

  const rows = world.source.core.store.all("SELECT binding,state FROM memberships WHERE channel='X'");
  expect(rows.filter((r) => r.state === 'active')).toHaveLength(1);
  const winner = fulfilled[0].value;
  expect(rows.find((r) => r.state === 'active').binding).toBe(winner);

  const inviteRow = world.source.core.store.get(
    'SELECT used_by FROM invites WHERE id=?',
    invite.inviteId,
  );
  expect(inviteRow.used_by).toBe(winner);

  // The channel still works normally for the winner afterwards.
  const winnerIndex = settled.findIndex((s) => s.status === 'fulfilled');
  const winnerTarget = world.target[winnerIndex];
  winnerTarget.core.control(winner, {
    operationId: newId('op'),
    expectedRevision: winnerTarget.core.binding(winner).revision,
    action: 'arm',
    grant: { eventTypes: ['process.exited.v1'], maxClaims: 1, ttlMs: 600000 },
  });
  world.source.core.publish('X', event('s1-after'));
}, 20000);
