import { it, expect, afterEach } from 'vitest';
import { system, event } from '../fixtures/system.mjs';
import { OPERATIONS_RETAINED } from '../../dist/store/database.js';
import { BindingClient } from '../../dist/client/index.js';
import { exitFor } from '../../dist/cli/exit.js';
import { LIMITS } from '../../dist/protocol/validate.js';

// Local-path reliability: bounded tables never wedge the connection, owner
// controls survive a full binding, and client connections never leak.

let f;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

it('operations keep a bounded idempotency window instead of refusing new operations', async () => {
  f = await system({ targets: 1 });
  const store = f.target[0].core.store;
  store.tx(() => {
    for (let i = 0; i < OPERATIONS_RETAINED + 5; i++) store.saveOperation('op-' + i, 'd', { i });
  });
  expect(store.get('SELECT count(*) n FROM operations').n).toBe(OPERATIONS_RETAINED);
  expect(store.operation('op-0', 'd')).toBeUndefined();
  expect(store.operation('op-' + (OPERATIONS_RETAINED + 4), 'd')).toEqual({ i: OPERATIONS_RETAINED + 4 });
  // A real control operation still commits and replays idempotently.
  const id = await f.bind(0);
  const command = { operationId: 'after-full', expectedRevision: f.target[0].core.binding(id).revision, action: 'disarm' };
  const cut = f.target[0].core.control(id, command);
  expect(f.target[0].core.control(id, command)).toEqual(cut);
});

it('managed operations record their idempotent result atomically with the mutation', async () => {
  f = await system({ targets: 0 });
  const owner = { kind: 'owner' };
  const init = { operationId: 'scope-init', scopeId: 's', expectedRevision: 0, nextRevision: 1, state: 'active' };
  const store = f.source.core.store;
  const save = store.saveOperation.bind(store);
  store.saveOperation = () => {
    throw new Error('disk full');
  };
  expect(() => f.source.managed.advanceScope(owner, init)).toThrow('disk full');
  // The scope mutation rolled back with the failed record, so a retry succeeds.
  expect(store.get("SELECT 1 FROM managed_scopes WHERE scope_id='s'")).toBeUndefined();
  store.saveOperation = save;
  expect(f.source.managed.advanceScope(owner, init)).toEqual({ revision: 1, state: 'active' });
  expect(f.source.managed.advanceScope(owner, init)).toEqual({ revision: 1, state: 'active' });
});

it('a binding at the receipt cap refuses new events but can still be revoked', async () => {
  f = await system({ targets: 1 });
  const id = await f.bind(0);
  f.target[0].core.store.run(
    'INSERT INTO receipts VALUES(?,?,?,?,?,?)',
    id,
    LIMITS.receiptsPerBinding,
    'filler',
    'filler',
    '{}',
    Date.now(),
  );
  const refused = await f.source.core.publish('X', event('over-cap'));
  expect(refused.routes[0].admission).not.toBe('accepted');
  f.control(0, id, 'revoke');
  expect(f.target[0].core.binding(id).authority).toBe('revoked');
});

it('a retryable admission failure exits 4 (backpressure), not 3 (policy)', () => {
  expect(
    exitFor({ outcome: 'rejected', error: { code: 'backpressure', message: 'full', retryable: true } }),
  ).toBe(4);
  expect(
    exitFor({ outcome: 'rejected', error: { code: 'unauthorized', message: 'no', retryable: false } }),
  ).toBe(3);
});

it('overlapping opens share one connection and an open finishing after dispose is closed', async () => {
  f = await system({ targets: 1 });
  const id = await f.bind(0);
  const handle = f.target[0].core.handle(id);
  const client = new BindingClient(handle);
  const [a, b] = await Promise.all([client.conn(), client.conn()]);
  expect(a).toBe(b);
  expect(a.rpc.socket.destroyed).toBe(false);
  client.dispose();
  expect(a.rpc.socket.destroyed).toBe(true);

  const late = new BindingClient(handle);
  const pending = late.conn();
  late.dispose();
  await expect(pending).rejects.toMatchObject({ code: 'transport_unavailable' });
  expect(late.connection).toBeUndefined();
});
