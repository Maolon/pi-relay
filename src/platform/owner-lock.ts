import {
  constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, readdirSync, unlinkSync,
  writeSync, fsyncSync, renameSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { invariant, fail } from '../protocol/errors.js';
import { verifyDir, syncDir, privateDir } from './private-paths.js';
import { acquireExclusiveLockSync, assertPrivateFileStat, isWindows, supportedPlatform, type ExclusiveLock } from './os-interop.js';

const owners = new Set<string>();

/**
 * Ownership protocol (latest-active-wins with fencing):
 *
 * - `owner.lock` carries the cross-process lock (POSIX flock / Windows O_EXCL
 *   pid file). POSIX flock cannot be revoked, so a takeover is cooperative.
 * - `owner-token.json` names the CURRENT owner generation. Whoever holds the
 *   flock writes it; every write path verifies it before writing (fencing).
 * - `owner-challenges/` holds one file per live challenger
 *   ({generation, pid, at, deadline}). Each challenger owns exactly its own
 *   file: it removes it on success, failure, or timeout, so concurrent
 *   challengers never overwrite each other. An incumbent steps down only for
 *   a challenge that is unexpired AND whose pid is still alive — dead or
 *   timed-out challengers cannot evict a healthy incumbent.
 *
 * Serial safety: a challenger never writes before it holds the flock, and the
 * incumbent never writes after it fails a fence check, so writes never
 * interleave even though the fence check itself is advisory in timing.
 */

export interface OwnerToken {
  generation: number;
  pid: number;
  at: number;
}

export function ownerLockPath(dir: string): string {
  return join(privateDir(dir), 'owner.lock');
}

function tokenPath(dir: string): string {
  return join(privateDir(dir), 'owner-token.json');
}

function challengeDir(dir: string): string {
  // Creating semantics: callers both publish challenges and fence-scan here.
  return privateDir(join(privateDir(dir), 'owner-challenges'));
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const raw = readFileSync(path, 'utf8');
    if (raw.length > 512) return undefined;
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function readOwnerToken(dir: string): OwnerToken | undefined {
  const value = readJson(tokenPath(dir));
  if (value === undefined) return undefined;
  const generation = Number(value.generation),
    pid = Number(value.pid);
  if (!Number.isSafeInteger(generation) || generation < 0) return undefined;
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return { generation, pid, at: Number(value.at) || 0 };
}

/** Atomic private write: unique exclusive tmp file, then rename. */
function writeJson(path: string, value: Record<string, unknown>): void {
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 12)}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    assertPrivateFileStat(fstatSync(fd));
    writeSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  syncDir(dirname(path));
}

interface LiveChallenge {
  generation: number;
  pid: number;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scan the challenge directory. Returns live challenges (unexpired, pid
 * alive) and opportunistically removes abandoned ones so the directory stays
 * bounded. A dead or timed-out challenger must never evict an incumbent.
 */
function liveChallenges(dir: string, now: number): LiveChallenge[] {
  const result: LiveChallenge[] = [];
  const path = challengeDir(dir);
  let names: string[];
  try {
    names = readdirSync(path);
  } catch {
    return result;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = join(path, name);
    const value = readJson(file);
    const generation = Number(value?.generation),
      pid = Number(value?.pid),
      deadline = Number(value?.deadline);
    const wellFormed =
      Number.isSafeInteger(generation) && generation > 0 &&
      Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(deadline);
    if (!wellFormed || deadline < now || !pidAlive(pid)) {
      unlinkIfExists(file); // abandoned: expired or its process is gone
      continue;
    }
    result.push({ generation, pid });
  }
  return result;
}

export interface AcquireOptions {
  /** Take over from an earlier holder of the same store instead of failing. */
  takeover?: boolean;
  pollMs?: number;
  timeoutMs?: number;
}

export class OwnerLock {
  private lock?: ExclusiveLock;
  private lockFile?: number; // POSIX: fd of the lock node (kept open while held)
  readonly path: string;
  private readonly dir: string;
  private readonly generation: number;

  private constructor(path: string, lock: ExclusiveLock, lockFile: number | undefined, generation: number) {
    this.path = path;
    this.dir = dirname(path);
    this.lock = lock;
    this.lockFile = lockFile;
    this.generation = generation;
  }

  /** Synchronous immediate acquisition (fails fast; no takeover wait). */
  static acquireSync(path: string): OwnerLock {
    return OwnerLock.tryNow(path);
  }

