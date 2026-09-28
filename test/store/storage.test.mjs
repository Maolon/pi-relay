import { it, expect } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Store } from '../../dist/store/database.js';
it('[L02 L19 L20 G12] real SQLite is independent of session JSONL, transactional and exclusively owned', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-store-'));
  let s;
  try {
    s = new Store(dir, 'target', 'test', 'realm');
    expect(s.db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(s.db.pragma('synchronous', { simple: true })).toBe(2);
    expect(s.db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() => new Store(dir, 'target', 'test', 'realm')).toThrowError(/owner/);
    expect(() =>
      s.tx(() => {
        s.setMeta('rollback', 'yes');
        throw Error('injected');
      }),
    ).toThrow();
    expect(s.meta('rollback')).toBeUndefined();
    s.setMeta('durable', 'yes');
    const epoch = s.epoch;
    const inode = statSync(join(dir, 'owner.lock')).ino;
    await s.backup(join(dir, 'backup.sqlite'));
    s.close();
    s = new Store(dir, 'target', 'test', 'realm');
    expect(s.meta('durable')).toBe('yes');
    expect(s.epoch).toBe(epoch + 1);
    expect(statSync(join(dir, 'owner.lock')).ino).toBe(inode);
    const backup = new Database(join(dir, 'backup.sqlite'), { readonly: true });
    expect(backup.prepare("SELECT value FROM metadata WHERE key='durable'").get().value).toBe('yes');
    backup.close();
  } finally {
    s?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('[G12] corruption and newer schemas are preserved, never silently replaced', () => {
  for (const kind of ['corrupt', 'newer']) {
    const dir = mkdtempSync(join(tmpdir(), 'relay-store-'));
    try {
      let s = new Store(dir, 'target', 'test', 'realm');
      if (kind === 'newer') s.db.pragma('user_version = 999');
      s.close();
      const path = join(dir, 'inbox.sqlite');
      if (kind === 'corrupt') writeFileSync(path, 'corrupt-private-database');
      const before = readFileSync(path);
      expect(() => new Store(dir, 'target', 'test', 'realm')).toThrow();
      expect(readFileSync(path)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
