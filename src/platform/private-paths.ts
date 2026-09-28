import {
  constants,
  mkdirSync,
  lstatSync,
  realpathSync,
  openSync,
  fstatSync,
  readFileSync,
  closeSync,
  existsSync,
} from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { invariant, fail } from '../protocol/errors.js';
import { parseJson } from '../protocol/json.js';
import { digest, newId } from '../protocol/canonical.js';
import { assertPrivateDirStat, assertPrivateFileStat, assertRealpathStable, fsyncDirectory, isWindows } from './os-interop.js';
export function privateDir(path: string): string {
  const full = resolve(path),
    parent = dirname(full);
  if (!existsSync(parent)) privateDir(parent);
  try {
    mkdirSync(full, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const st = lstatSync(full);
  assertPrivateDirStat(st);
  return realpathSync(full);
}
export function verifyDir(path: string): void {
  const st = lstatSync(path);
  assertPrivateDirStat(st);
  assertRealpathStable(path);
}
export function readPrivate(path: string, maxBytes = 131072): { text: string; ino: number; dev: number } {
  const initial = lstatSync(path);
  assertPrivateFileStat(initial);
  invariant(initial.size <= maxBytes, 'unsafe_path');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    assertPrivateFileStat(st);
    invariant(st.ino === initial.ino && st.dev === initial.dev && st.size <= maxBytes, 'unsafe_path');
    const buffer = readFileSync(fd);
    invariant(buffer.length <= maxBytes, 'invalid_payload');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      fail('invalid_payload');
    }
    return { text, ino: st.ino, dev: st.dev };
  } finally {
    closeSync(fd);
  }
}
export function privateJson(path: string, maxBytes = 131072): unknown {
  try {
    return parseJson(readPrivate(path, maxBytes).text);
  } catch (e) {
    if (e instanceof SyntaxError) fail('invalid_payload');
    throw e;
  }
}
export function syncDir(path: string): void {
  fsyncDirectory(path);
}
export function runtimeDir(): string {
  const parent = realpathSync(tmpdir());
  return privateDir(join(parent, newId('pr').slice(0, 24)));
}
export function sessionFingerprint(
  realm: string,
  sessionId: string,
  file?: string,
  instanceId = newId('ephemeral'),
): string {
  const canonicalFile = file
    ? join(realpathSync(dirname(resolve(file))), resolve(file).split('/').pop()!)
    : null;
  if (file && existsSync(file)) invariant(!lstatSync(file).isSymbolicLink(), 'unsafe_path');
  return digest({ realm, sessionId, file: canonicalFile, ephemeralInstance: file ? null : instanceId });
}
