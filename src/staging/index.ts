import { parseJson } from '../protocol/json.js';
import { join } from 'node:path';
import { readdirSync, renameSync } from 'node:fs';
import type { BindingHandle, RoutePacket } from '../protocol/types.js';
import { digest, proof, withoutProof, sha256, canonical } from '../protocol/canonical.js';
import { LIMITS, validate } from '../protocol/validate.js';
import { invariant, RelayError, safeError } from '../protocol/errors.js';
import { verifyDir, readPrivate, syncDir } from '../platform/private-paths.js';
import { directoryBytes, installPrivate, removeIfSame } from '../platform/atomic-file.js';
import type { FaultHook } from '../platform/clock.js';
import type { TargetCore } from '../target/core.js';
export function signPacket(unsigned: Omit<RoutePacket, 'proof'>, key: string): RoutePacket {
  return { ...unsigned, proof: proof('pi-relay/route-packet/v1', unsigned, key) };
}
export function stage(handle: BindingHandle, packet: RoutePacket, fault?: FaultHook): void {
  validate('BindingHandle', handle);
  validate('RoutePacket', packet);
  invariant(
    packet.bindingId === handle.bindingId &&
      packet.sourceId === handle.sourceId &&
      packet.channelId === handle.channelId,
    'unauthorized',
  );
  const dir = join(handle.spoolDir, 'pending');
  verifyDir(handle.spoolDir);
  verifyDir(dir);
  const file = join(dir, sha256(packet.event.id) + '.json');
  const size = Buffer.byteLength(canonical(packet)) + 1;
  // Existing immutable file is validated before applying quota to a retry.
  try {
    const existing = parseJson(readPrivate(file).text);
    invariant(digest(existing) === digest(packet), 'id_conflict');
    syncDir(dir);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  invariant(directoryBytes(dir) + size <= LIMITS.spoolBytes, 'backpressure');
  installPrivate(file, packet, fault);
}
export function importStaged(
  core: TargetCore,
  bindingId: string,
): { accepted: number; rejected: number; pending: number; errors: string[] } {
  const handle = core.handle(bindingId),
    pending = join(handle.spoolDir, 'pending'),
    quarantine = join(handle.spoolDir, 'quarantine');
  verifyDir(handle.spoolDir);
  verifyDir(pending);
  verifyDir(quarantine);
  const report = { accepted: 0, rejected: 0, pending: 0, errors: [] as string[] };
  for (const name of readdirSync(pending)
    .filter((n) => /^[a-f0-9]{64}\.json$/.test(n))
    .slice(0, 256)) {
    const path = join(pending, name);
    let identity: { ino: number; dev: number } | undefined;
    try {
      const read = readPrivate(path, LIMITS.frameBytes);
      identity = read;
      const packet = validate('RoutePacket', parseJson(read.text));
      invariant(packet.bindingId === bindingId, 'unauthorized');
      const result = core.admit(packet);
      core.options.fault?.('stage.after_admission_before_cleanup');
      core.store.run(
        'INSERT OR IGNORE INTO processed_stage VALUES(?,?,?,?)',
        bindingId,
        digest(packet),
        canonical(result),
        core.clock.now(),
      );
      removeIfSame(path, identity);
      report.accepted++;
    } catch (error) {
      const detail = safeError(error);
      // A superseded owner must not quarantine or delete staged packets: they
      // belong to the store, and the new owner imports them after takeover.
      if (detail.retryable || detail.code === 'subscription_provisioning' || detail.code === 'owner_superseded') {
        report.pending++;
        continue;
      }
      report.rejected++;
      report.errors.push(detail.code);
      if (identity) {
        // Preserve a bounded rejection receipt, never move a potentially replaced unverified inode.
        const tombstone = join(quarantine, name);
        try {
          if (directoryBytes(quarantine) < LIMITS.spoolBytes) {
            installPrivate(tombstone, {
              fileDigest: name.slice(0, 64),
              code: detail.code,
              at: core.clock.now(),
            });
            removeIfSame(path, identity);
          }
        } catch {}
      }
    }
  }
  return report;
}
