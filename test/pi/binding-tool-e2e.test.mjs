import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { piFixture } from '../fixtures/pi.mjs';
import { providerFixture } from '../fixtures/provider.mjs';
import { createSource, BUILTIN_TYPES } from '../../dist/source/index.js';
import { secret, newId } from '../../dist/protocol/index.js';

// E2E: the real pi agent loop (openai-completions tool_calls path) dispatches a
// relay_bindings call from the provider to the extension's registered tool and
// posts the result back. This closes the LLM→tool gap that direct execute()
// tests could not: tool visibility in the request payload, real dispatch,
// real bind+arm side effects, and the tool result visible to the next turn.
let root, source, provider, fixtures = [];
afterEach(async () => {
  for (const f of fixtures.reverse()) await f?.close();
  fixtures = [];
  await source?.close();
  await provider?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  root = source = provider = undefined;
});

it('[tool-e2e] the agent loop dispatches relay_bindings from a tool_call and the binding really arms', async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-toole2e-')));
  const cwd = join(root, 'pi');
  mkdirSync(cwd, { mode: 0o700 });
  // invite file, as a companion CLI would print it
  await (async () => {
    const src = await createSource({
      version: 1,
      sourceId: 'exec',
      realm: 'test',
      home: join(root, 'state'),
      ownerToken: secret(),
      publisherTokens: { X: secret() },
      channels: [{ id: 'X', types: BUILTIN_TYPES, allowedModes: ['display', 'resume'], maxAutoTargets: 2 }],
    });
    source = src;
    const invitePath = join(root, 'invite.json');
    const { installPrivate } = await import('../../dist/platform/atomic-file.js');
    installPrivate(
      invitePath,
      src.core.createInvite({
        operationId: newId('inv'),
        channelId: 'X',
        ttlMs: 600000,
        bindingTtlMs: 3600000,
        allowResume: true,
      }),
    );
    provider = await providerFixture({
      script: [
        { toolCall: { name: 'relay_bindings', arguments: { action: 'bind', invitePath } } },
        { text: 'Canvas CLI bound and armed; relayed events will wake this session.' },
      ],
    });
    const pi = await piFixture({ home: join(root, 'state'), cwd, url: provider.url, noTools: 'builtin' });
    fixtures.push(pi);
    // one turn: provider issues the tool call, pi executes relay_bindings
    // against the real TargetHost, then the provider sees the result.
    await pi.session.prompt('Bind the canvas CLI using its invite file.');
    // real side effects on the host
    const bindings = pi.host.core.list();
    expect(bindings).toHaveLength(1);
    expect(bindings[0].state).toBe('active');
    const status = pi.host.core.status();
    expect(status.bindings[0].grants).toHaveLength(1);
    expect(status.bindings[0].grants[0].maxClaims).toBe(4);
    // protocol chain: 2 requests; the first offered the tool, the second
    // carried the tool result back to the provider.
    expect(provider.requests.length).toBe(2);
    const first = provider.requests[0],
      second = provider.requests[1];
    expect(JSON.stringify(first.tools)).toContain('relay_bindings');
    const secondText = JSON.stringify(second.messages);
    expect(secondText).toContain('call-fixture-1');
    expect(secondText).toMatch(/Bound as bnd-[0-9a-f]+ and armed/);
  })();
}, 30000);

it('[tool-e2e] list through the agent loop reports real binding state', async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-toole2e-')));
  const cwd = join(root, 'pi');
  mkdirSync(cwd, { mode: 0o700 });
  const src = await createSource({
    version: 1,
    sourceId: 'exec',
    realm: 'test',
    home: join(root, 'state'),
    ownerToken: secret(),
    publisherTokens: { X: secret() },
    channels: [{ id: 'X', types: BUILTIN_TYPES, allowedModes: ['display', 'resume'], maxAutoTargets: 2 }],
  });
  source = src;
  provider = await providerFixture({
    script: [
      { toolCall: { name: 'relay_bindings', arguments: { action: 'list' } } },
      { text: 'No bindings.' },
    ],
  });
  const pi = await piFixture({ home: join(root, 'state'), cwd, url: provider.url, noTools: 'builtin' });
  fixtures.push(pi);
  await pi.session.prompt('List relay bindings.');
  expect(provider.requests.length).toBe(2);
  const secondText = JSON.stringify(provider.requests[1].messages);
  expect(secondText).toContain('fingerprint');
  expect(secondText).toMatch(/bindings\\*": \\*\[\\*\]/); // pretty-printed empty bindings list
}, 30000);
