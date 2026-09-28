import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'relay-pack-'));
try {
  // npm <= 11 prints an array of packs, npm >= 12 an object keyed by package name.
  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], {
      encoding: 'utf8',
    }),
  );
  const [pack] = Array.isArray(packed) ? packed : Object.values(packed);
  const unpack = join(root, 'unpack');
  mkdirSync(unpack);
  execFileSync('tar', ['-xzf', join(root, pack.filename), '-C', unpack]);
  const pkg = join(unpack, 'package');
  assert(!existsSync(join(pkg, 'test')));
  symlinkSync(resolve('node_modules'), join(pkg, 'node_modules'), 'dir');
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "await import('./dist/index.js');await import('./dist/extension-missing.js').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e});const extension=await import('./dist/pi/index.js');if(typeof extension.default!=='function')throw Error('Missing Pi extension');",
    ],
    { cwd: pkg, stdio: 'inherit' },
  );
  // CJS consumers must resolve the exports map (require condition; the dist is
  // ESM, so this relies on require(esm) — Node >= 20.19 per engines).
  const probe = join(root, 'probe');
  mkdirSync(join(probe, 'node_modules', '@maolon'), { recursive: true });
  symlinkSync(pkg, join(probe, 'node_modules', '@maolon', 'pi-relay'), 'dir');
  execFileSync(
    process.execPath,
    [
      '--input-type=commonjs',
      '-e',
      "const c=require('@maolon/pi-relay/consumer');const s=require('@maolon/pi-relay/source');" +
        "if(typeof c.registerDeclarations!=='function'||typeof s.resetSource!=='function')" +
        "throw Error('CJS require through exports failed');",
    ],
    { cwd: probe, stdio: 'inherit' },
  );
  const doctor = JSON.parse(
    execFileSync(process.execPath, [join(pkg, 'dist/cli/index.js'), 'doctor'], { encoding: 'utf8' }),
  );
  assert(doctor);
  console.log(
    'Packed CLI and exports passed with the pinned development dependency tree. This is not an online clean install.',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
