import { describe, it, expect, afterEach } from 'vitest';
import fc from 'fast-check';
import { system, event, progress, idle } from '../fixtures/system.mjs';
import { digest } from '../../dist/protocol/index.js';
import { deliveryContent } from '../../dist/protocol/format.js';
import { createTarget } from '../../dist/target/host.js';
let f;
afterEach(async () => {
  await f?.close();
  f = undefined;
});
function entry(core, a, type = 'custom_message') {
  return {
    type,
    id: 'entry',
    customType: 'pi-relay.delivery.v1',
    content: deliveryContent(core.packet(a.bindingId, a.eventId), a.deliveryId),
    details: { ...a, namespace: 'pi-relay/delivery/v1', eventIds: [a.eventId] },
  };
}
describe('target state and control cuts', () => {
  it('[L01 L06 G01 G02 G22] immutable accepted receipt, paused admission, idempotent CAS control', async () => {
    f = await system();
    const id = await f.bind(0);
    const value = event('same');
    const r = await f.source.core.publish('X', value);
    expect(r.routes[0].admission).toBe('accepted');
    const before = f.target[0].core.receipt(id, 'same');
    const packet = f.target[0].core.packet(id, 'same');
    expect(f.target[0].core.admit(packet).duplicate).toBe(true);
    expect(f.target[0].core.receipt(id, 'same').acceptedAt).toBe(before.acceptedAt);
    await expect(f.source.core.publish('X', event('same', { exitCode: 1 }))).rejects.toThrowError(
      /identifier/,
    );
    f.arm(0, id);
    const command = { operationId: 'pause', expectedRevision: 2, action: 'pause' };
    const cut = f.target[0].core.control(id, command);
    expect(f.target[0].core.control(id, command)).toEqual(cut);
    expect(cut.prevented).toEqual(['same']);
    expect(f.target[0].core.claimOne(idle)).toBeUndefined();
    expect(() => f.target[0].core.control(id, { ...command, operationId: 'other' })).toThrowError(/revision/);
    await f.source.core.publish('X', event('while-paused'));
    expect(f.target[0].core.receipt(id, 'while-paused').acceptedAt).toBeGreaterThan(0);
  });
  it('[L05 L07 L09 G25] intent, unknown and post-submit cuts do not fake delivery or cancellation', async () => {
    f = await system();
    const id = await f.bind(0);
    f.arm(0, id, { maxClaims: 4 });
    await f.source.core.publish('X', event('first'));
    const core = f.target[0].core,
      a = core.claimOne(idle);
    expect(a).toBeDefined();
    core.unknown(a);
    await f.source.core.publish('X', event('second'));
    expect(core.claimOne(idle)).toBeUndefined();
    expect(core.receipt(id, 'first').delivery.disposition).toBe('unknown');
    f.control(0, id, 'resolve-unknown', { deliveryId: a.deliveryId, resolution: 'skip-replay-and-unblock' });
    f.arm(0, id);
    const next = core.claimOne(idle);
    expect(next.eventId).toBe('second');
    core.invoked(next);
    const revoke = f.control(0, id, 'revoke');
    expect(revoke.tooLate).toContain('second');
    expect(revoke.unknown).toContain('first');
    expect(core.receipt(id, 'second').delivery.submittedAt).toBeGreaterThan(0);
    expect(core.receipt(id, 'first').delivery.disposition).toBe('unknown');
  });
  it('[L23 G25] only strictly matching custom-message entries count as recorded', async () => {
    f = await system();
    const id = await f.bind(0);
    f.arm(0, id);
    await f.source.core.publish('X', event('e'));
    const core = f.target[0].core,
      a = core.claimOne(idle);
    core.invoked(a);
    expect(core.observe(entry(core, a, 'custom'), 'runtime-entry')).toBe(false);
    const forged = entry(core, a);
    forged.details.payloadDigest = 'bad';
    expect(core.observe(forged, 'runtime-entry')).toBe(false);
    expect(core.observe(entry(core, a), 'runtime-entry')).toBe(true);
    expect(core.receipt(id, 'e').delivery.observation.evidence).toBe('runtime-entry');
    expect(core.observe(entry(core, a), 'file-entry')).toBe(true);
    expect(core.receipt(id, 'e').delivery.observation.evidence).toBe('file-entry');
  });
  it('[L12 L16 L17 L18] holds, TTL, foreground and strict mode prevent claims, never cancel facts', async () => {
    let now = 100000;
    const clock = { now: () => now };
    f = await system({ clock });
    const id = await f.bind(0);
    f.arm(0, id);
    await f.source.core.publish('X', event('e'));
    const core = f.target[0].core;
    for (const e of [
      { ...idle, idle: false },
      { ...idle, pending: true },
      { ...idle, knownWait: true },
      { ...idle, strictNoAutoResume: true },
    ])
      expect(core.claimOne(e)).toBeUndefined();
    core.foregroundInput();
    expect(core.claimOne(idle)).toBeUndefined();
    f.control(0, id, 'resume', { holdReason: 'foreground-changed' });
    f.arm(0, id, { ttlMs: 1 });
    now += 2;
    expect(core.claimOne(idle)).toBeUndefined();
    expect(core.receipt(id, 'e').acceptedAt).toBe(100000);
  });
  it('[G03 G04 G17] progress is volatile, monotonically revised, bounded and independent of completion', async () => {
    f = await system();
    const id = await f.bind(0);
    const core = f.target[0].core;
    expect(core.admitProgress(id, progress(2)).outcome).toBe('buffered');
    expect(core.admitProgress(id, progress(1)).outcome).toBe('dropped');
    expect(() => core.admitProgress(id, progress(2, 'stream', 'different'))).toThrow();
    for (let i = 1; i < 16; i++) core.admitProgress(id, progress(1, 's' + i));
    expect(() => core.admitProgress(id, progress(1, 'overflow'))).toThrowError(/full/);
    await f.source.core.publish('X', event('done'));
    expect(core.receipt(id, 'done').acceptedAt).toBeGreaterThan(0);
    expect(core.store.get('SELECT count(*) n FROM events').n).toBe(1);
    expect(core.store.get('SELECT count(*) n FROM attempts').n).toBe(0);
  });
  it('[L10 L12 L25] reopening disarms, holds and cannot be deleted by stale cleanup', async () => {
    f = await system();
    const id = await f.bind(0);
    f.arm(0, id);
    const old = f.target[0];
    await old.close();
    const next = await createTarget(old.core.options);
    f.target[0] = next;
    await old.close();
    await f.source.core.publish('X', event('reopened'));
    expect(next.core.holds(id)).toContain('recovery');
    expect(next.core.claimOne(idle)).toBeUndefined();
    expect(next.core.store.get('SELECT count(*) n FROM grants WHERE active=1').n).toBe(0);
  });
  it('[G12 G24] quota refuses a new event without evicting or changing accepted facts', async () => {
    f = await system();
    const id = await f.bind(0, 'X', true);
    for (let i = 0; i < 100; i++) await f.source.core.publish('X', event('q' + i));
    const result = await f.source.core.publish('X', event('overflow'));
    expect(result.routes[0].reason).toBe('backpressure');
    expect(f.target[0].core.store.get('SELECT count(*) n FROM events').n).toBe(100);
    expect(f.target[0].core.receipt(id, 'q0').acceptedAt).toBeGreaterThan(0);
  });
  it('[I2 I5 I9 I11] randomized control/admission/claim interleavings preserve one attempt and revoke cut', async () => {
    f = await system();
    const id = await f.bind(0);
    const core = f.target[0].core;
    f.arm(0, id, { maxClaims: 100 });
    await f.source.core.publish('X', event('property'));
    const actions = fc.sample(
      fc.array(fc.constantFrom('pause', 'arm', 'resume', 'claim', 'input'), { minLength: 30, maxLength: 60 }),
      { numRuns: 1, seed: 42017 },
    )[0];
    let calls = 0;
    for (const action of actions) {
      if (action === 'claim') {
        const a = core.claimOne(idle);
        if (a) {
          calls++;
          core.invoked(a);
          core.observe(entry(core, a), 'runtime-entry');
        }
      } else if (action === 'input') core.foregroundInput();
      else if (action === 'arm') f.arm(0, id);
      else f.control(0, id, action);
      expect(calls).toBeLessThanOrEqual(1);
    }
    f.control(0, id, 'revoke');
    expect(core.claimOne(idle)).toBeUndefined();
    expect(core.store.get('SELECT count(*) n FROM events').n).toBe(1);
  });
});
it('[I2] grant expiry is rechecked at the final synchronous invoke boundary', async () => {
  let now = Date.now();
  f = await system({ targets: 1, clock: { now: () => now } });
  const id = await f.bind(0);
  f.arm(0, id, { ttlMs: 1 });
  await f.source.core.publish('X', event('deadline'));
  const attempt = f.target[0].core.claimOne(idle);
  expect(attempt).toBeTruthy();
  now += 2;
  expect(f.target[0].core.canInvoke(attempt, idle)).toBe(false);
});
