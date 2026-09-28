import Database from 'better-sqlite3';
import { constants, openSync, closeSync, lstatSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { OwnerLock } from '../platform/owner-lock.js';
import { privateDir, readPrivate, syncDir } from '../platform/private-paths.js';
import { assertPrivateFileStat } from '../platform/os-interop.js';
import { canonical } from '../protocol/canonical.js';
import { invariant, fail } from '../protocol/errors.js';
const COMMON = `
CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,digest TEXT NOT NULL,result TEXT NOT NULL);
`;
const TARGET = `
CREATE TABLE bindings(id TEXT PRIMARY KEY, source TEXT NOT NULL, channel TEXT NOT NULL, target TEXT NOT NULL, live INTEGER NOT NULL, body TEXT NOT NULL);
CREATE UNIQUE INDEX binding_overlap ON bindings(source,channel,target) WHERE live=1;
CREATE TABLE holds(binding TEXT NOT NULL REFERENCES bindings(id),reason TEXT NOT NULL,PRIMARY KEY(binding,reason));
CREATE TABLE credentials(id TEXT PRIMARY KEY,binding TEXT NOT NULL REFERENCES bindings(id),token_digest TEXT NOT NULL,key_ref TEXT NOT NULL);
CREATE TABLE events(binding TEXT NOT NULL REFERENCES bindings(id),id TEXT NOT NULL,digest TEXT NOT NULL,packet_digest TEXT NOT NULL,packet TEXT NOT NULL,seq INTEGER NOT NULL,accepted_at INTEGER NOT NULL,deadline INTEGER NOT NULL,model TEXT NOT NULL,bytes INTEGER NOT NULL,presentation TEXT NOT NULL DEFAULT 'none',PRIMARY KEY(binding,id),UNIQUE(binding,seq));
CREATE TABLE grants(id TEXT PRIMARY KEY,binding TEXT NOT NULL REFERENCES bindings(id),body TEXT NOT NULL,consumed INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE attempts(id TEXT PRIMARY KEY,binding TEXT NOT NULL,event TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,unblocked INTEGER NOT NULL DEFAULT 0,UNIQUE(binding,event),FOREIGN KEY(binding,event) REFERENCES events(binding,id));
CREATE TABLE observations(delivery TEXT NOT NULL REFERENCES attempts(id),evidence TEXT NOT NULL,entry TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(delivery,evidence,entry));
CREATE TABLE receipts(binding TEXT NOT NULL REFERENCES bindings(id),seq INTEGER NOT NULL,event TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(binding,seq));
CREATE TABLE processed_stage(binding TEXT NOT NULL REFERENCES bindings(id),digest TEXT NOT NULL,result TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(binding,digest));
CREATE INDEX events_pending ON events(model,deadline,accepted_at);
CREATE INDEX attempts_pending ON attempts(status,unblocked);
`;
// Managed delivery additive model (wire 1.2, approved plans/managed-delivery-v0.3 delta-1).
// DDL mirrors delta-1/target-storage.sql minus PRAGMAs; premise 1.1 tables above.
const MANAGED_TARGET = `
CREATE TABLE IF NOT EXISTS managed_deliveries (
 delivery_ref TEXT PRIMARY KEY, route_ref TEXT NOT NULL, event_id TEXT NOT NULL, scope_id TEXT NOT NULL, scope_revision INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','held','intent','submitted','recorded','unknown','suppressed','expired','withdrawn')),
 target_revision INTEGER NOT NULL, consumer_profile_id TEXT NOT NULL, registration_epoch INTEGER NOT NULL,
 request_json TEXT NOT NULL CHECK(json_valid(request_json)), UNIQUE(route_ref,event_id)
);
CREATE TABLE IF NOT EXISTS consumer_registrations (
 profile_id TEXT PRIMARY KEY,
 event_manifest_digest TEXT NOT NULL,
 response_manifest_digest TEXT NOT NULL,
 guard_implementation_id TEXT NOT NULL,
 timeout_ms INTEGER NOT NULL,
 require_current_scope INTEGER NOT NULL CHECK(require_current_scope IN (0,1)),
 owner_approved INTEGER NOT NULL DEFAULT 0 CHECK(owner_approved IN (0,1)),
 epoch INTEGER NOT NULL CHECK(epoch>0),
 registered_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS target_controls (
 control_id TEXT PRIMARY KEY, delivery_ref TEXT REFERENCES managed_deliveries(delivery_ref),
 disposition TEXT NOT NULL CHECK(disposition IN ('pending','prevented','too_late','unknown')),
 cut_revision INTEGER NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json))
);
CREATE TABLE IF NOT EXISTS consumer_response_outbox (
 response_id TEXT PRIMARY KEY, delivery_ref TEXT NOT NULL REFERENCES managed_deliveries,
 operation_id TEXT NOT NULL, principal TEXT NOT NULL, digest TEXT NOT NULL,
 body_json TEXT NOT NULL CHECK(json_valid(body_json)),
 state TEXT NOT NULL CHECK(state IN ('target_staged','source_recorded','application_applied')),
 application_result_json TEXT CHECK(application_result_json IS NULL OR json_valid(application_result_json)),
 UNIQUE(principal,operation_id)
);
CREATE TABLE IF NOT EXISTS target_receipt_outbox (
 update_id TEXT PRIMARY KEY, route_ref TEXT NOT NULL, target_revision INTEGER NOT NULL,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), sent INTEGER NOT NULL DEFAULT 0 CHECK(sent IN (0,1)),
 UNIQUE(route_ref,target_revision)
);
CREATE TABLE IF NOT EXISTS managed_route_index (
 route_ref TEXT PRIMARY KEY, binding TEXT NOT NULL, event_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS managed_scope_fence (
 scope_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS application_ack_inbox (
 response_id TEXT PRIMARY KEY REFERENCES consumer_response_outbox(response_id), delivery_ref TEXT NOT NULL REFERENCES managed_deliveries(delivery_ref),
 applied_at INTEGER NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
);
`;
const SOURCE = `
CREATE TABLE pending_controls(id TEXT PRIMARY KEY,digest TEXT NOT NULL,body TEXT NOT NULL);
CREATE TABLE channels(id TEXT PRIMARY KEY,body TEXT NOT NULL,closed INTEGER NOT NULL DEFAULT 0,revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE invites(id TEXT PRIMARY KEY,channel TEXT NOT NULL REFERENCES channels(id),token_digest TEXT NOT NULL,body TEXT NOT NULL,used_by TEXT);
CREATE TABLE memberships(binding TEXT PRIMARY KEY,channel TEXT NOT NULL REFERENCES channels(id),target TEXT NOT NULL,state TEXT NOT NULL,cut INTEGER NOT NULL,last_seen INTEGER,body TEXT NOT NULL);
CREATE UNIQUE INDEX membership_overlap ON memberships(channel,target) WHERE state='active';
CREATE TABLE source_events(channel TEXT NOT NULL REFERENCES channels(id),id TEXT NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL,fanout TEXT NOT NULL UNIQUE,cut INTEGER NOT NULL,at INTEGER NOT NULL,deadline INTEGER NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(channel,id));
CREATE TABLE routes(fanout TEXT NOT NULL REFERENCES source_events(fanout),binding TEXT NOT NULL REFERENCES memberships(binding),packet TEXT NOT NULL,disposition TEXT NOT NULL,reason TEXT,bytes INTEGER NOT NULL,PRIMARY KEY(fanout,binding));
CREATE TABLE reservations(id TEXT PRIMARY KEY,fanout TEXT NOT NULL,binding TEXT NOT NULL,units INTEGER NOT NULL,at INTEGER NOT NULL);
CREATE TABLE source_receipts(seq INTEGER PRIMARY KEY AUTOINCREMENT,channel TEXT NOT NULL,event TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,at INTEGER NOT NULL);
`;
// Managed delivery additive model (wire 1.2, approved plans/managed-delivery-v0.3 delta-1).
// DDL mirrors delta-1/source-storage.sql minus PRAGMAs (set below); premise 1.1 tables above.
const MANAGED_SOURCE = `
CREATE TABLE IF NOT EXISTS managed_scopes (
 publisher_id TEXT NOT NULL, scope_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 state TEXT NOT NULL CHECK(state IN ('active','paused','closed')), PRIMARY KEY(publisher_id,scope_id)
);
CREATE TABLE IF NOT EXISTS managed_audiences (
 audience_ref TEXT PRIMARY KEY,
 publisher_id TEXT NOT NULL,
 channel_id TEXT NOT NULL REFERENCES channels(id),
 route_set_json TEXT NOT NULL CHECK(json_valid(route_set_json)),
 membership_cut INTEGER NOT NULL,
 consumer_profile_id TEXT NOT NULL,
 requested_mode TEXT NOT NULL CHECK(requested_mode IN ('display','resume')),
 state TEXT NOT NULL CHECK(state IN ('open','closed','revoked')),
 issued_at INTEGER NOT NULL,
 valid_until INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS managed_audience_publisher ON managed_audiences(publisher_id,state);
CREATE TABLE IF NOT EXISTS managed_events (
 publisher_id TEXT NOT NULL, event_id TEXT NOT NULL, scope_id TEXT NOT NULL, scope_revision INTEGER NOT NULL,
 event_digest TEXT NOT NULL, event_bytes BLOB NOT NULL, options_json TEXT NOT NULL CHECK(json_valid(options_json)),
 options_digest TEXT NOT NULL,
 valid_until INTEGER NOT NULL, captured_at INTEGER NOT NULL,
 PRIMARY KEY(publisher_id,event_id), FOREIGN KEY(publisher_id,scope_id) REFERENCES managed_scopes
);
CREATE INDEX IF NOT EXISTS managed_events_audience ON managed_events(publisher_id, json_extract(options_json,'$.audienceRef'));
CREATE TRIGGER IF NOT EXISTS immutable_managed_event BEFORE UPDATE OF publisher_id,event_id,scope_id,scope_revision,captured_at,event_digest,event_bytes,options_json,options_digest,valid_until ON managed_events
WHEN OLD.publisher_id IS NOT NEW.publisher_id OR OLD.event_id IS NOT NEW.event_id OR OLD.scope_id IS NOT NEW.scope_id OR OLD.scope_revision IS NOT NEW.scope_revision OR OLD.captured_at IS NOT NEW.captured_at OR OLD.event_digest IS NOT NEW.event_digest OR OLD.event_bytes IS NOT NEW.event_bytes OR OLD.options_json IS NOT NEW.options_json OR OLD.options_digest IS NOT NEW.options_digest OR OLD.valid_until IS NOT NEW.valid_until
BEGIN SELECT RAISE(ABORT,'immutable managed event'); END;
CREATE TABLE IF NOT EXISTS event_tombstones (
 publisher_id TEXT NOT NULL, event_id TEXT NOT NULL, operation_id TEXT NOT NULL, created_at INTEGER NOT NULL, retain_until INTEGER NOT NULL,
 PRIMARY KEY(publisher_id,event_id)
);
CREATE TABLE IF NOT EXISTS route_controls (
 control_id TEXT PRIMARY KEY, publisher_id TEXT NOT NULL, event_id TEXT NOT NULL, route_ref TEXT NOT NULL,
 disposition TEXT NOT NULL CHECK(disposition IN ('pending','prevented','too_late','unknown')),
 target_revision INTEGER NOT NULL DEFAULT 0, UNIQUE(publisher_id,event_id,route_ref)
);
CREATE TABLE IF NOT EXISTS source_responses (
 response_id TEXT PRIMARY KEY, publisher_id TEXT NOT NULL, event_id TEXT NOT NULL, route_ref TEXT NOT NULL,
 digest TEXT NOT NULL, body_json TEXT NOT NULL CHECK(json_valid(body_json)), source_cursor INTEGER NOT NULL UNIQUE,
 application_result_json TEXT CHECK(application_result_json IS NULL OR json_valid(application_result_json)),
 FOREIGN KEY(publisher_id,event_id) REFERENCES managed_events
);
CREATE TABLE IF NOT EXISTS source_control_ops (
 publisher_id TEXT NOT NULL, operation_id TEXT NOT NULL, digest TEXT NOT NULL,
 result_json TEXT NOT NULL CHECK(json_valid(result_json)), PRIMARY KEY(publisher_id,operation_id)
);
CREATE TABLE IF NOT EXISTS source_receipt_updates (
 cursor INTEGER PRIMARY KEY AUTOINCREMENT, publisher_id TEXT NOT NULL, event_id TEXT NOT NULL,
 route_ref TEXT NOT NULL, target_revision INTEGER NOT NULL,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), created_at INTEGER NOT NULL,
 UNIQUE(route_ref,target_revision)
);
CREATE TABLE IF NOT EXISTS application_ack_outbox (
 response_id TEXT NOT NULL REFERENCES source_responses(response_id), route_ref TEXT NOT NULL,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 sent INTEGER NOT NULL DEFAULT 0 CHECK(sent IN (0,1)), at INTEGER NOT NULL,
 PRIMARY KEY(response_id,route_ref)
);
CREATE TABLE IF NOT EXISTS managed_route_pending (
 publisher_id TEXT NOT NULL, event_id TEXT NOT NULL, route_ref TEXT NOT NULL,
 packet_json TEXT NOT NULL CHECK(json_valid(packet_json)),
 created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
 PRIMARY KEY(publisher_id,event_id,route_ref)
);
`;
export class Store {
  readonly db: Database.Database;
  readonly lock: OwnerLock;
  readonly dir: string;
  readonly epoch: number;
  readonly restored: boolean;
  private closed = false;
  constructor(
    dir: string,
    readonly kind: 'target' | 'source',
    identity: string,
    realm: string,
    lock?: OwnerLock,
  ) {
    this.dir = privateDir(dir);
    this.lock = lock ?? OwnerLock.acquireSync(join(this.dir, 'owner.lock'));
    const path = join(this.dir, kind === 'target' ? 'inbox.sqlite' : 'source.sqlite');
    let db: Database.Database | undefined;
    try {
      this.restored = existsSync(path);
      // Managed delivery additive migrations raise source 2→4 and target 1→2 (plan 04 §4.3).
      // All managed DDL is IF NOT EXISTS, so re-running the block for a newer
      // additive revision is safe on existing databases.
      const latest = kind === 'target' ? 2 : 4;
      for (const candidate of [path, path + '-wal', path + '-shm'])
        if (existsSync(candidate)) {
          const st = lstatSync(candidate);
          assertPrivateFileStat(st);
        }
      if (!this.restored) {
        const fd = openSync(
          path,
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
          0o600,
        );
        closeSync(fd);
        syncDir(this.dir);
      }
      db = new Database(path, { timeout: 100 });
      this.db = db;
      const version = db.pragma('user_version', { simple: true }) as number;
      if (version > latest) fail('newer_schema');
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = FULL');
      db.pragma('foreign_keys = ON');
      // Bound all durable metadata as well as payload quotas; FULL remains an atomic rejection.
      db.pragma(
        `max_page_count = ${Math.floor((512 * 1024 * 1024) / (db.pragma('page_size', { simple: true }) as number))}`,
      );
      this.tx(() => {
        db!.exec(COMMON);
        if (version === 0) {
          db!.exec(kind === 'target' ? TARGET + MANAGED_TARGET : SOURCE + MANAGED_SOURCE);
          db!.pragma('user_version = ' + latest);
        } else {
          // Additive migration (fix-wake-budget-v0.2.1 T01): recency of target presence.
          if (kind === 'source' && version === 1) {
            db!.exec('ALTER TABLE memberships ADD COLUMN last_seen INTEGER');
            db!.pragma('user_version = 2');
          }
          // Managed delivery (approved managed-delivery-v0.3): additive tables only;
          // old events gain no scope, digests and model modes are untouched.
          if (kind === 'source' && version <= 2) {
            db!.exec(MANAGED_SOURCE);
            db!.pragma('user_version = 3');
          }
          // Managed offline spool staging (stage 3.5): idempotent re-run adds
          // managed_route_pending to v3 databases.
          if (kind === 'source' && version <= 3) {
            db!.exec(MANAGED_SOURCE);
            db!.pragma('user_version = 4');
          }
          if (kind === 'target' && version <= 1) {
            db!.exec(MANAGED_TARGET);
            db!.pragma('user_version = 2');
          }
        }
        // Idempotent internal indexes (stage 2): present on every open regardless of
        // the migration ladder step, additive-only, never contract tables.
        if (kind === 'target') {
          db!.exec(
            'CREATE TABLE IF NOT EXISTS managed_route_index (route_ref TEXT PRIMARY KEY, binding TEXT NOT NULL, event_id TEXT NOT NULL); ' +
            'CREATE TABLE IF NOT EXISTS managed_scope_fence (scope_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL);',
          );
        }
        for (const [key, value] of Object.entries({ identity, realm, kind })) {
          const old = this.meta(key);
          invariant(old === undefined || old === value, 'invalid_state');
          this.setMeta(key, value);
        }
      });
      this.epoch = this.tx(() => {
        const epoch = Number(this.meta('epoch') ?? 0) + 1;
        invariant(Number.isSafeInteger(epoch));
        this.setMeta('epoch', String(epoch));
        return epoch;
      });
    } catch (e) {
      db?.close();
      this.lock.close();
      throw e;
    }
  }
  tx<T>(fn: () => T): T {
    this.lock.assertHeld();
    return this.db.transaction(fn).immediate();
  }
  get<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  all<T>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }
  run(sql: string, ...params: unknown[]): Database.RunResult {
    // Every durable write is fenced, including bare statements outside tx():
    // a superseded owner must fail before mutating shared state.
    this.lock.assertHeld();
    return this.db.prepare(sql).run(...params);
  }
  meta(key: string): string | undefined {
    return this.get<{ value: string }>('SELECT value FROM metadata WHERE key=?', key)?.value;
  }
  setMeta(key: string, value: string): void {
    this.run(
      'INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key,
      value,
    );
  }
  operation<T>(id: string, requestDigest: string): T | undefined {
    const row = this.get<{ digest: string; result: string }>('SELECT * FROM operations WHERE id=?', id);
    if (!row) return;
    invariant(row.digest === requestDigest, 'id_conflict');
    return JSON.parse(row.result) as T;
  }
  saveOperation(id: string, requestDigest: string, result: unknown): void {
    invariant((this.get<{ n: number }>('SELECT count(*) n FROM operations')?.n ?? 0) < 10000, 'backpressure');
    this.run('INSERT INTO operations VALUES(?,?,?)', id, requestDigest, canonical(result));
  }
  async backup(path: string): Promise<void> {
    invariant(!existsSync(path), 'id_conflict');
    await this.db.backup(path);
    chmodSync(path, 0o600);
  }
  integrity(): unknown {
    return this.db.pragma('integrity_check');
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } finally {
      this.lock.close();
    }
  }
}
