import { it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// A session_start that fails after a newer session_start already attached
// must not tear down the newer session's host.

const hooks = vi.hoisted(() => ({ next: undefined }));
vi.mock('../../dist/target/host.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    createTarget: (...args) => {
      const override = hooks.next;
      hooks.next = undefined;
      return override ? override() : real.createTarget(...args);
    },
  };
});
const { createRelayExtension } = await import('../../dist/pi/index.js');

let root;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const noop = () => {};
const anyFn = new Proxy({}, { get: () => noop });

function fakePi() {
  const handlers = {};
  const pi = {
    registerTool: noop,
    registerCommand: noop,
    registerEntryRenderer: noop,
    registerMessageRenderer: noop,
    registerFlag: noop,
    getFlag: () => false,
    getSessionName: () => undefined,
    appendEntry: noop,
    sendMessage: noop,
    events: { on: () => noop, emit: noop },
    on: (event, fn) => ((handlers[event] ??= []).push(fn)),
  };
  const emit = async (event, ctx) => {
    for (const fn of handlers[event] ?? []) await fn({}, ctx);
  };
  return { pi, emit };
}

function ctxFor(sessionId) {
  return {
    cwd: root,
    ui: anyFn,
    hasUI: false,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => undefined,
      getEntries: () => [],
      getBranch: () => [],
      getLeafId: () => undefined,
    },
  };
}

it('a stale session_start failure leaves the newer attachment running', async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-race-')));
  const attached = [];
  const { pi, emit } = fakePi();
  createRelayExtension({ home: join(root, 'state'), realm: 'test', onAttached: (host) => attached.push(host) })(pi);

  let failFirst;
  hooks.next = () =>
    new Promise((_, reject) => {
      failFirst = reject;
    });
  const first = emit('session_start', ctxFor('11111111-aaaa'));
  await vi.waitFor(() => expect(failFirst).toBeTypeOf('function'));

  await emit('session_start', ctxFor('22222222-bbbb'));
  expect(attached).toHaveLength(1);
  const live = attached[0];

  failFirst(Object.assign(new Error('takeover timed out'), { code: 'owner_conflict' }));
  await first;
  // The newer host must still be open and usable.
  expect(() => live.core.list()).not.toThrow();

  await emit('session_shutdown', ctxFor('22222222-bbbb'));
});
