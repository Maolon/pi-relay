import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const [manifest] = JSON.parse(
  execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }),
);
for (const file of manifest.files) {
  assert(
    !/(?:node_modules|^test\/|^artifacts\/|\.sqlite|capabilit|spool|auth\.json|\.tgz$)/.test(file.path),
    'Forbidden packed path ' + file.path,
  );
  if (file.path.endsWith('.map')) continue;
  const text = readFileSync(file.path, 'utf8');
  assert(
    !/synthetic-fixture-only|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{24,}/.test(
      text,
    ),
    'Secret fixture/key in ' + file.path,
  );
}
for (const path of [
  'dist/cli/index.js',
  'dist/pi/index.js',
  'dist/client/index.js',
  'dist/protocol/schemas/contracts.json',
  'README.md',
  'LICENSE',
])
  assert(
    manifest.files.some((f) => f.path === path),
    'Missing ' + path,
  );
mkdirSync('artifacts/implementation/T12', { recursive: true });
writeFileSync('artifacts/implementation/T12/package-manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`Package allowlist/secret scan passed: ${manifest.files.length} files, ${manifest.size} bytes.`);
