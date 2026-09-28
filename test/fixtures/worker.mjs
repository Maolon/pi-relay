import { mkdirSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { piFixture } from './pi.mjs';
import { createSource } from '../../dist/source/index.js';
import { newId } from '../../dist/protocol/index.js';
let runtime,
  role,
  armed,
  seen = 0;
const fault = (point) => {
  if (point !== armed?.point || ++seen !== (armed.count ?? 1)) return;
  const fd = openSync(armed.barrier, 'wx', 0o600);
  writeSync(fd, JSON.stringify({ point, pid: process.pid }));
  fsyncSync(fd);
  closeSync(fd);
  process.kill(process.pid, 'SIGSTOP'); // The parent kills only this test-owned child after inspecting the durable barrier.
};
process.on('message', async ({ id, op, args = {} }) => {
  try {
    let result;
    if (op === 'start') {
      role = args.role;
      if (role === 'source') runtime = await createSource(args.config, { fault });
      else {
        mkdirSync(args.cwd, { recursive: true, mode: 0o700 });
        runtime = await piFixture({ ...args, fault });
      }
      result =
        role === 'source'
          ? { owner: runtime.core.ownerHandle(), publisher: runtime.core.publisherHandle('X') }
          : { file: runtime.manager.getSessionFile(), fingerprint: runtime.host.core.options.fingerprint };
    } else if (op === 'armFault') {
      armed = args;
      seen = 0;
      result = { armed: true };
    } else if (op === 'invite')
      result = runtime.core.createInvite({
        operationId: newId('invite'),
        ttlMs: 600000,
        bindingTtlMs: 3600000,
        allowResume: true,
        ...args,
      });
    else if (op === 'publish') result = await runtime.core.publish(args.channelId ?? 'X', args.value);
    else if (op === 'fanoutResult')
      result = await runtime.core.fanoutResult(args.channelId ?? 'X', args.eventId);
    else if (op === 'replay') result = await runtime.core.replay();
    else if (op === 'memberships') result = runtime.core.store.all('SELECT binding,state FROM memberships');
    else if (op === 'bind') result = await runtime.host.bind(args.invite, { resume: args.resume ?? true });
    else if (op === 'control')
      result = runtime.host.core.control(args.bindingId, {
        operationId: newId('op'),
        expectedRevision: runtime.host.core.binding(args.bindingId).revision,
        ...args.command,
      });
    else if (op === 'receipt') result = runtime.host.core.receipt(args.bindingId, args.eventId);
    else if (op === 'status') result = runtime.host.core.status();
    else if (op === 'prompt') {
      await runtime.session.prompt(args.text);
      result = { file: runtime.manager.getSessionFile() };
    } else if (op === 'stop') {
      await runtime.close();
      result = { closed: true };
    } else throw new Error('Unknown fixture command');
    process.send?.({ id, ok: true, result }, () => {
      if (op === 'stop') process.exit(0);
    });
  } catch (error) {
    process.send?.({ id, ok: false, error: { code: error.code ?? 'fixture_error', message: error.message } });
  }
});
process.on('disconnect', () => {
  void runtime?.close().finally(() => process.exit(0));
});
