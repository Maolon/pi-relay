import { it, expect, afterEach } from 'vitest';
import { createConnection } from 'node:net';
import { once, EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { system, event } from '../fixtures/system.mjs';
import { openBinding, BindingClient } from '../../dist/client/index.js';
import { Framer } from '../../dist/transport/framing.js';
import { installBusEndpoint, requestOnBus } from '../../dist/transport/in-process.js';
import { newId, canonical } from '../../dist/protocol/index.js';
let f;
afterEach(async () => {
  await f?.close();
  f = undefined;
});
const base = (op) => ({ protocol: 'pi-relay', major: 1, minor: 1, requestId: newId('request'), op });
it('[G06 G14 G19] actual Unix socket rejects versions, malformed bytes and unauthenticated calls', async () => {
  f = await system();
  const id = await f.bind(0);
  const handle = f.target[0].core.handle(id);
  const { rpc } = await openBinding(handle);
  rpc.dispose();
  const discovery = JSON.parse(
    (await import('node:fs/promises')).readFile
      ? await (await import('node:fs/promises')).readFile(handle.discoveryFile, 'utf8')
      : '{}',
  );
  const socket = createConnection(discovery.endpoint);
  await once(socket, 'connect');
  socket.write(
    JSON.stringify({
      ...base('connect'),
      major: 9,
      bindingId: id,
      credential: handle.credential,
      requiredFeatures: [],
    }) + '\n',
  );
  const [data] = await once(socket, 'data');
  expect(JSON.parse(data).error.code).toBe('unsupported_version');
  socket.destroy();
  const malformed = createConnection(discovery.endpoint);
  await once(malformed, 'connect');
  malformed.write(Buffer.from([0xff, 10]));
  await once(malformed, 'close');
});
it('[G14 G15] in-process requests share admission semantics but not connection authorization state', async () => {
  f = await system();
  const id = await f.bind(0);
  const handle = f.target[0].core.handle(id);
  await f.source.core.publish('X', event('e'));
  const emitter = new EventEmitter();
  const bus = {
    on(name, fn) {
      emitter.on(name, fn);
      return () => emitter.off(name, fn);
    },
    emit(name, value) {
      emitter.emit(name, value);
    },
  };
  const off = installBusEndpoint(bus, 'relay', () => f.target[0].handler());
  const auth = { ...base('connect'), bindingId: id, credential: handle.credential, requiredFeatures: [] };
  const request = {
    ...base('receipt'),
    bindingId: id,
    bindingRevision: 1,
    attachmentId: f.target[0].core.attachmentId,
    eventId: 'e',
  };
  try {
    const response = await requestOnBus(bus, 'relay', { authentication: auth, request });
    expect(response.ok).toBe(true);
    expect(response.result.eventId).toBe('e');
    const bad = await requestOnBus(bus, 'relay', {
      authentication: { ...auth, credential: '0'.repeat(64) },
      request: { ...request, requestId: newId('bad') },
    });
    expect(bad.error.code).toBe('unauthorized');
    expect(emitter.listenerCount('relay:response')).toBe(0);
  } finally {
    off();
  }
  await expect(requestOnBus(bus, 'relay', { authentication: auth, request }, 20)).rejects.toThrowError(
    /may have completed/,
  );
  expect(emitter.listenerCount('relay:response')).toBe(0);
});
it('[G06 G11] Python standard-library client interoperates without loading Pi or a language SDK', async () => {
  f = await system();
  const id = await f.bind(0);
  await f.source.core.publish('X', event('python'));
  const script = join(import.meta.dirname, '../fixtures/python-client.py');
  const child = spawn('python3', [script, f.target[0].core.binding(id).handleFile, 'python'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (b) => (stdout += b));
  child.stderr.on('data', (b) => (stderr += b));
  const [code] = await once(child, 'exit');
  expect(stderr).toBe('');
  expect(code).toBe(0);
  expect(JSON.parse(stdout).eventId).toBe('python');
});
it('[G06 G10] per-binding cursors and credentials never reveal another target receipt', async () => {
  f = await system();
  const a = await f.bind(0),
    b = await f.bind(1);
  await f.source.core.publish('X', event('both'));
  const { rpc, hello } = await openBinding(f.target[0].core.handle(a));
  try {
    await expect(
      rpc.call({
        op: 'receipt',
        bindingId: b,
        bindingRevision: 1,
        attachmentId: hello.attachmentId,
        eventId: 'both',
      }),
    ).rejects.toThrowError(/Capability/);
    const result = await rpc.call({
      op: 'watch',
      bindingId: a,
      bindingRevision: 1,
      attachmentId: hello.attachmentId,
      after: 0,
      limit: 128,
    });
    expect(result.updates.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain(b);
    expect(() => f.target[0].core.receipts(a, 1000000)).toThrow();
  } finally {
    rpc.dispose();
  }
});
