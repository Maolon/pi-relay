import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const denied = ['better-sqlite3', 'fs-ext', '@earendil-works/pi-coding-agent'];
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(s,c,n){if(${JSON.stringify(denied)}.some(x=>s===x||s.startsWith(x+'/')))throw Error('Forbidden client dependency: '+s);return n(s,c);}`,
    ),
);
await import('../dist/index.js');
await import('../dist/client/index.js');
for (const file of readdirSync('src/protocol').filter((f) => f.endsWith('.ts'))) {
  const source = readFileSync(join('src/protocol', file), 'utf8');
  assert(
    !/from\s+['"]\.\.\/(?:target|source|pi|store|transport)\//.test(source),
    file + ' violates protocol dependency direction',
  );
}
console.log('Protocol dependency direction and native/Pi-free SDK imports passed.');