  /** Fast path: try to become the owner right now. Fails with owner_conflict if held. */
  private static tryNow(path: string): OwnerLock {
    invariant(supportedPlatform, 'unsupported_feature');
    path = resolve(path);
    verifyDir(dirname(path));
    invariant(!owners.has(path), 'owner_conflict');
    if (isWindows) {
      // The Windows seam owns its lock node (O_EXCL pid file); pre-creating it
      // here would make acquisition fail with owner_conflict forever.
      const lock = acquireExclusiveLockSync(path);
      try {
        return OwnerLock.publish(path, lock, undefined);
      } catch (e) {
        lock.release();
        throw e;
      }
    }
    const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const st = fstatSync(fd),
        named = lstatSync(path);
      assertPrivateFileStat(st);
      invariant(st.ino === named.ino && st.dev === named.dev, 'unsafe_path');
      let lock: ExclusiveLock;
      try {
        lock = acquireExclusiveLockSync(path);
      } catch {
        fail('owner_conflict');
      }
      try {
        return OwnerLock.publish(path, lock, fd);
      } catch (e) {
        lock.release();
        throw e;
      } finally {
        // fd only pins the node for POSIX inode identity; the released lock no
        // longer needs it.
      }
    } catch (e) {
      closeSync(fd);
      throw e;
    }
  }

  /** Durable bookkeeping after the flock is held; registers in-process ownership. */
  private static publish(path: string, lock: ExclusiveLock, fd: number | undefined): OwnerLock {
    const release = () => {
      lock.release();
      owners.delete(path);
    };
    try {
      syncDir(dirname(path));
    } catch (e) {
      release();
      throw e;
    }
    const previous = readOwnerToken(dirname(path));
    const generation = (previous?.generation ?? 0) + 1;
    try {
      writeJson(tokenPath(dirname(path)), { generation, pid: process.pid, at: Date.now() });
    } catch (e) {
      release();
      throw e;
    }
    // Drop only abandoned challenges: live ones with a higher generation must
    // keep their right to evict us (they are newer requesters).
    liveChallenges(dirname(path), Date.now());
    owners.add(path);
    return new OwnerLock(path, lock, fd, generation);
  }

  static async acquire(path: string, options: AcquireOptions = {}): Promise<OwnerLock> {
    if (!options.takeover) return OwnerLock.tryNow(path);
    try {
      return OwnerLock.tryNow(path);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code !== 'owner_conflict') throw error;
    }
    // Held by another owner: publish our own challenge file and wait for the
    // incumbent to step down at its next fence check. We remove exactly our
    // file on every exit path, so concurrent challengers never interfere.
    const dir = dirname(resolve(path));
    const pollMs = options.pollMs ?? 100,
      timeoutMs = options.timeoutMs ?? 10_000;
    const challengeFile = join(
      challengeDir(dir),
      `${process.pid}-${randomUUID().slice(0, 8)}.json`,
    );
    try {
      const incumbent = readOwnerToken(dir);
      const generation = (incumbent?.generation ?? 0) + 1;
      writeJson(challengeFile, {
        generation,
        pid: process.pid,
        at: Date.now(),
        deadline: Date.now() + timeoutMs + 5_000,
      });
      const deadline = Date.now() + timeoutMs;
      let challenged = generation;
      for (;;) {
        await new Promise<void>((r) => setTimeout(r, pollMs));
        try {
          return OwnerLock.tryNow(path);
        } catch (error) {
          const code = (error as { code?: string })?.code;
          if (code !== 'owner_conflict') throw error;
          // Re-challenge if ownership moved while we waited: concurrent
          // challengers must not lose their place to an intermediate owner.
          const current = readOwnerToken(dir);
          if (current !== undefined && current.generation >= challenged) {
            challenged = current.generation + 1;
            writeJson(challengeFile, {
              generation: challenged,
              pid: process.pid,
              at: Date.now(),
              deadline: Date.now() + timeoutMs + 5_000,
            });
          }
          if (Date.now() >= deadline) fail('owner_conflict');
        }
      }
    } finally {
      unlinkIfExists(challengeFile);
    }
  }

  /** Fencing check: the current generation must still be ours. */
  assertHeld(): void {
    if (this.lock === undefined) fail('owner_superseded');
    const token = readOwnerToken(this.dir);
    if (token === undefined || token.pid !== process.pid || token.generation !== this.generation) {
      fail('owner_superseded');
    }
    for (const challenge of liveChallenges(this.dir, Date.now())) {
      // Strictly-greater is the safety hinge: a satisfied challenger's own
      // file names the same generation and never evicts; a later requester
      // (any pid, including our own process via a second attachment) does.
      if (challenge.generation > this.generation) {
        fail('owner_superseded');
      }
    }
  }

  close(): void {
    if (this.lock === undefined) return;
    const lock = this.lock,
      fd = this.lockFile;
    this.lock = undefined;
    this.lockFile = undefined;
    try {
      lock.release();
    } finally {
      // POSIX keeps the shared node (next owner re-flocks it); Windows removes
      // the pid lock file inside release(), so only clean up a stale node.
      if (isWindows) {
        try {
          unlinkSync(this.path);
        } catch {}
      } else if (fd !== undefined) {
        closeSync(fd);
      }
      owners.delete(this.path);
    }
  }
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}
