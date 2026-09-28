import {
  constants,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  linkSync,
  unlinkSync,
  renameSync,
  lstatSync,
  readdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { canonical, newId } from '../protocol/canonical.js';
import { invariant } from '../protocol/errors.js';
import { readPrivate, syncDir, verifyDir } from './private-paths.js';
import type { FaultHook } from './clock.js';
export function installPrivate(path: string, value: unknown, fault?: FaultHook): void {
  const dir = dirname(path);
  verifyDir(dir);
  const temp = join(dir, `.${newId('tmp')}`),
    text = canonical(value) + '\n';
  let fd: number | undefined;
  try {
    fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    fault?.('stage.after_file_fsync');
    try {
      linkSync(temp, path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      invariant(readPrivate(path, Buffer.byteLength(text) + 1).text === text, 'id_conflict');
    }
    fault?.('stage.after_install_before_dir_fsync');
    syncDir(dir);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
      syncDir(dir);
    } catch {}
  }
}
/** Only replace owner-controlled discovery; immutable events always use installPrivate. */
export function replaceDiscovery(path: string, value: unknown): void {
  const dir = dirname(path);
  verifyDir(dir);
  const temp = join(dir, `.${newId('discovery')}`);
  installPrivate(temp, value);
  try {
    renameSync(temp, path);
    syncDir(dir);
  } finally {
    try {
      unlinkSync(temp);
    } catch {}
  }
}
export function removeIfSame(path: string, identity: { ino: number; dev: number }): boolean {
  try {
    const st = lstatSync(path);
    if (st.ino !== identity.ino || st.dev !== identity.dev || !st.isFile() || st.isSymbolicLink())
      return false;
    unlinkSync(path);
    syncDir(dirname(path));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}
export function directoryBytes(path: string): number {
  verifyDir(path);
  return readdirSync(path).reduce((sum, name) => {
    const st = lstatSync(join(path, name));
    invariant(st.isFile() && !st.isSymbolicLink(), 'unsafe_path');
    return sum + st.size;
  }, 0);
}
