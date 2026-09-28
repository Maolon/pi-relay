import { it, expect } from 'vitest';
import { system, event } from '../fixtures/system.mjs';
import { deliveryContent } from '../../dist/protocol/format.js';
const idle = { idle: true, pending: false, knownWait: false, strictNoAutoResume: false };
const matchingEntry = (core, a) => ({
  type: 'custom_message',
  id: 'entry-' + a.deliveryId,
  customType: 'pi-relay.delivery.v1',
  content: deliveryContent(core.packet(a.bindingId, a.eventId), a.deliveryId),
  details: { ...a, namespace: 'pi-relay/delivery/v1', eventIds: [a.eventId] },
});

// G11 remediation: cursor reconnect semantics on the receipts surface.
it('[G11] receipt cursors reconnect with bounded replay and report cursor_expired, never silent skips', async () => {
  const s = await system({ targets: 1 });
  const id = await s.bind(0);
  // Two receipt rows per event (admission + submission) keep this under the
  // 100-event quota while producing >128 receipt rows.
  s.arm(0, id, { maxClaims: 100 });
  for (let i = 0; i < 50; i++) {
    await s.source.core.publish('X', event('cursor-' + i));
    const core0 = s.target[0].core,
      a = core0.claimOne(idle);
    core0.invoked(a); // admission + submission rows
    expect(core0.observe(matchingEntry(core0, a), 'runtime-entry')).toBe(true); // + recorded row, unblocks the queue
  }
  const total = s.target[0].core.store.get('SELECT count(*) n FROM receipts WHERE binding=?', id).n;
  expect(total).toBeGreaterThan(128);

  const core = s.target[0].core;
  // Bounded replay: a reconnecting consumer pages at most 128 updates at a time.
  const page1 = core.receipts(id, 0);
  expect(page1.updates).toHaveLength(128);
  expect(page1.cursor).toBe(128);
  const page2 = core.receipts(id, page1.cursor);
  expect(page2.updates.at(0).cursor).toBe(129); // no gap, no duplicate
  const finalCursor = core.cursor(id);
  const tail = core.receipts(id, finalCursor);
  expect(tail.updates).toEqual([]); // caught up: quiet, not fabricated

  // A cursor beyond the retained history (models future GC of low sequence
  // numbers) is reported explicitly instead of silently skipping rows.
  s.target[0].core.store.run('DELETE FROM receipts WHERE binding=? AND seq<?', id, 60);
  expect(() => core.receipts(id, 10)).toThrowError(/retained receipt history|cursor_expired/);
  const min = s.target[0].core.store.get('SELECT min(seq) n FROM receipts WHERE binding=?', id).n;
  expect(() => core.receipts(id, min - 1)).not.toThrow(); // exactly min-1 still reconnects
  // A cursor ahead of the log (stale future cursor after data loss) also reports.
  expect(() => core.receipts(id, finalCursor + 5)).toThrowError(/retained receipt history|cursor_expired/);
  await s.close();
});
