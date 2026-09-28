import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { piFixture } from '../fixtures/pi.mjs';
import { providerFixture } from '../fixtures/provider.mjs';
import { createSource, BUILTIN_TYPES } from '../../dist/source/index.js';
import { secret, newId } from '../../dist/protocol/index.js';

// T07: /relay bind refuses a session whose file does not exist yet, unless
// --allow-unpersisted is passed. Slash commands alone never persist a session.
let root, source, provider, fixtures = [];
afterEach(async () => {
  for (const f of fixtures.reverse()) await f?.close();
  fixtures = [];
  await source?.close();
  await provider?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  root = source = provider = undefined;
});
async function fresh() {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-t07-')));
  const cwd = join(root, 'pi');
  mkdirSync(cwd, { mode: 0o700 });
  provider = await providerFixture();
  const pi = await piFixture({ home: join(root, 'state'), cwd, url: provider.url });
  fixtures.push(pi);
  source = await createSource({
    version: 1,
    sourceId: 'exec',
    realm: 'test',
    home: join(root, 'state'),
    ownerToken: secret(),
    publisherTokens: { X: secret() },
    channels: [{ id: 'X', types: BUILTIN_TYPES, allowedModes: ['display', 'resume'], maxAutoTargets: 2 }],
  });
  const inviteFile = join(root, 'invite.json');
  const { installPrivate } = await import('../../dist/platform/atomic-file.js');
  installPrivate(
    inviteFile,
    source.core.createInvite({
      operationId: newId('inv'),
      channelId: 'X',
      ttlMs: 600000,
      bindingTtlMs: 3600000,
      allowResume: true,
    }),
  );
  return { pi, inviteFile };
}

it('[T07] bind on a fresh unpersisted session is refused; one persisted turn or --allow-unpersisted unlocks it', async () => {
  const { pi, inviteFile } = await fresh();
  // Fresh session, no entries: the slash command must not create a binding.
  await pi.session.prompt('/relay bind ' + inviteFile + ' --resume');
  expect(pi.host.core.list()).toHaveLength(0); // refused; invite not consumed
  expect(source.core.store.all('SELECT count(*) n FROM memberships')[0].n).toBe(0);
  // One real model turn persists the session file; bind then succeeds.
  await pi.session.prompt('warm up so the session file exists');
  await pi.session.prompt('/relay bind ' + inviteFile + ' --resume');
  expect(pi.host.core.list()).toHaveLength(1);
}, 20000);

it('[T07] --allow-unpersisted binds a fresh session deliberately (explicitly unreachable after restart)', async () => {
  const { pi, inviteFile } = await fresh();
  await pi.session.prompt('/relay bind ' + inviteFile + ' --resume --allow-unpersisted');
  expect(pi.host.core.list()).toHaveLength(1);
}, 20000);
