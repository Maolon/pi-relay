import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
export async function childFixture(args) {
  const child = fork(fileURLToPath(new URL('./worker.mjs', import.meta.url)), [], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let next = 0,
    stderr = '',
    exited = false;
  const pending = new Map();
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  child.on('message', (message) => {
    const p = pending.get(message.id);
    if (!p) return;
    pending.delete(message.id);
    clearTimeout(p.timer);
    message.ok
      ? p.resolve(message.result)
      : p.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
  });
  child.on('exit', () => {
    exited = true;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Owned fixture exited: ' + stderr));
    }
    pending.clear();
  });
  const call = (op, args = {}) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Fixture request timed out: ' + op + ' ' + stderr));
      }, 12000);
      pending.set(id, { resolve, reject, timer });
      child.send({ id, op, args });
    });
  const kill = async () => {
    if (exited) return;
    const done = once(child, 'exit');
    child.kill('SIGKILL');
    await done;
  };
  try {
    const ready = await call('start', args);
    return {
      child,
      ready,
      call,
      kill,
      async close() {
        if (exited) return;
        try {
          await call('stop');
        } catch {}
        await kill();
      },
    };
  } catch (error) {
    await kill();
    throw error;
  }
}
