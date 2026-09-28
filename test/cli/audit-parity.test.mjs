import { it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { system, event } from '../fixtures/system.mjs';
import { installPrivate } from '../../dist/platform/atomic-file.js';

// G10/G15 remediation: CLI-versus-SDK parity and ingest idleness semantics.
let f;
afterEach(async () => {
  await f?.close();
  f = undefined;
});
async function cli(args, stdin, holdOpenMs) {
  const child = spawn(process.execPath, ['dist/cli/index.js', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '',
    err = '';
  child.stdout.on('data', (b) => (out += b));
  child.stderr.on('data', (b) => (err += b));
  if (holdOpenMs) {
    await new Promise((r) => setTimeout(r, holdOpenMs)); // idle window, stdin still open
    child.stdin.end(stdin ?? '');
  } else child.stdin.end(stdin);
  const [code] = await once(child, 'exit');
  return { code, out, err, json: () => JSON.parse(out) };
}
const publisherFile = () => {
  const file = join(f.root, 'publisher.json');
  installPrivate(file, f.source.core.publisherHandle('X'));
  return file;
};

it('[G10] SDK and CLI publish the same wire event with identical validation, classification and receipt meaning', async () => {
  f = await system();
  await f.bind(0);
  const sourceFile = publisherFile();
  const sdk = await f.source.core.publish('X', event('parity-sdk'));
  const cliResult = await cli(['publish', '--source-file', sourceFile, '--stdin'], JSON.stringify(event('parity-cli')));
  expect(cliResult.code).toBe(0);
  const cliPublish = cliResult.json();
  for (const result of [sdk, cliPublish]) {
    expect(result.sourceState).toBe('source-staged'); // same capture semantics
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].admission).toBe('accepted');
    expect(result.membershipRevision).toBe(sdk.membershipRevision);
  }
  // Identical receipt meaning: both events are queryable through the same surface.
  const sdkReceipt = await f.source.core.fanoutResult('X', 'parity-sdk');
  const cliReceipt = await f.source.core.fanoutResult('X', 'parity-cli');
  expect(sdkReceipt.routes[0].admission).toBe('accepted');
  expect(cliReceipt.routes[0].admission).toBe('accepted');
  // Error classification parity: schema violations produce the same code and
  // non-zero exit through both surfaces.
  const badCli = await cli(['publish', '--source-file', sourceFile, '--stdin'], '{bad json');
  expect(badCli.code).toBe(2);
  expect(JSON.parse(badCli.err).error.code).toBe('invalid_payload');
  await expect(f.source.core.publish('X', JSON.parse('{bad json'.replace('{bad json', '{"kind":"event"}')))).rejects.toMatchObject(
    { code: 'invalid_payload' },
  );
  // Conflict parity: same eventId with a different payload is id_conflict via SDK,
  // and a classified argument/payload error (exit 2) via CLI.
  await expect(f.source.core.publish('X', event('parity-sdk', { exitCode: 9 }))).rejects.toMatchObject({
    code: 'id_conflict',
  });
  const conflict = await cli(
    ['publish', '--source-file', sourceFile, '--stdin'],
    JSON.stringify(event('parity-cli', { exitCode: 9 })),
  );
  expect(conflict.code).toBe(2);
  expect(JSON.parse(conflict.err).error.code).toBe('id_conflict');
}, 20000);

it('[G15] an idle ingest watcher is not a failure and fabricates no completion', async () => {
  f = await system();
  await f.bind(0);
  const sourceFile = publisherFile();
  const eventsBefore = f.source.core.store.get('SELECT count(*) n FROM source_events').n;
  // Keep stdin open with no bytes for longer than any heartbeat window; nothing
  // may be published, failed or completed during the idle stretch.
  const idle = cli(['ingest', '--source-file', sourceFile], '', 1200);
  await new Promise((r) => setTimeout(r, 600)); // mid-idle inspection
  expect(f.source.core.store.get('SELECT count(*) n FROM source_events').n).toBe(eventsBefore);
  const result = await idle;
  expect(result.code).toBe(0);
  // EOF closes the stream as a progress fact only: no event, no completion.
  expect(f.source.core.store.get('SELECT count(*) n FROM source_events').n).toBe(eventsBefore);
  const body = result.json();
  const progress = body.value ?? body;
  expect(progress.kind ?? 'progress').toBe('progress');
  expect(JSON.stringify(body)).toContain('"eof":true');
  expect(JSON.stringify(body)).not.toContain('process.exited');
}, 20000);
