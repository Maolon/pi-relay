import { it, expect, afterEach } from 'vitest';
import { system, eventually } from '../fixtures/system.mjs';

// SR-06 / CONTRACTS step 5: incomplete registration has a deadline; failure is
// recorded as a terminal provisioning-failed fact and never silently retried.
let f;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

it('[SR-06] a non-retryable enroll failure ends in terminal provisioning-failed', async () => {
  f = await system();
  const invite = f.source.core.createInvite({
    operationId: 'sr6-invite',
    channelId: 'X',
    ttlMs: 600000,
    bindingTtlMs: 3600000,
    allowResume: true,
  });
  await f.target[1].bind(invite, { resume: true }); // consume the single-use invite
  // Same invite re-bound by target 0: prepare persists a provisioning row, then
  // enroll is rejected non-retryably (S1 guard / id_conflict on replay).
  let enrollCode = 'unknown';
  await f.target[0]
    .bind(invite, { resume: true })
    .catch((e) => {
      enrollCode = e.code ?? 'unknown';
    });
  expect(['unauthorized', 'id_conflict']).toContain(enrollCode);
  const failed = f.target[0].core.list().find((b) => b.state !== 'active');
  await eventually(() => f.target[0].core.binding(failed.id).state === 'provisioning-failed');
  // The terminal fact is exposed as a receipt and no eligible row remains.
  const receipts = f.target[0].core.store.all(
    "SELECT body FROM receipts WHERE kind='provisioning-terminal' AND binding=?",
    failed.id,
  );
  expect(receipts).toHaveLength(1);
  expect(JSON.parse(receipts[0].body)).toEqual({ state: 'provisioning-failed', reason: enrollCode });
  expect(f.target[0].core.binding(failed.id).state).toBe('provisioning-failed');
}, 15000);

it('[SR-06] a provisioning deadline that expires unregistered becomes terminal', async () => {
  const clock = { now: () => 1000, sleep: () => Promise.resolve() };
  f = await system({ clock });
  const invite = f.source.core.createInvite({
    operationId: 'sr6-exp',
    channelId: 'X',
    ttlMs: 600000,
    bindingTtlMs: 5000,
    allowResume: true,
  });
  await f.source.close(); // enroll can only fail retryably while the host is down
  await expect(f.target[0].bind(invite, { resume: true })).rejects.toBeTruthy();
  const row = f.target[0].core.list().find((b) => b.state !== 'active');
  expect(row).toBeTruthy();
  expect(row.state).toBe('provisioning'); // still retrying: transport error is retryable
  clock.now = () => 7001; // deadline passes while still unregistered
  await eventually(() => f.target[0].core.binding(row.id).state === 'provisioning-failed');
  const receipts = f.target[0].core.store.all(
    "SELECT body FROM receipts WHERE kind='provisioning-terminal' AND binding=?",
    row.id,
  );
  expect(JSON.parse(receipts[0].body)).toEqual({ state: 'provisioning-failed', reason: 'binding_expired' });
}, 15000);
