import { it, expect, afterEach } from 'vitest';
import { system, event, idle } from '../fixtures/system.mjs';
import { SourcePublisher, openSource, openBinding } from '../../dist/client/index.js';
import { secret } from '../../dist/protocol/index.js';
let f;
afterEach(async () => {
  await f?.close();
  f = undefined;
});
it('[M02 M09 M17 M20 G23] live membership snapshot and source-wide immutable identity survive retries', async () => {
  f = await system({ targets: 3 });
  const a = await f.bind(0),
    b = await f.bind(1);
  await f.bind(0, 'Y');
  const old = f.source.core.capture('X', event('snapshot'));
  const c = await f.bind(2);
  const result = await f.source.core.dispatch(old);
  expect(result.routes.map((r) => r.bindingId).sort()).toEqual([a, b].sort());
  expect(() => f.target[2].core.receipt(c, 'snapshot')).toThrow();
  const repeated = await f.source.core.publish('X', event('snapshot'));
  expect(repeated.fanoutId).toBe(result.fanoutId);
  await expect(f.source.core.publish('X', event('snapshot', { exitCode: 2 }))).rejects.toThrow();
  await f.source.core.publish('Y', event('other'));
  expect(f.target[0].core.list()).toHaveLength(2);
  await expect(f.bind(0)).rejects.toThrowError(/binding/);
});
it('[M03 M04 M05 M11 M16] one subscriber paused or revoked does not change another subscriber', async () => {
  f = await system();
  const a = await f.bind(0),
    b = await f.bind(1);
  f.control(0, a, 'pause');
  f.arm(1, b);
  let result = await f.source.core.publish('X', event('both'));
  expect(result.routes.every((r) => r.admission === 'accepted')).toBe(true);
  expect(f.target[0].core.claimOne(idle)).toBeUndefined();
  expect(f.target[1].core.claimOne(idle)).toBeDefined();
  f.control(0, a, 'revoke');
  result = await f.source.core.publish('X', event('only-b'));
  expect(result.routes.find((r) => r.bindingId === a).admission).toBe('rejected');
  expect(result.routes.find((r) => r.bindingId === b).admission).toBe('accepted');
  expect(f.source.core.store.get("SELECT closed FROM channels WHERE id='X'").closed).toBe(0);
});
it('[M06 M08 G07 G08] offline copies import independently, revoked offline subscriptions cannot revive', async () => {
  f = await system();
  const a = await f.bind(0),
    b = await f.bind(1);
  await f.target[1].close();
  const result = await f.source.core.publish('X', event('offline'));
  expect(result.routes.find((r) => r.bindingId === a).admission).toBe('accepted');
  expect(result.routes.find((r) => r.bindingId === b).admission).toBe('staged');
  const { createTarget } = await import('../../dist/target/host.js');
  f.target[1] = await createTarget(f.target[1].core.options);
  expect(f.target[0].import(a).accepted).toBe(1);
  expect(f.target[1].import(b).accepted).toBe(1);
  expect(f.target[1].core.receipt(b, 'offline').delivery.holdReasons).toContain('recovery');
  f.control(1, b, 'revoke');
  expect(f.target[1].import(b).accepted).toBe(0);
});
it('[M14 M20 G06] both owners consent; publisher is not source owner and capabilities do not cross scopes', async () => {
  f = await system();
  const handle = f.source.core.publisherHandle('X');
  const { rpc } = await openSource(handle);
  try {
    await expect(
      rpc.call({
        op: 'source.invite',
        operationId: 'bad',
        channelId: 'X',
        ttlMs: 1000,
        bindingTtlMs: 1000,
        allowResume: false,
      }),
    ).rejects.toThrowError(/Capability/);
    await expect(
      rpc.call({ op: 'source.publish', channelId: 'Y', value: event('bad') }),
    ).rejects.toThrowError(/Capability/);
    await expect(rpc.call({ op: 'source.status' })).rejects.toThrowError(/Capability/);
  } finally {
    rpc.dispose();
  }
  const a = await f.bind(0),
    b = await f.bind(1);
  await expect(
    openBinding({ ...f.target[0].core.handle(a), credential: f.target[1].core.handle(b).credential }),
  ).rejects.toThrowError(/Capability/);
});
it('[M12 M13 G18 G19 G21] unsupported egress and reply features are rejected, not advertised', async () => {
  f = await system();
  const id = await f.bind(0);
  for (const open of [
    () => openSource(f.source.core.ownerHandle()),
    () => openBinding(f.target[0].core.handle(id)),
  ]) {
    const { rpc, hello } = await open();
    try {
      expect(hello.features.some((x) => /egress|steer|reply|next-input/.test(x))).toBe(false);
      await expect(rpc.call({ op: 'egress', value: { stdin: 'arbitrary' } })).rejects.toThrowError(
        /External writes/,
      );
    } finally {
      rpc.dispose();
    }
  }
  await expect(openBinding(f.target[0].core.handle(id), ['steer'])).rejects.toThrowError(/not implemented/);
});
it('[M16] source fanout budget and target grants are independent, frozen and non-refundable', async () => {
  f = await system({ maxAutoTargets: 1 });
  const a = await f.bind(0),
    b = await f.bind(1);
  f.arm(0, a);
  f.arm(1, b);
  await expect(f.source.core.publish('X', event('required'), true)).rejects.toThrowError(/full/);
  await f.source.core.publish('X', event('budget'));
  const modes = [
    f.target[0].core.packet(a, 'budget').allowedModelModes,
    f.target[1].core.packet(b, 'budget').allowedModelModes,
  ];
  expect(modes.filter((m) => m.includes('resume'))).toHaveLength(1);
  const attempts = f.target.map((t) => t.core.claimOne(idle)).filter(Boolean);
  expect(attempts).toHaveLength(1);
  expect(f.source.core.store.get('SELECT count(*) n FROM reservations').n).toBe(1);
});
it('[G22 M03] source close/revoke controls have idempotent, monotone cuts', async () => {
  f = await system();
  await f.bind(0);
  const first = await f.source.core.control('X', 'close-X', 'close', 1);
  expect(await f.source.core.control('X', 'close-X', 'close', 1)).toEqual(first);
  await expect(f.source.core.publish('X', event('later'))).rejects.toThrowError(/Channel/);
  await f.source.core.publish('Y', event('still-open'));
  await f.source.core.control('X', 'revoke-X', 'revoke', 2);
  await f.source.core.control('X', 'close-again', 'close', 3);
  expect(f.source.core.store.get("SELECT revoked FROM channels WHERE id='X'").revoked).toBe(1);
});
