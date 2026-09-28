import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Store } from '../../dist/store/database.js';
import { eventually } from '../fixtures/system.mjs';

// L19 remediation: store ownership must not depend on a graceful shutdown.
let dir;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
const holder = fileURLToPath(new URL('../fixtures/hold-store.mjs', import.meta.url));

it('[L19] a SIGKILLed owner releases the lock; a live owner is never usurped on weak evidence', async () => {
  dir = mkdtempSync(join(tmpdir(), 'relay-lock-'));
  const child = fork(holder, [join(dir, 'store')], { execArgv: [], stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
  let ready = '';
  child.stdout.on('data', (b) => (ready += b));
  await eventually(() => ready.includes('READY'));
  await eventually(() => ready.includes('MARKED'));

  // While the owning process is demonstrably alive, a second open must fail —
  // insufficient liveness evidence never authorizes stealing ownership. (The
  // store identity stays 'holder'; only the owning process differs.)
  expect(() => new Store(join(dir, 'store'), 'target', 'holder', 'test')).toThrowError(/owner/);

  // Hard death releases the flock at the OS level without any shutdown code.
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;

  const reopened = new Store(join(dir, 'store'), 'target', 'holder', 'test');
  expect(reopened.meta('durable-marker')).toBe('survives-kill');
  expect(reopened.epoch).toBeGreaterThan(1); // a new owner epoch was claimed
  reopened.close();
}, 20000);
