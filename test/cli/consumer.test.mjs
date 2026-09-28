import { it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { system } from '../fixtures/system.mjs';

let f;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

async function cli(args) {
  const child = spawn(process.execPath, ['dist/cli/index.js', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '',
    err = '';
  child.stdout.on('data', (b) => (out += b));
  child.stderr.on('data', (b) => (err += b));
  child.stdin.end();
  const [code] = await once(child, 'exit');
  return { code, out, err, json: () => JSON.parse(out) };
}

it('[stage 4] consumer add/list/show/rm manage declaration files in the relay home', async () => {
  f = await system({ targets: 1 });
  const home = join(f.root, 'relayhome');
  const declFile = join(f.root, 'watcher.json');
  writeFileSync(
    declFile,
    JSON.stringify({
      profileId: 'pi-watcher',
      eventTypes: ['process.exited.v1'],
      responseTypes: ['watcher.response.v1'],
      policy: { admission: 'auto', requireCurrentScope: true, timeoutMs: 1500 },
    }),
  );
  const add = await cli(['consumer', 'add', '--file', declFile, '--home', home]);
  expect(add.code).toBe(0);
  expect(add.json().profileId).toBe('pi-watcher');
  expect(add.json().file.endsWith('pi-watcher.json')).toBe(true);

  // duplicate without --force is an argument/policy rejection (exit 3 via invalid_state)
  const dup = await cli(['consumer', 'add', '--file', declFile, '--home', home]);
  expect(dup.code).not.toBe(0);
  const forced = await cli(['consumer', 'add', '--file', declFile, '--home', home, '--force']);
  expect(forced.code).toBe(0);

  const list = await cli(['consumer', 'list', '--home', home]);
  expect(list.code).toBe(0);
  const listed = list.json();
  expect(listed).toHaveLength(1);
  expect(listed[0].declaration.profileId).toBe('pi-watcher');
  expect(listed[0].declaration.eventTypes).toEqual(['process.exited.v1']);

  const show = await cli(['consumer', 'show', '--profile', 'pi-watcher', '--home', home]);
  expect(show.json()).toHaveLength(1);

  const rm = await cli(['consumer', 'rm', '--profile', 'pi-watcher', '--home', home]);
  expect(rm.code).toBe(0);
  const gone = await cli(['consumer', 'rm', '--profile', 'pi-watcher', '--home', home]);
  expect(gone.code).not.toBe(0);
  const empty = await cli(['consumer', 'list', '--home', home]);
  expect(empty.json()).toHaveLength(0);
});

it('[stage 4] consumer add rejects malformed declarations (exit 2)', async () => {
  f = await system({ targets: 1 });
  const home = join(f.root, 'relayhome2');
  const declFile = join(f.root, 'bad.json');
  writeFileSync(declFile, JSON.stringify({ profileId: 'bad profile', eventTypes: ['x.v1'] }));
  const add = await cli(['consumer', 'add', '--file', declFile, '--home', home]);
  expect(add.code).toBe(2);
});
