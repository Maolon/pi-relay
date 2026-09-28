import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import type { ChannelConfig } from '../protocol/types.js';

/** Delta-2: read-only view of a source store inside the same relay home.
 *  A readonly WAL connection never takes the source owner-lock and never
 *  blocks the running source host; it cannot mutate anything. */
export interface SourceChannelView {
  realm: string;
  channel: ChannelConfig;
  discoveryFile: string;
}

export function readSourceChannel(
  home: string,
  sourceId: string,
  channelId: string,
): SourceChannelView | undefined {
  const dir = join(home, 'sources', createHash('sha256').update(sourceId).digest('hex'));
  const dbFile = join(dir, 'source.sqlite');
  if (!existsSync(dbFile)) return undefined;
  let db: Database.Database | undefined;
  try {
    db = new Database(dbFile, { readonly: true, timeout: 100 });
    const row = db
      .prepare('SELECT body FROM channels WHERE id=?')
      .get(channelId) as { body: string } | undefined;
    const realm = db
      .prepare("SELECT value FROM metadata WHERE key='realm'")
      .get() as { value: string } | undefined;
    if (!row || !realm) return undefined;
    return {
      realm: realm.value,
      channel: JSON.parse(row.body) as ChannelConfig,
      discoveryFile: join(dir, 'host.json'),
    };
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}
