import { it, expect, afterEach } from 'vitest';
import { system, event } from '../fixtures/system.mjs';
import { newId } from '../../dist/protocol/index.js';

let world;
const source_publish = (id) => world.source.core.publish('X', event(id));
afterEach(async () => {
  await world?.close();
  world = undefined;
});
const inviteFor = (resume = true) => ({
  operationId: newId('invite'),
  channelId: 'X',
  ttlMs: 600000,
  bindingTtlMs: 3600000,
  allowResume: resume,
});
const routesOf = (eventId) =>
  world.source.core.store.all(
    'SELECT binding,packet FROM routes WHERE fanout=(SELECT fanout FROM source_events WHERE id=?)',
    eventId,
  );
const modeOf = (bindingId) => {
  const row = routesOf('alloc-ev1').find((r) => r.binding === bindingId);
  return row ? JSON.parse(row.packet).allowedModelModes : null;
};

it('[T02 T03] wake reservations follow presence recency, not binding age (F2 regression)', async () => {
  world = await system({ targets: 3, maxAutoTargets: 1 });
  const old1 = await world.target[0].bind(world.source.core.createInvite(inviteFor()), { resume: true });
  // A later enroll is the most recent presence confirmation: with budget 1 the
  // newest binding must win the reservation. (Pre-fix oldest-first gave old1.)
  const fresh = await world.target[1].bind(world.source.core.createInvite(inviteFor()), { resume: true });
  world.source.core.publish('X', event('alloc-ev1'));
  await new Promise((r) => setTimeout(r, 200));
  expect(modeOf(fresh)).toEqual(['display', 'resume']);
  expect(modeOf(old1)).toEqual(['display']);
  const packets = world.source.core.store.all(
    'SELECT binding,packet FROM routes WHERE fanout=(SELECT fanout FROM source_events WHERE id=?)',
    'alloc-ev1',
  );
  expect(
    packets.filter((r) => JSON.parse(r.packet).sourceWakeReservationId).map((r) => r.binding),
  ).toEqual([fresh]);
}, 20000);

it('[T02] an offline member loses its wake slot to online members regardless of age', async () => {
  world = await system({ targets: 3, maxAutoTargets: 2 });
  const a = await world.target[0].bind(world.source.core.createInvite(inviteFor()), { resume: true });
  const b = await world.target[1].bind(world.source.core.createInvite(inviteFor()), { resume: true });
  const c = await world.target[2].bind(world.source.core.createInvite(inviteFor()), { resume: true });
  await world.target[0].close(); // a goes offline: no presence stamps from now on
  const published = await source_publish('alloc-ev3');
  await new Promise((r) => setTimeout(r, 200));
  const rows = world.source.core.store.all(
    'SELECT binding,packet FROM routes WHERE fanout=(SELECT fanout FROM source_events WHERE id=?)',
    'alloc-ev3',
  );
  const modes = Object.fromEntries(
    rows.map((r) => [r.binding, JSON.parse(r.packet).allowedModelModes]),
  );
  expect(modes[c]).toEqual(['display', 'resume']);
  expect(modes[b]).toEqual(['display', 'resume']);
  expect(modes[a]).toEqual(['display']); // offline: its older presence loses the slot
  const aRoute = published.routes.find((r) => r.bindingId === a);
  expect(aRoute.admission).toBe('staged');
}, 20000);

it('[T02] the cap still binds when demand exceeds budget among equally recent targets', async () => {
  world = await system({ targets: 3, maxAutoTargets: 2 });
  await world.target[0].bind(world.source.core.createInvite(inviteFor()), { resume: true });
  await world.target[1].bind(world.source.core.createInvite(inviteFor()), { resume: true });
  await world.target[2].bind(world.source.core.createInvite(inviteFor()), { resume: true });
  const result = await world.source.core.publish('X', event('alloc-ev4'));
  await new Promise((r) => setTimeout(r, 200));
  const reserved = world.source.core.store
    .all(
      'SELECT packet FROM routes WHERE fanout=(SELECT fanout FROM source_events WHERE id=?)',
      'alloc-ev4',
    )
    .filter((r) => JSON.parse(r.packet).sourceWakeReservationId).length;
  expect(reserved).toBe(2);
  expect(result.routes).toHaveLength(3);
}, 20000);
