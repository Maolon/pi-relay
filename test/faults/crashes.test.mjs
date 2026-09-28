import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childFixture } from '../fixtures/child.mjs';
import { providerFixture } from '../fixtures/provider.mjs';
import { event, eventually } from '../fixtures/system.mjs';
import { BUILTIN_TYPES } from '../../dist/source/index.js';
import { secret } from '../../dist/protocol/index.js';
let root,
  provider,
  children = [];
afterEach(async () => {
  for (const c of children.reverse()) await c.close();
  children = [];
  await provider?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});
async function spawn(args) {
  const c = await childFixture(args);
  children.push(c);
  return c;
}
async function setup() {
  root = mkdtempSync(join(tmpdir(), 'relay-crash-'));
  provider = await providerFixture();
  const home = join(root, 'state');
  const config = {
    version: 1,
    sourceId: 'exec',
    realm: 'test',
    home,
    ownerToken: secret(),
    publisherTokens: { X: secret() },
    channels: [{ id: 'X', types: BUILTIN_TYPES, allowedModes: ['display', 'resume'], maxAutoTargets: 2 }],
  };
  return { config, home };
}
async function bind(source, target) {
  return target.call('bind', { invite: await source.call('invite', { channelId: 'X' }) });
}
it('[L07 I9] SIGKILL at committed intent produces unknown, consumes budget and never auto-replays', async () => {
  const { config, home } = await setup();
  const source = await spawn({ role: 'source', config });
  const args = { role: 'pi', home, cwd: join(root, 'a'), url: provider.url };
  let target = await spawn(args);
  await target.call('prompt', { text: 'flush initial session' });
  const file = target.ready.file;
  const id = await bind(source, target);
  await target.call('control', {
    bindingId: id,
    command: { action: 'arm', grant: { eventTypes: ['process.exited.v1'], maxClaims: 1, ttlMs: 600000 } },
  });
  const barrier = join(root, 'intent-barrier');
  await target.call('armFault', { point: 'target.after_intent_commit', barrier });
  const publication = source.call('publish', { value: event('crashed') }).catch(() => undefined);
  await eventually(() => existsSync(barrier));
  await target.kill();
  await publication;
  target = await spawn({ ...args, sessionFile: file });
  const receipt = await target.call('receipt', { bindingId: id, eventId: 'crashed' });
  expect(receipt.delivery.disposition).toBe('unknown');
  expect(provider.requests).toHaveLength(1);
  await target.call('control', { bindingId: id, command: { action: 'resume', holdReason: 'recovery' } });
  await target.call('control', {
    bindingId: id,
    command: { action: 'arm', grant: { eventTypes: ['process.exited.v1'], maxClaims: 1, ttlMs: 600000 } },
  });
  await source.call('publish', { value: event('crashed') });
  await new Promise((r) => setTimeout(r, 150));
  expect(provider.requests).toHaveLength(1);
}, 30000);
it('[M07 M09] Source SIGKILL after one materialization preserves the original recipient snapshot', async () => {
  const { config, home } = await setup();
  let source = await spawn({ role: 'source', config });
  const a = await spawn({ role: 'pi', home, cwd: join(root, 'a'), url: provider.url }),
    b = await spawn({ role: 'pi', home, cwd: join(root, 'b'), url: provider.url });
  const aid = await bind(source, a),
    bid = await bind(source, b);
  const barrier = join(root, 'route-barrier');
  await source.call('armFault', { point: 'source.after_route_materialize', barrier });
  const publication = source.call('publish', { value: event('partial') }).catch(() => undefined);
  await eventually(() => existsSync(barrier));
  await source.kill();
  await publication;
  let staged = 0;
  for (const directory of readdirSync(join(home, 'targets')))
    for (const binding of readdirSync(join(home, 'targets', directory, 'bindings'))) {
      staged += readdirSync(join(home, 'targets', directory, 'bindings', binding, 'spool', 'pending')).filter(
        (x) => x.endsWith('.json'),
      ).length;
    }
  expect(staged).toBe(1);
  source = await spawn({ role: 'source', config });
  const c = await spawn({ role: 'pi', home, cwd: join(root, 'c'), url: provider.url });
  const cid = await bind(source, c);
  const replay = await source.call('replay');
  expect(replay[0].routes.map((r) => r.bindingId).sort()).toEqual([aid, bid].sort());
  await expect(c.call('receipt', { bindingId: cid, eventId: 'partial' })).rejects.toMatchObject({
    code: 'not_found',
  });
  expect(provider.requests).toHaveLength(0);
}, 30000);
