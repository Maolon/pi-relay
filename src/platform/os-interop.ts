// Platform interop seam (win32 portability, 2026-09-15 owner requirement).
//
// Everything with a platform-dependent semantic lives here so the protocol,
// framing, JSON-RPC shape, and all business logic stay platform-agnostic:
//   - transport endpoint shape: POSIX UDS path vs Windows named pipe
//     (\\.\pipe\pi-relay-<id>; AF_UNIX on Win10/11 was considered but named
//     pipes have no 103-byte path limit and are the conventional choice)
//   - ownership/privacy assertions: POSIX uid + mode bits vs Windows ACLs
//     (NTFS per-user profile isolation replaces the 0700/0600 bit checks)
//   - socket hardening: chmod 0600 + inode pinning (POSIX only)
//   - directory fsync: real fsync (POSIX) vs no-op (Windows has no durable
//     directory-handle flush with the same semantics)
//   - exclusive owner lock: flock (POSIX) vs proper-lockfile (Windows)
//
// The Framer, Request/Response validation, and every store/source/target
// module are untouched by this seam. `node:net` speaks named-pipe paths
// natively, so RpcClient is endpoint-agnostic by construction.
import {
  chmodSync,
  constants,
  lstatSync,
  openSync,
  closeSync,
  fsyncSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { invariant, fail } from '../protocol/errors.js';

// fs-ext (flock) is loaded lazily: the client SDK imports this module for
// path/stat helpers and must never load native flock code (see check-imports).
// Synchronous require keeps OwnerLock synchronous on both platforms.
type FsExt = { flockSync(fd: number, operation: 'exnb' | 'un'): void };
let fsExtModule: FsExt | undefined;
function fsExt(): FsExt {
  fsExtModule ??= createRequire(import.meta.url)('fs-ext') as FsExt;
  return fsExtModule;
}

export const isWindows = process.platform === 'win32';
export const supportedPlatform = isWindows || process.platform === 'darwin' || process.platform === 'linux';

/** Transport endpoint for the per-target RPC channel. Pure and testable. */
export function transportEndpoint(platform: string, dir: string): string {
  if (platform === 'win32') {
    const name = `pi-relay-${basename(dir).replace(/[^A-Za-z0-9-]/g, '')}`;
    return `\\\\.\\pipe\\${name}`;
  }
  const endpoint = join(dir, 's');
  invariant(Buffer.byteLength(endpoint) <= 103, 'unsafe_path');
  return endpoint;
}

/** Ownership/privacy check for a directory stat. Windows relies on per-user
 *  profile ACLs instead of POSIX uid + 0700 bits; the type/symlink checks stay. */
export function assertPrivateDirStat(st: Stats, platform = process.platform): void {
  invariant(st.isDirectory() && !st.isSymbolicLink(), 'unsafe_path');
  if (platform === 'win32') return;
  invariant(st.uid === process.getuid?.() && (st.mode & 0o777) === 0o700, 'unsafe_path');
}

/** Ownership/privacy check for a file stat (owner rw only). Windows: ACLs. */
export function assertPrivateFileStat(st: Stats, platform = process.platform): void {
  invariant(st.isFile() && !st.isSymbolicLink(), 'unsafe_path');
  if (platform === 'win32') return;
  invariant(st.uid === process.getuid?.() && (st.mode & 0o077) === 0, 'unsafe_path');
}

/** realpath identity check: skipped on Windows (case-insensitivity and 8.3
 *  short names make strict equality spuriously fail). */
export function assertRealpathStable(path: string, platform = process.platform): void {
  if (platform === 'win32') return;
  invariant(realpathSync(path) === resolve(path), 'unsafe_path');
}

export type EndpointIdentity = { ino: number; dev: number } | undefined;

/** Post-listen hardening of the socket node: chmod 0600 + inode pin (POSIX).
 *  Named pipes have no filesystem node on Windows — no-op there. */
export function secureEndpoint(endpoint: string, platform = process.platform): EndpointIdentity {
  if (platform === 'win32') return undefined;
  chmodSync(endpoint, 0o600);
  const st = lstatSync(endpoint);
  return { ino: st.ino, dev: st.dev };
}

/** Remove the transport node at shutdown (POSIX unlink vs Windows no-op). */
export function removeEndpoint(
  endpoint: string,
  identity: EndpointIdentity,
  platform = process.platform,
): void {
  if (platform === 'win32') return;
  try {
    const st = lstatSync(endpoint);
    if (identity && st.ino === identity.ino && st.dev === identity.dev) {
      unlinkSync(endpoint);
    }
  } catch {}
}

/** Durability flush for a directory after atomic file placement. No-op on
 *  Windows: directory-handle fsync has no equivalent semantic there, and the
 *  atomic-file layer already fsyncs the file itself on both platforms. */
export function fsyncDirectory(path: string, platform = process.platform): void {
  if (platform === 'win32') return;
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface ExclusiveLock {
  release(): void;
}

/** Synchronous cross-process exclusive lock around the owner file.
 *  POSIX: flock(2) via fs-ext — released by the kernel on process death.
 *  Windows: fs-ext is unavailable, so an O_EXCL lock file carrying the owner
 *  pid is created atomically; a live pid blocks (owner_conflict), a dead pid
 *  is reclaimed once (unlink + recreate, still O_EXCL so exactly one racer
 *  wins). This keeps OwnerLock synchronous on both platforms. Upgrading to
 *  LockFileEx/proper-lockfile later only touches this function. */
export function acquireExclusiveLockSync(path: string, platform = process.platform): ExclusiveLock {
  if (platform === 'win32') {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
        writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
        return {
          release: () => {
            try {
              unlinkSync(path);
            } catch {}
            closeSync(fd);
          },
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        let pid = 0;
        try {
          pid = JSON.parse(readFileSync(path, 'utf8')).pid ?? 0;
        } catch {}
        let alive = false;
        try {
          if (typeof pid === 'number' && pid > 0) process.kill(pid, 0);
          alive = true;
        } catch {}
        if (!alive) {
          try {
            unlinkSync(path);
          } catch {}
          continue; // exactly one racer recreates it via O_EXCL
        }
        fail('owner_conflict');
      }
    }
    fail('owner_conflict');
  }
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600);
  try {
    fsExt().flockSync(fd, 'exnb');
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  return {
    release: () => {
      try {
        fsExt().flockSync(fd, 'un');
      } finally {
        closeSync(fd);
      }
    },
  };
}
