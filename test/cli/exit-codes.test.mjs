import { it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { system, event } from '../fixtures/system.mjs';
import { installPrivate } from '../../dist/platform/atomic-file.js';
import { exitFor, classifyExit } from '../../dist/cli/exit.js';

// SR-05: CLI exit codes follow the sealed ARCHITECTURE contract:
// 0 success scope / 2 argument-schema / 3 policy / 4 partial-unknown / 5 platform.
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
const publisherFile = () => {
  const file = join(f.root, 'publisher.json');
  installPrivate(file, f.source.core.publisherHandle('X'));
  return file;
};

it('[SR-05] publish exits 0 for the definite success scope (accepted/staged/buffered)', async () => {
  f = await system();
  await f.bind(0);
  const ok = await cli(['publish', '--source-file', publisherFile(), '--stdin'], JSON.stringify(event('sr5-ok')));
  expect(ok.code).toBe(0);
  expect(ok.json().routes[0].admission).toBe('accepted');
  // Offline-but-registered target: durable staged mailbox is still success scope.
  await f.target[0].close();
  const staged = await cli(['publish', '--source-file', publisherFile(), '--stdin'], JSON.stringify(event('sr5-stg')));
  expect(staged.code).toBe(0);
  expect(staged.json().routes[0].admission).toBe('staged');
}, 15000);

it('[SR-05] non-materialized routes are partial: pending-registration/unknown/source-staged exit 4', async () => {
  // Crash window after source membership commit but before target finalize:
  // the target answers subscription_provisioning and the route never
  // materializes — the sealed contract forbids counting it as success.
  f = await system({
    // Membership commits, but the response is always lost: the target never
    // finalizes, so every publish for it stays non-materialized.
    sourceFault: (checkpoint) => {
      if (checkpoint === 'source.after_membership_commit')
        throw Object.assign(new Error('crash window'), { code: 'transport_unavailable', retryable: true });
    },
  });
  await expect(f.bind(0)).rejects.toBeTruthy();
  const result = await f.source.core.publish('X', event('sr5-partial'));
  expect(result.routes.some((r) => !['accepted', 'staged', 'buffered'].includes(r.admission))).toBe(true);
  expect(exitFor(result)).toBe(4);
  // Unit-level contract for every partial disposition and control unknowns.
  expect(exitFor({ sourceState: 'source-staged', routes: [{ admission: 'source-staged' }] })).toBe(4);
  expect(exitFor({ sourceState: 'source-staged', routes: [{ admission: 'unknown' }] })).toBe(4);
  expect(exitFor({ sourceState: 'source-staged', routes: [{ admission: 'pending-registration' }] })).toBe(4);
  expect(exitFor({ channelId: 'X', action: 'revoke', routes: [{ outcome: 'unknown' }] })).toBe(4);
  expect(exitFor({ channelId: 'X', action: 'revoke', routes: [{ result: { outcome: 'ok' } }] })).toBe(0);
  expect(exitFor({ outcome: 'admission-unknown' })).toBe(4);
  expect(exitFor({ outcome: 'rejected', error: { code: 'binding_revoked' } })).toBe(3);
  expect(exitFor({ outcome: 'accepted' })).toBe(0);
  expect(exitFor({ outcome: 'dropped' })).toBe(0);
}, 15000);

it('[SR-05] argument/schema violations exit 2', async () => {
  f = await system();
  await f.bind(0);
  const sourceFile = publisherFile();
  const badJson = await cli(['publish', '--source-file', sourceFile, '--stdin'], '{not-json');
  expect(badJson.code).toBe(2);
  const badEvent = await cli(
    ['publish', '--source-file', sourceFile, '--stdin'],
    JSON.stringify({ kind: 'event', id: 'x', type: 'process.exited.v1' }), // missing schemaVersion/data
  );
  expect(badEvent.code).toBe(2);
  expect(classifyExit({ code: 'invalid_payload' })).toBe(2);
  expect(classifyExit({ code: 'stale_binding_revision' })).toBe(2);
  expect(classifyExit({ code: 'id_conflict' })).toBe(2);
}, 15000);

it('[SR-05] authorization rejection exits 3; unreachable platform exits 5', async () => {
  f = await system();
  await f.bind(0);
  // Cross-channel credential: schema-valid handle whose secret belongs to
  // channel Y presented against channel X => authorization rejection.
  const tamperedFile = join(f.root, 'publisher-forged.json');
  const handle = f.source.core.publisherHandle('Y');
  handle.channelId = 'X';
  installPrivate(tamperedFile, handle);
  const wrong = await cli(['publish', '--source-file', tamperedFile, '--stdin'], JSON.stringify(event('sr5-authz')));
  expect(wrong.code).toBe(3);
  // Source host stopped entirely => platform/transport failure.
  const freshFile = join(f.root, 'publisher2.json');
  installPrivate(freshFile, f.source.core.publisherHandle('X'));
  await f.source.close();
  const dead = await cli(['publish', '--source-file', freshFile, '--stdin'], JSON.stringify(event('sr5-dead')));
  expect(dead.code).toBe(5);
  expect(classifyExit({ code: 'unauthorized' })).toBe(3);
  expect(classifyExit({ code: 'binding_overlap' })).toBe(3);
  expect(classifyExit({ code: 'binding_revoked' })).toBe(3);
  expect(classifyExit({ code: 'backpressure' })).toBe(4);
  expect(classifyExit({ code: 'admission_unknown' })).toBe(4);
  expect(classifyExit({ code: 'store_unavailable' })).toBe(5);
  expect(classifyExit({ code: 'unsafe_path' })).toBe(5);
}, 15000);
