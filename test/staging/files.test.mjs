import { it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { readFileSync, writeFileSync, readdirSync, symlinkSync, unlinkSync, statSync, mkdirSync } from 'node:fs';
import { system, event } from '../fixtures/system.mjs';
import { stage, signPacket } from '../../dist/staging/index.js';
import { sha256, withoutProof, secret } from '../../dist/protocol/canonical.js';
import { readPrivate } from '../../dist/platform/private-paths.js';
let f;
afterEach(async () => {
  await f?.close();
  f = undefined;
});
it('[G07 G08 G24 M07 M08] signed no-replace staging survives source exit and preserves per-binding responsibility', async () => {
  f = await system();
  const a = await f.bind(0),
    b = await f.bind(1);
  const captured = f.source.core.capture('X', event('staged'));
  const rows = f.source.core.store.all('SELECT packet FROM routes WHERE fanout=?', captured.fanout);
  for (const row of rows) {
    const p = JSON.parse(row.packet),
      handle = f.target[p.bindingId === a ? 0 : 1].core.handle(p.bindingId);
    stage(handle, p);
    const file = join(handle.spoolDir, 'pending', sha256(p.event.id) + '.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).not.toContain(handle.credential);
    stage(handle, p);
    expect(() => stage(handle, { ...p, event: event('staged', { exitCode: 1 }) })).toThrow();
  }
  expect(f.target[0].import(a).accepted).toBe(1);
  expect(readdirSync(join(f.target[1].core.handle(b).spoolDir, 'pending'))).toHaveLength(1);
  f.control(1, b, 'revoke');
  expect(f.target[1].import(b).rejected).toBe(1);
  expect(() => f.target[1].core.receipt(b, 'staged')).toThrow();
});
it('[G05 G06 G08 G09 G20] offline importer verifies proof, permission and symlink safety rather than lending owner credentials', async () => {
  f = await system();
  const a = await f.bind(0);
  const captured = f.source.core.capture('X', event('tamper'));
  const packet = JSON.parse(
    f.source.core.store.get('SELECT packet FROM routes WHERE fanout=?', captured.fanout).packet,
  );
  const handle = f.target[0].core.handle(a);
  stage(handle, { ...packet, proof: '0'.repeat(64) });
  expect(f.target[0].import(a).rejected).toBe(1);
  expect(f.target[0].core.store.get('SELECT count(*) n FROM events').n).toBe(0);
  const link = join(handle.spoolDir, 'pending', sha256('link') + '.json');
  symlinkSync(f.target[0].core.binding(a).handleFile, link);
  expect(() => readPrivate(link)).toThrowError(/filesystem/);
  expect(f.target[0].import(a).rejected).toBe(1);
});
it('[G24] every pre-admission file barrier leaves recoverable bytes but cannot fabricate staged acknowledgment', async () => {
  f = await system();
  const id = await f.bind(0);
  for (const barrier of ['stage.after_file_fsync', 'stage.after_install_before_dir_fsync']) {
    const captured = f.source.core.capture('X', event(barrier));
    const p = JSON.parse(
      f.source.core.store.get('SELECT packet FROM routes WHERE fanout=?', captured.fanout).packet,
    );
    expect(() =>
      stage(f.target[0].core.handle(id), p, (name) => {
        if (name === barrier) throw Error(barrier);
      }),
    ).toThrow(barrier);
    expect(f.target[0].core.store.get('SELECT count(*) n FROM events').n).toBe(0);
    stage(f.target[0].core.handle(id), p);
  }
  expect(f.target[0].import(id).accepted).toBe(2);
});

it('[owner-superseded] a superseded importer preserves valid pending packets for the new owner', async () => {
  f = await system({ targets: 1 });
  const a = await f.bind(0);
  const captured = f.source.core.capture('X', event('superseded'));
  const row = f.source.core.store.get('SELECT packet FROM routes WHERE fanout=?', captured.fanout);
  const packet = JSON.parse(row.packet);
  const handle = f.target[0].core.handle(a);
  stage(handle, packet);
  const pendingDir = join(handle.spoolDir, 'pending');
  expect(readdirSync(pendingDir)).toHaveLength(1);
  // A newer owner challenges this one; the fence fires inside import.
  mkdirSync(join(f.target[0].core.store.dir, 'owner-challenges'), { recursive: true });
  writeFileSync(
    join(f.target[0].core.store.dir, 'owner-challenges', 'live-1.json'),
    JSON.stringify({ generation: 99, pid: process.pid, at: Date.now(), deadline: Date.now() + 60_000 }),
  );
  const report = f.target[0].import(a);
  expect(report.pending).toBe(1);
  expect(report.rejected).toBe(0);
  // The packet survives for the new owner; nothing is quarantined.
  expect(readdirSync(pendingDir)).toHaveLength(1);
  expect(readdirSync(join(handle.spoolDir, 'quarantine'))).toHaveLength(0);
  expect(f.target[0].core.store.get('SELECT count(*) n FROM events').n).toBe(0);
});
