import { it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { system, event } from '../fixtures/system.mjs';
import { installPrivate } from '../../dist/platform/atomic-file.js';
import { privateDir } from '../../dist/platform/private-paths.js';
let f;
afterEach(async () => {
  await f?.close();
  f = undefined;
});
async function cli(args, stdin) {
  const child = spawn(process.execPath, ['dist/cli/index.js', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '',
    err = '';
  child.stdout.on('data', (b) => (out += b));
  child.stderr.on('data', (b) => (err += b));
  child.stdin.end(stdin);
  const [code] = await once(child, 'exit');
  return { code, out, err, json: () => JSON.parse(out) };
}
it('[G11 G15] CLI source publish/receipt and ingest EOF work with explicit private handles', async () => {
  f = await system();
  const id = await f.bind(0);
  const sourceFile = join(f.root, 'publisher.json');
  installPrivate(sourceFile, f.source.core.publisherHandle('X'));
  const published = await cli(
    ['publish', '--source-file', sourceFile, '--stdin'],
    JSON.stringify(event('cli')),
  );
  expect(published.code).toBe(0);
  expect(published.json().routes[0].admission).toBe('accepted');
  const receipt = await cli([
    'receipt',
    '--binding-file',
    f.target[0].core.binding(id).handleFile,
    '--event-id',
    'cli',
  ]);
  expect(receipt.json().eventId).toBe('cli');
  const stream = await cli(['ingest', '--source-file', sourceFile, '--stream-id', 'output'], 'hello\nworld');
  expect(stream.code).toBe(0);
  expect(stream.json().processExitReported).toBe(false);
  expect(f.source.core.store.get('SELECT count(*) n FROM source_events').n).toBe(1);
});
it('[G06 G19] CLI does not accept token arguments, ambiguous targets, unknown flags or modes', async () => {
  f = await system();
  const sourceFile = join(f.root, 'publisher.json');
  installPrivate(sourceFile, f.source.core.publisherHandle('X'));
  for (const args of [
    ['publish', '--token', 'secret'],
    ['publish', '--source-file', sourceFile],
    ['source', 'egress', '--source-file', sourceFile],
    ['unknown'],
  ]) {
    const result = await cli(args);
    expect(result.code).toBe(2); // argument/schema errors per the sealed contract
    expect(result.out).toBe('');
    expect(result.err).not.toContain(f.config.ownerToken);
  }
});
it('[G11] config-create produces private, explicit owner and per-channel publisher capabilities', async () => {
  f = await system();
  const out = join(f.root, 'cli-config');
  const result = await cli([
    'source',
    'config-create',
    '--out',
    out,
    '--source',
    'new-source',
    '--channel',
    'new-run',
    '--home',
    f.home,
  ]);
  expect(result.code).toBe(0);
  const paths = result.json();
  const config = JSON.parse(readFileSync(paths.configFile));
  expect(config.channels[0].allowedModes).toEqual(['display']);
  expect(result.out).not.toContain(config.ownerToken);
  expect(JSON.parse(readFileSync(paths.publisherFile)).channelId).toBe('new-run');
  expect((await cli(['doctor'])).code).toBe(0);
});

it('[G19] auto-required is rejected for the display-only direct binding before any admission', async () => {
  f = await system();
  const id = await f.bind(0);
  const result = await cli(
    ['publish', '--binding-file', f.target[0].core.binding(id).handleFile, '--auto-required', '--stdin'],
    JSON.stringify(event('must-not-admit')),
  );
  expect(result.code).toBe(2); // unsupported_feature is an argument error per the sealed contract
  expect(result.out).toBe('');
  expect(result.err).toContain('unsupported_feature');
  expect(f.target[0].core.store.get('SELECT count(*) n FROM events').n).toBe(0);
});
it('[G19] invitation output canonicalizes an ancestor alias without weakening private directory checks', async () => {
  f = await system();
  const owner = join(f.root, 'owner.json');
  installPrivate(owner, f.source.core.ownerHandle());
  symlinkSync(f.root, join(f.root, 'alias'));
  privateDir(join(f.root, 'private'));
  const result = await cli([
    'source',
    'invite',
    '--source-file',
    owner,
    '--channel',
    'X',
    '--out',
    join(f.root, 'alias', 'private', 'invite.json'),
  ]);
  expect(result.code).toBe(0);
  expect(result.json().inviteFile).toBe(join(f.root, 'private', 'invite.json'));
  expect(JSON.parse(readFileSync(result.json().inviteFile)).channelId).toBe('X');
});
