// Child helper for test/platform/owner-takeover.test.mjs
// Modes: hold | hold-ignore | take
// Owners here run a minimal fencing supervisor: when superseded, they close
// (releasing the flock) so a later challenger can win, mirroring TargetHost.
import { join } from 'node:path';
import { OwnerLock, readOwnerToken } from '../../dist/platform/owner-lock.js';

const [dir, mode, pollArg, timeoutArg] = process.argv.slice(2);

function supervise(lock, extra) {
  const timer = setInterval(() => {
    try {
      lock.assertHeld();
    } catch {
      clearInterval(timer);
      lock.close();
      try { process.send({ superseded: true, ...extra }); } catch {}
    }
  }, 50);
  timer.unref();
  return timer;
}

if (mode === 'hold') {
  const lock = OwnerLock.acquireSync(join(dir, 'owner.lock'));
  process.send({ held: true, pid: process.pid, token: readOwnerToken(dir) });
  supervise(lock, { pid: process.pid });
  process.on('message', (m) => {
    if (m === 'close') {
      lock.close();
      process.send({ closed: true });
    }
  });
} else if (mode === 'hold-ignore') {
  // Hold the flock but never fence-check or respond (simulates a wedged owner).
  const lock = OwnerLock.acquireSync(join(dir, 'owner.lock'));
  process.send({ held: true, pid: process.pid });
  process.on('message', () => { void lock; }); // keep the process (and flock) alive
} else if (mode === 'take') {
  try {
    const lock = await OwnerLock.acquire(join(dir, 'owner.lock'), {
      takeover: true,
      pollMs: Number(pollArg),
      timeoutMs: Number(timeoutArg),
    });
    process.send({ took: true, pid: process.pid, token: readOwnerToken(dir) });
    supervise(lock, { pid: process.pid });
    process.on('message', (m) => {
      if (m === 'close') {
        lock.close();
        process.send({ closed: true });
      }
    });
  } catch (e) {
    process.send({ took: false, code: (e && e.code) || undefined, token: readOwnerToken(dir) });
  }
}
