#!/usr/bin/env node
// T00: exercise real native dependencies. No fallback and no mocked lock/store.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tmpdir, release } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, openSync, closeSync, statSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const self = fileURLToPath(import.meta.url);
const results = [];
const children = new Set();
const held = new Map();
const out = process.env.PI_RELAY_GATE_OUTPUT ?? 'artifacts/implementation/T00';
const report = {
  taskId: 'T00',
  status: 'running',
  node: process.version,
  nodeAbi: process.versions.modules,
  platform: process.platform,
  arch: process.arch,
  osRelease: release(),
  startedAt: new Date().toISOString(),
  piBaseline: '1.0.0',
  piRuntimeTested: false,
  tests: results,
};
let root;

function acquire(fsExt, path) {
  assert(!held.has(path), 'same-process duplicate owner');
  const fd = openSync(path, 'a+', 0o600);
  try {
    fsExt.flockSync(fd, 'exnb');
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  held.set(path, fd);
  return () => {
    if (held.get(path) !== fd) return;
    held.delete(path);
    fsExt.flockSync(fd, 'un');
    closeSync(fd);
  };
}

async function worker(path) {
  const child = fork(self, ['lock-worker', path], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.add(child);
  child.once('exit', () => children.delete(child));
  child.stderr.resume();
  const [message] = await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(([code]) => {
      throw new Error(`lock worker exited before ready (${code})`);
    }),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('lock worker readiness timeout')), 10000);
      timer.unref();
      child.once('message', () => clearTimeout(timer));
    }),
  ]);
  return { child, message };
}

async function killOwned(child, signal = 'SIGKILL') {
  if (!children.has(child)) return;
  const exited = once(child, 'exit');
  child.kill(signal);
  await exited;
}

if (process.argv[2] === 'lock-worker') {
  try {
    const fsExt = require('fs-ext');
    const unlock = acquire(fsExt, process.argv[3]);
    process.send({ locked: true });
    process.on('message', () => {
      unlock();
      process.exit(0);
    });
    process.on('disconnect', () => {
      unlock();
      process.exit(0);
    });
  } catch (error) {
    process.send?.({ locked: false, code: error.code ?? 'load_error' }, () => process.exit(0));
  }
} else {
  try {
    const fsExt = require('fs-ext');
    const Database = require('better-sqlite3');
    report.dependencies = {
      'fs-ext': require('fs-ext/package.json').version,
      'better-sqlite3': require('better-sqlite3/package.json').version,
    };
    if (process.env.PI_RELAY_REQUIRE_PLATFORM) {
      assert.equal(`${process.platform}-${process.arch}`, process.env.PI_RELAY_REQUIRE_PLATFORM);
    }
    root = mkdtempSync(join(tmpdir(), 'pi-relay-native-'));
    const path = join(root, 'owner.lock');
    const unlock = acquire(fsExt, path);
    assert.throws(() => acquire(fsExt, path), /same-process duplicate owner/);
    const inode = statSync(path).ino;
    const competing = await worker(path);
    assert.equal(competing.message.locked, false, 'another process must not acquire held lock');
    results.push({ name: 'exclusive-and-same-process-lock', passed: true });
    unlock();
    const owner = await worker(path);
    assert.equal(owner.message.locked, true);
    owner.child.kill('SIGSTOP');
    const whileStopped = await worker(path);
    assert.equal(whileStopped.message.locked, false, 'SIGSTOP must not expire the owner');
    results.push({ name: 'sigstop-does-not-steal', passed: true });
    await killOwned(owner.child);
    const releaseAfterKill = acquire(fsExt, path);
    assert.equal(statSync(path).ino, inode, 'owner lock inode must never be replaced');
    releaseAfterKill();
    results.push({ name: 'sigkill-releases-with-fixed-inode', passed: true });

    const dbPath = join(root, 'inbox.sqlite');
    const db = new Database(dbPath, { timeout: 25 });
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(db.pragma('synchronous', { simple: true }), 2);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    report.sqlite = db.prepare('SELECT sqlite_version() AS version').get().version;
    db.exec('CREATE TABLE facts(id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO facts VALUES(?, ?)');
    assert.throws(
      db.transaction(() => {
        insert.run('rollback', 'a');
        insert.run('rollback', 'b');
      }),
    );
    assert.equal(db.prepare('SELECT count(*) AS n FROM facts').get().n, 0);
    results.push({ name: 'wal-full-foreign-keys-and-rollback', passed: true });

    const rival = new Database(dbPath, { timeout: 25 });
    db.exec('BEGIN IMMEDIATE');
    assert.throws(() => rival.prepare('INSERT INTO facts VALUES(?, ?)').run('busy', 'x'), {
      code: 'SQLITE_BUSY',
    });
    db.exec('ROLLBACK');
    rival.close();
    insert.run('durable', 'committed');
    db.close();
    const reopened = new Database(dbPath, { readonly: true, fileMustExist: true });
    assert.equal(reopened.prepare('SELECT value FROM facts WHERE id=?').get('durable').value, 'committed');
    assert.equal(reopened.prepare('SELECT count(*) AS n FROM facts').get().n, 1);
    reopened.close();
    results.push({ name: 'busy-is-not-admission-and-reopen-preserves-commit', passed: true });

    const full = new Database(join(root, 'full.sqlite'));
    full.exec('CREATE TABLE blobs(value BLOB)');
    full.pragma(`max_page_count = ${full.pragma('page_count', { simple: true })}`);
    assert.throws(() => full.prepare('INSERT INTO blobs VALUES(zeroblob(1048576))').run(), {
      code: 'SQLITE_FULL',
    });
    assert.equal(full.prepare('SELECT count(*) AS n FROM blobs').get().n, 0);
    full.close();
    results.push({ name: 'sqlite-full-rejects-without-commit', passed: true });
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = { name: error.name, code: error.code, message: error.message };
    process.exitCode = 1;
  } finally {
    for (const child of [...children]) await killOwned(child);
    for (const fd of held.values()) {
      try {
        closeSync(fd);
      } catch {}
    }
    if (root) rmSync(root, { recursive: true, force: true });
    report.finishedAt = new Date().toISOString();
    mkdirSync(out, { recursive: true, mode: 0o700 });
    const text = JSON.stringify(report, null, 2) + '\n';
    writeFileSync(join(out, 'platform.json'), text, { mode: 0o600 });
    console.log(text);
  }
}
