import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import {
  transportEndpoint,
  assertPrivateDirStat,
  assertPrivateFileStat,
  secureEndpoint,
  removeEndpoint,
  fsyncDirectory,
  acquireExclusiveLockSync,
} from '../../dist/platform/os-interop.js';

let dir;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-os-interop-')));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('transport endpoint shape (platform matrix)', () => {
  it('POSIX: UDS path under the runtime dir with the 103-byte guard', () => {
    expect(transportEndpoint('darwin', dir)).toBe(join(dir, 's'));
    expect(transportEndpoint('linux', dir)).toBe(join(dir, 's'));
    const deep = join(dir, 'x'.repeat(120));
    expect(() => transportEndpoint('darwin', deep)).toThrowError(/Private filesystem boundary/);
  });
  it('win32: named pipe derived from the dir basename, sanitized', () => {
    const endpoint = transportEndpoint('win32', dir);
    expect(endpoint).toMatch(/^\\\\\.\\pipe\\pi-relay-[A-Za-z0-9-]+$/);
    expect(endpoint).toContain(basename(dir).replace(/[^A-Za-z0-9-]/g, ''));
    expect(() => transportEndpoint('win32', join(dir, 'x'.repeat(160)))).not.toThrow();
  });
});

describe('ownership assertions', () => {
  it('win32: skips uid/mode bits but keeps type and symlink checks', () => {
    const fileStat = { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
    const dirStat = { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false };
    const linkStat = { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => true };
    expect(() => assertPrivateFileStat(fileStat, 'win32')).not.toThrow();
    expect(() => assertPrivateDirStat(dirStat, 'win32')).not.toThrow();
    expect(() => assertPrivateFileStat(linkStat, 'win32')).toThrowError(/Private filesystem boundary/);
    expect(() => assertPrivateDirStat(fileStat, 'win32')).toThrowError(/Private filesystem boundary/);
  });
  it('POSIX: rejects group/other accessible stats', () => {
    const st = {
      isFile: () => true,
      isSymbolicLink: () => false,
      uid: process.getuid?.() ?? 0,
      mode: 0o644,
    };
    expect(() => assertPrivateFileStat(st, 'linux')).toThrowError(/Private filesystem boundary/);
    const strict = { ...st, mode: 0o600 };
    expect(() => assertPrivateFileStat(strict, 'linux')).not.toThrow();
  });
  it('win32: secureEndpoint/removeEndpoint/fsyncDirectory are no-ops', () => {
    expect(secureEndpoint(join(dir, 's'), 'win32')).toBeUndefined();
    expect(() => removeEndpoint('\\\\.\\pipe\\pi-relay-x', undefined, 'win32')).not.toThrow();
    expect(() => fsyncDirectory(dir, 'win32')).not.toThrow();
  });
  it('POSIX: fsyncDirectory really fsyncs a real dir', () => {
    expect(() => fsyncDirectory(dir, 'darwin')).not.toThrow();
  });
});

describe('exclusive lock: Windows pid protocol (portable)', () => {
  it('acquires, blocks a second acquirer, releases, re-acquires', () => {
    const lockPath = join(dir, 'owner.lock');
    const lock = acquireExclusiveLockSync(lockPath, 'win32');
    expect(existsSync(lockPath)).toBe(true);
    expect(() => acquireExclusiveLockSync(lockPath, 'win32')).toThrowError(/Another owner holds/);
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
    const second = acquireExclusiveLockSync(lockPath, 'win32');
    second.release();
  });
  it('reclaims a stale lock left by a dead pid', () => {
    const lockPath = join(dir, 'owner.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: 999999999, startedAt: 0 }));
    const lock = acquireExclusiveLockSync(lockPath, 'win32');
    expect(existsSync(lockPath)).toBe(true);
    lock.release();
  });
  it('keeps a live foreign pid locked (owner_conflict)', () => {
    const lockPath = join(dir, 'owner.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid }));
    expect(() => acquireExclusiveLockSync(lockPath, 'win32')).toThrowError(/Another owner holds/);
  });
});

describe('exclusive lock: POSIX flock path', () => {
  it('flock excludes a second acquirer and frees on release', () => {
    const lockPath = join(dir, 'owner.lock');
    const lock = acquireExclusiveLockSync(lockPath, 'darwin');
    expect(() => acquireExclusiveLockSync(lockPath, 'darwin')).toThrow();
    lock.release();
    const second = acquireExclusiveLockSync(lockPath, 'linux');
    second.release();
  });
});
