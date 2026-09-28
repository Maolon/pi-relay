import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Store } from '../../dist/store/database.js';

const MANAGED_SOURCE_TABLES = [
  'managed_scopes',
  'managed_audiences',
  'managed_events',
  'event_tombstones',
  'route_controls',
  'source_responses',
  'source_control_ops',
  'source_receipt_updates',
  'application_ack_outbox',
  'managed_route_pending',
];
const MANAGED_TARGET_TABLES = [
  'managed_deliveries',
  'consumer_registrations',
  'target_controls',
  'consumer_response_outbox',
  'target_receipt_outbox',
  'application_ack_inbox',
];
function tables(db, like) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE ? ORDER BY name")
    .all(`%${like}%`)
    .map((r) => r.name);
}
function hasTables(db, names) {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const n of names) expect(rows).toContain(n);
}
function dropManagedSource(db) {
  const objects = db
    .prepare(
      "SELECT type, name FROM sqlite_master WHERE name IN ('managed_scopes','managed_audiences','managed_audience_publisher','managed_events','managed_events_audience','immutable_managed_event','event_tombstones','route_controls','source_responses','source_control_ops','source_receipt_updates','application_ack_outbox','managed_route_pending')",
    )
    .all();
  db.exec('BEGIN');
  for (const o of objects) db.exec(`DROP ${o.type === 'trigger' ? 'TRIGGER' : o.type === 'index' ? 'INDEX' : 'TABLE'} IF EXISTS "${o.name}"`);
  db.exec('COMMIT');
  db.pragma('user_version = 2');
}
function dropManagedTarget(db) {
  const objects = db
    .prepare(
      "SELECT type, name FROM sqlite_master WHERE name IN ('managed_deliveries','consumer_registrations','target_controls','consumer_response_outbox','target_receipt_outbox','application_ack_inbox')",
    )
    .all();
  db.exec('BEGIN');
  for (const o of objects) db.exec(`DROP ${o.type === 'trigger' ? 'TRIGGER' : o.type === 'index' ? 'INDEX' : 'TABLE'} IF EXISTS "${o.name}"`);
  db.exec('COMMIT');
  db.pragma('user_version = 1');
}

