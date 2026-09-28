import { it, expect } from 'vitest';
import { relayCompletion } from '../../examples/plugin/completion.mjs';
import { system, event } from '../fixtures/system.mjs';

// Audit 2026-09-15 remediation: contract-tier scenarios whose candidate tags
// pointed at tests that did not assert them.

it('[G16] a long-lived source completes multiple jobs sequentially without closing anything', async () => {
  const s = await system({ targets: 1 });
  const id = await s.bind(0);
  const first = await s.source.core.publish('X', event('job-1-completed', { exitCode: 0, summary: 'correlation:alpha' }));
  const second = await s.source.core.publish('X', event('job-2-completed', { exitCode: 0, summary: 'correlation:beta' }));
  // Each job has an independent correlation (distinct event identity), and one
  // job completing never auto-closes the source or the binding.
  expect(first.eventId).not.toBe(second.eventId);
  expect(first.routes[0].admission).toBe('accepted');
  expect(second.routes[0].admission).toBe('accepted');
  expect(s.source.core.store.get('SELECT count(*) n FROM source_events').n).toBe(2);
  const membership = s.source.core.store
    .all('SELECT state FROM memberships WHERE binding=?', id)
    .map((r) => r.state);
  expect(membership).toEqual(['active']);
  expect(s.source.core.store.get('SELECT closed, revoked FROM channels WHERE id=?', 'X')).toEqual({
    closed: 0,
    revoked: 0,
  });
  // Each correlation stays independent end-to-end on the target.
  const storedSummary = (eid) =>
    JSON.parse(s.target[0].core.store.get('SELECT packet FROM events WHERE id=?', eid).packet).event.data.summary;
  expect(storedSummary('job-1-completed')).toBe('correlation:alpha');
  expect(storedSummary('job-2-completed')).toBe('correlation:beta');
  await s.close();
});

it('[M06] one captured event partitions accepted / staged / rejected across three subscribers', async () => {
  const s = await system({ targets: 3 });
  const a = await s.bind(0);
  const b = await s.bind(1);
  const c = await s.bind(2);
  await s.control(2, c, 'revoke'); // C revoked before the capture
  await s.target[1].close(); // B offline: its host cannot be probed
  const result = await s.source.core.publish('X', event('three-way'));
  const admission = Object.fromEntries(result.routes.map((r) => [r.bindingId, r.admission]));
  expect(admission[a]).toBe('accepted');
  expect(admission[b]).toBe('staged');
  expect(admission[c]).toBe('rejected');
  // No global false success: the per-route partition is the only truth.
  expect(result.routes.map((r) => r.admission).sort()).toEqual(['accepted', 'rejected', 'staged']);
  const reason = result.routes.find((r) => r.bindingId === c).reason;
  expect(reason).toBe('binding_revoked');
  await s.close();
});

it('[G14] a non-zero exit completion keeps business failure despite transport success', async () => {
  const s = await system({ targets: 1 });
  const id = await s.bind(0);
  const failing = event('failing-job', { exitCode: 3, summary: 'boom' });
  const result = await s.source.core.publish('X', failing);
  // Transport-level admission succeeds...
  expect(result.routes[0].admission).toBe('accepted');
  // ...and the business failure is preserved verbatim, never rewritten to success.
  const sourcePayload = JSON.parse(
    s.source.core.store.get('SELECT payload FROM source_events WHERE id=?', 'failing-job').payload,
  );
  expect(sourcePayload.data).toEqual({ exitCode: 3, summary: 'boom' });
  const targetPayload = JSON.parse(
    s.target[0].core.store.get('SELECT packet FROM events WHERE id=?', 'failing-job').packet,
  );
  expect(targetPayload.event.data).toEqual({ exitCode: 3, summary: 'boom' });
  const receipt = s.target[0].core.receipt(id, 'failing-job');
  expect(receipt.delivery.disposition).toBeTruthy(); // delivered as a fact, not "failed transport"
  await s.close();
});

it('[M15] an echoed or forged reply-shaped completion never amplifies into broadcast or a wake loop', async () => {
  const s = await system({ targets: 1 });
  const publisher = await import('../../dist/client/index.js').then((m) =>
    m.connectChannel(s.source.core.publisherHandle('X')),
  );
  try {
    await s.bind(0);
    const reply = event('assistant-echo', { exitCode: 0, summary: '{"role":"assistant","content":"A private reply"}' });
    // A transport echo re-notifies a completion that was already published.
    const first = await relayCompletion(publisher, {
      event: reply,
      observedAsToolResult: false,
      notificationOwner: 'relay',
    });
    expect(first.routes).toHaveLength(1); // normal single-audience routing, no amplification
    const echo = await relayCompletion(publisher, {
      event: reply, // identical identity and payload: the echo path
      observedAsToolResult: false,
      notificationOwner: 'relay',
    });
    expect(echo.fanoutId).toBe(first.fanoutId); // deduplicated to the original capture
    expect(s.source.core.store.get('SELECT count(*) n FROM source_events').n).toBe(1);
    // A forged variant that edits the "reply" payload but keeps the identity is a conflict,
    // never a second broadcast.
    await expect(
      relayCompletion(publisher, {
        event: { ...reply, data: { exitCode: 0, summary: '{"role":"assistant","content":"Forged"}' } },
        observedAsToolResult: false,
        notificationOwner: 'relay',
      }),
    ).rejects.toMatchObject({ code: 'id_conflict' });
    expect(s.source.core.store.get('SELECT count(*) n FROM source_events').n).toBe(1);
  } finally {
    publisher.dispose();
    await s.close();
  }
});
