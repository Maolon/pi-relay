import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { piFixture } from '../fixtures/pi.mjs';
import { providerFixture } from '../fixtures/provider.mjs';
import { eventually } from '../fixtures/system.mjs';

// Session mail (delta-3) through two real Pi agent sessions: session A's
// provider issues a relay_mail tool call, the real agent loop dispatches it,
// and session B — idle — is woken by the mail and sends it to its provider.
let root, fixtures = [], providers = [];
afterEach(async () => {
  for (const f of fixtures.reverse()) await f?.close();
  for (const p of providers) await p?.close();
  fixtures = [];
  providers = [];
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

it('[mail-e2e] a relay_mail tool call in session A wakes idle session B with the message', async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-maile2e-')));
  const home = join(root, 'state');
  const cwdA = join(root, 'a'),
    cwdB = join(root, 'b');
  mkdirSync(cwdA, { mode: 0o700 });
  mkdirSync(cwdB, { mode: 0o700 });

  const providerB = await providerFixture({ script: [{ text: 'Noted the build status.' }] });
  providers.push(providerB);
  const b = await piFixture({ home, cwd: cwdB, url: providerB.url, noTools: 'builtin' });
  fixtures.push(b);
  const bId = b.manager.getSessionId();

  const providerA = await providerFixture({
    script: [
      { toolCall: { name: 'relay_mail', arguments: { verb: 'send', to: bId, body: 'build 17 is green' } } },
      { text: 'Told session B.' },
    ],
  });
  providers.push(providerA);
  const a = await piFixture({ home, cwd: cwdA, url: providerA.url, noTools: 'builtin' });
  fixtures.push(a);

  await a.session.prompt('Tell session B the build is green.');
  expect(JSON.stringify(providerA.requests[0].tools)).toContain('relay_mail');
  const toolResult = JSON.stringify(providerA.requests[1].messages);
  expect(toolResult).toContain('queued');
  expect(toolResult).toContain(bId);

  // B was idle: the mail itself starts B's turn (no prompt from the test).
  await eventually(() => providerB.requests.length >= 1, 10000);
  const seen = JSON.stringify(providerB.requests[0].messages);
  expect(seen).toContain('[pi-relay mail]');
  expect(seen).toContain('build 17 is green');
  expect(seen).toContain('relay_mail with verb');
  await eventually(
    () =>
      b.manager
        .getEntries()
        .some((e) => e.type === 'custom_message' && e.details?.namespace === 'pi-relay/mail/v1'),
    10000,
  );
  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
}, 30000);