describe('managed delivery storage migrations (stage 1)', () => {
  it('fresh source store creates managed model at v3; identity survives reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-managed-src-'));
    let s;
    try {
      s = new Store(dir, 'source', 'test', 'realm');
      expect(s.db.pragma('user_version', { simple: true })).toBe(4);
      expect(tables(s.db, 'managed')).toContain('managed_scopes');
      hasTables(s.db, MANAGED_SOURCE_TABLES);
      s.setMeta('managed-fresh', 'yes');
      s.close();
      s = new Store(dir, 'source', 'test', 'realm');
      expect(s.db.pragma('user_version', { simple: true })).toBe(4);
      expect(s.meta('managed-fresh')).toBe('yes');
    } finally {
      s?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fresh target store creates managed model at v2', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-managed-tgt-'));
    let s;
    try {
      s = new Store(dir, 'target', 'test', 'realm');
      expect(s.db.pragma('user_version', { simple: true })).toBe(2);
      hasTables(s.db, MANAGED_TARGET_TABLES);
    } finally {
      s?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('upgrade: legacy source v2 (no managed tables) migrates additively to v3', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-managed-upg-'));
    let s;
    try {
      s = new Store(dir, 'source', 'test', 'realm');
      s.setMeta('legacy', 'kept');
      s.close();
      // Simulate a pre-managed v2 database: drop managed objects, rewind version.
      const raw = new Database(join(s.dir, 'source.sqlite'));
      dropManagedSource(raw);
      expect(tables(raw, 'managed')).toEqual([]);
      raw.close();
      s = new Store(dir, 'source', 'test', 'realm');
      expect(s.db.pragma('user_version', { simple: true })).toBe(4);
      hasTables(s.db, MANAGED_SOURCE_TABLES);
      expect(s.meta('legacy')).toBe('kept');
      expect(tables(s.db, 'channels')).toContain('channels'); // 1.1 surface intact
    } finally {
      s?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('upgrade: legacy target v1 migrates additively to v2; newer schema still refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-managed-upgt-'));
    let s;
    try {
      s = new Store(dir, 'target', 'test', 'realm');
      s.setMeta('legacy', 'kept');
      s.close();
      const raw = new Database(join(s.dir, 'inbox.sqlite'));
      dropManagedTarget(raw);
      raw.close();
      s = new Store(dir, 'target', 'test', 'realm');
      expect(s.db.pragma('user_version', { simple: true })).toBe(2);
      hasTables(s.db, MANAGED_TARGET_TABLES);
      expect(s.meta('legacy')).toBe('kept');
      s.db.pragma('user_version = 3');
      s.close();
      expect(() => new Store(dir, 'target', 'test', 'realm')).toThrow();
    } finally {
      s?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('upgrade: source v3 (managed, pre-staging) migrates to v4 adding managed_route_pending', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-managed-upg3-'));
    let s;
    try {
      s = new Store(dir, 'source', 'test', 'realm');
      s.setMeta('v3', 'kept');
      s.close();
      const raw = new Database(join(s.dir, 'source.sqlite'));
      raw.exec('DROP TABLE IF EXISTS managed_route_pending');
      raw.pragma('user_version = 3');
      raw.close();
      s = new Store(dir, 'source', 'test', 'realm');
      expect(s.db.pragma('user_version', { simple: true })).toBe(4);
      expect(tables(s.db, 'managed_route_pending')).toContain('managed_route_pending');
      expect(s.meta('v3')).toBe('kept');
      hasTables(s.db, MANAGED_SOURCE_TABLES);
    } finally {
      s?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('managed constraints behave per approved model (trigger, dedup, epoch, FK)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-managed-ctr-'));
    let s;
    try {
      s = new Store(dir, 'source', 'test', 'realm');
      const db = s.db;
      db.exec('BEGIN');
      db.prepare('INSERT INTO managed_scopes VALUES (?,?,?,?)').run('pub-1', 'scope-1', 1, 'active');
      db.prepare('INSERT INTO channels VALUES (?,?,?,?)').run('ch-1', '{}', 0, 0);
      db.prepare(
        'INSERT INTO managed_audiences VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).run('aud-1', 'pub-1', 'ch-1', '["bnd-1"]', 7, 'watcher', 'resume', 'open', 1000, 9999999999999);
      db.prepare(
        'INSERT INTO managed_events VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).run(
        'pub-1',
        'evt-1',
        'scope-1',
        1,
        'digest-a',
        Buffer.alloc(0),
        '{"audienceRef":"aud-1","scope":{"id":"scope-1","revision":1},"consumerProfileId":"watcher","requestedMode":"resume"}',
        'digest-opts',
        9999999999999,
        1000,
      );
      db.prepare(
        'INSERT INTO source_receipt_updates (publisher_id,event_id,route_ref,target_revision,payload_json,created_at) VALUES (?,?,?,?,?,?)',
      ).run('pub-1', 'evt-1', 'r-1', 1, '{"authentication":{},"fact":{}}', 1);
      db.prepare(
        'INSERT INTO source_responses (response_id,publisher_id,event_id,route_ref,digest,body_json,source_cursor) VALUES (?,?,?,?,?,?,?)',
      ).run('resp-1', 'pub-1', 'evt-1', 'r-1', 'd', '{}', 1);
      db.prepare('INSERT INTO application_ack_outbox (response_id,route_ref,payload_json,at) VALUES (?,?,?,?)').run('resp-1', 'r-1', '{}', 1);
      db.exec('COMMIT');
      // M5: duplicate (route_ref,target_revision) rejected.
      expect(() =>
        db
          .prepare('INSERT INTO source_receipt_updates (publisher_id,event_id,route_ref,target_revision,payload_json,created_at) VALUES (?,?,?,?,?,?)')
          .run('pub-1', 'evt-1', 'r-1', 1, '{}', 2),
      ).toThrow();
      // m10: immutable trigger covers options_digest.
      expect(() => db.prepare("UPDATE managed_events SET options_digest='x' WHERE event_id='evt-1'").run()).toThrow(
        /immutable managed event/,
      );
      // D4: ack outbox FK to source_responses.
      expect(() =>
        db.prepare('INSERT INTO application_ack_outbox (response_id,route_ref,payload_json,at) VALUES (?,?,?,?)').run('resp-x', 'r-1', '{}', 1),
      ).toThrow();
      s.close();

      s = new Store(dir, 'target', 'test', 'realm');
      const t = s.db;
      t.exec('BEGIN');
      t.prepare('INSERT INTO managed_deliveries VALUES (?,?,?,?,?,?,?,?,?,?)').run(
        'del-1', 'r-1', 'evt-1', 'scope-1', 1, 'pending', 1, 'watcher', 4, '{}',
      );
      t.prepare(
        'INSERT INTO consumer_registrations VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).run('watcher', 'emd', 'rmd', 'watcher-guard-v1', 5000, 1, 1, 4, 1000, 1000);
      t.prepare(
        'INSERT INTO consumer_response_outbox (response_id,delivery_ref,operation_id,principal,digest,body_json,state) VALUES (?,?,?,?,?,?,?)',
      ).run('resp-1', 'del-1', 'op-1', 'consumer', 'd', '{}', 'target_staged');
      t.prepare('INSERT INTO application_ack_inbox VALUES (?,?,?,?)').run('resp-1', 'del-1', 1, '{}');
      t.exec('COMMIT');
      // M4: epoch CHECK and re-registration epoch bump.
      expect(() =>
        t.prepare('INSERT INTO consumer_registrations VALUES (?,?,?,?,?,?,?,?,?,?)').run('bad', 'e', 'r', 'g', 1, 0, 0, 0, 1, 1),
      ).toThrow();
      t.prepare('UPDATE consumer_registrations SET epoch=epoch+1, updated_at=? WHERE profile_id=?').run(2000, 'watcher');
      expect(t.prepare('SELECT epoch FROM consumer_registrations WHERE profile_id=?').get('watcher').epoch).toBe(5);
      // m8: scope-level control with NULL delivery_ref allowed; dangling FK rejected.
      t.prepare(
        'INSERT INTO target_controls (control_id,delivery_ref,disposition,cut_revision,result_json) VALUES (?,?,?,?,?)',
      ).run('c-scope', null, 'pending', 3, '{"cuts":[],"appliedAt":1}');
      expect(() =>
        t.prepare('INSERT INTO target_controls (control_id,delivery_ref,disposition,cut_revision,result_json) VALUES (?,?,?,?,?)').run(
          'c-dangle', 'del-x', 'pending', 4, '{}',
        ),
      ).toThrow();
      // m9: ack inbox idempotency + FK.
      expect(() =>
        t.prepare('INSERT INTO application_ack_inbox VALUES (?,?,?,?)').run('resp-x', 'del-1', 1, '{}'),
      ).toThrow();
      expect(() =>
        t.prepare('INSERT INTO application_ack_inbox VALUES (?,?,?,?)').run('resp-1', 'del-1', 1, '{}'),
      ).toThrow();
    } finally {
      s?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
