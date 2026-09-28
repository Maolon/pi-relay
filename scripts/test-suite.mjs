import { spawnSync } from 'node:child_process';
const suites = {
  protocol: ['test/protocol'],
  store: ['test/store'],
  target: ['test/target'],
  transport: ['test/transport'],
  membership: ['test/membership'],
  source: ['test/source'],
  fanout: ['test/source', 'test/e2e'],
  staging: ['test/staging'],
  pi: ['test/pi'],
  controls: ['test/target', 'test/pi'],
  presentation: ['test/pi'],
  cli: ['test/cli'],
  e2e: ['test/e2e'],
  security: ['test/protocol', 'test/transport', 'test/staging', 'test/source'],
  faults: ['test/faults', 'test/membership', 'test/staging'],
};
const [suite, ...extra] = process.argv.slice(2);
if (!suites[suite]) throw Error('Unknown suite');
if (extra.length && !(suite === 'e2e' && extra.length === 1 && extra[0] === 'two-sessions'))
  throw Error('Unsupported filter: ' + extra.join(' '));
const child = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...suites[suite]], {
  stdio: 'inherit',
});
process.exitCode = child.status ?? 1;
