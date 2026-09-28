import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTarget } from '../../dist/target/host.js';
import { replaceDiscovery } from '../../dist/platform/atomic-file.js';
import { privateJson } from '../../dist/platform/private-paths.js';
import { sha256 } from '../../dist/protocol/index.js';

// L25 remediation: a stale mount's late cleanup must not delete or mutate a
// newer mount's discovery record or endpoint.
let root, host;
afterEach(async () => {
  await host?.close();
  host = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});
it('[L25] a stale close callback cannot delete or rewrite the next mount\'s discovery record', async () => {
  root = mkdtempSync(join(tmpdir(), 'relay-stale-'));
  const home = join(root, 'state');
  host = await createTarget({ home, realm: 'test', fingerprint: sha256('stale-target') });
  const file = join(host.core.store.dir, 'attachment.json');
  const current = privateJson(file);

  // A newer mount publishes its own discovery record over the same path
  // (atomic replacement, different attachment id, new inode).
  replaceDiscovery(file, { ...current, attachmentId: 'next-mount-attachment', endpoint: { ...current.endpoint } });
  expect(existsSync(file)).toBe(true);

  // The stale host's close runs its cleanup AFTER the new record is public:
  // the attachmentId guard must keep the file, and even an unguarded delete
  // would be stopped by the same-inode check (replacement changed the inode).
  await host.close();
  host = undefined;
  expect(existsSync(file)).toBe(true);
  const survivor = privateJson(file);
  expect(survivor.attachmentId).toBe('next-mount-attachment'); // content untouched

  // A legitimate owner's close still cleans up its own current record.
  const next = await createTarget({ home, realm: 'test', fingerprint: sha256('stale-target') });
  // The new owner's own attachmentId differs from the file it just claimed;
  // simulate it publishing its discovery, then closing removes only its own.
  const owned = privateJson(file);
  replaceDiscovery(file, { ...owned, attachmentId: next.core.attachmentId });
  await next.close();
  expect(existsSync(file)).toBe(false); // its own record, legitimately removed
}, 20000);
