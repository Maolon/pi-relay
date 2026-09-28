import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { piFixture } from '../fixtures/pi.mjs';
import { providerFixture } from '../fixtures/provider.mjs';
import { event, progress, eventually } from '../fixtures/system.mjs';
import { createSource, BUILTIN_TYPES } from '../../dist/source/index.js';
import { secret, newId } from '../../dist/protocol/index.js';
let root, source, pi, provider;
afterEach(async () => {
  await source?.close();
  await pi?.close();
  await provider?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  root = source = pi = provider = undefined;
});
async function setup(options = {}) {
  root = mkdtempSync(join(tmpdir(), 'relay-pi-'));
  const cwd = join(root, 'pi');
  mkdirSync(cwd, { mode: 0o700 });
  provider = await providerFixture(options);
  pi = await piFixture({ home: join(root, 'state'), cwd, url: provider.url, ...options });
  source = await createSource({
    version: 1,
    sourceId: 'exec',
    realm: 'test',
    home: join(root, 'state'),
    ownerToken: secret(),
    publisherTokens: { X: secret() },
    channels: [{ id: 'X', types: BUILTIN_TYPES, allowedModes: ['display', 'resume'], maxAutoTargets: 2 }],
  });
  return cwd;
}
async function bind(resume = true) {
  return pi.host.bind(
    source.core.createInvite({
      operationId: newId('i'),
      channelId: 'X',
      ttlMs: 600000,
      bindingTtlMs: 3600000,
      allowResume: resume,
    }),
    { resume },
  );
}
function control(id, action, extra = {}) {
  return pi.host.core.control(id, {
    operationId: newId('op'),
    expectedRevision: pi.host.core.binding(id).revision,
    action,
    ...extra,
  });
}
function arm(id) {
  control(id, 'arm', { grant: { eventTypes: ['process.exited.v1'], maxClaims: 1, ttlMs: 600000 } });
}
it('[L01 L03 L22 L23 G25] real Pi records one authorized idle resume; fire-and-forget is not its receipt', async () => {
  let beforeStart = 0;
  await setup({
    extraExtensions: [
      (api) =>
        api.on('before_agent_start', () => {
          beforeStart++;
        }),
    ],
  });
  const id = await bind();
  arm(id);
  await source.core.publish('X', event('resume'));
  await eventually(() => provider.requests.length === 1);
  await eventually(() => pi.host.core.receipt(id, 'resume').delivery.observation?.evidence === 'file-entry');
  await source.core.publish('X', event('resume'));
  await new Promise((r) => setTimeout(r, 150));
  expect(provider.requests).toHaveLength(1);
  expect(beforeStart).toBe(0);
  expect(pi.errors).toEqual([]);
  const request = JSON.stringify(provider.requests[0]);
  expect(request).toContain('event=resume');
  expect(request).not.toContain(pi.host.core.handle(id).credential);
});
it('[L02 G04 G16 G17] progress and display cards never enter the model context', async () => {
  await setup();
  const id = await bind(false);
  for (let n = 1; n <= 500; n++) await source.core.publish('X', progress(n, 'tail', 'ui-only-' + n));
  await source.core.publish('X', event('display'));
  await new Promise((r) => setTimeout(r, 350));
  expect(provider.requests).toHaveLength(0);
  expect(
    pi.manager.getEntries().some((e) => e.type === 'custom' && e.customType === 'pi-relay.card.v1'),
  ).toBe(true);
  await pi.session.prompt('ordinary user input');
  expect(provider.requests).toHaveLength(1);
  expect(JSON.stringify(provider.requests[0])).not.toContain('ui-only-');
  expect(JSON.stringify(provider.requests[0])).not.toContain('event=display');
  expect(pi.host.core.receipt(id, 'display').presentation.state).toBe('unavailable');
});
it('[L04 L08 L18] busy real Pi retains events in its own Inbox until stable idle', async () => {
  await setup({ delayMs: 250 });
  const run = pi.session.prompt('foreground work');
  await eventually(() => provider.requests.length === 1);
  const id = await bind();
  arm(id);
  await source.core.publish('X', event('busy'));
  expect(pi.host.core.receipt(id, 'busy').delivery.disposition).toBe('pending');
  expect(pi.port.ctx.hasPendingMessages()).toBe(false);
  await run;
  await eventually(() => provider.requests.length === 2);
  await eventually(() => pi.host.core.receipt(id, 'busy').delivery.disposition === 'recorded');
});
it('[L06 L07 L16] known UI wait and foreground navigation hold block new resumes', async () => {
  await setup();
  const id = await bind();
  arm(id);
  await pi.session.extensionRunner.emit({ type: 'ui_prompt_start', id: 'fixture', method: 'confirm' });
  await source.core.publish('X', event('waiting'));
  await new Promise((r) => setTimeout(r, 80));
  expect(provider.requests).toHaveLength(0);
  await pi.session.extensionRunner.emit({ type: 'ui_prompt_end', id: 'fixture', method: 'confirm' });
  await eventually(() => provider.requests.length === 1);
  await eventually(() => pi.session.isStreaming === false);
  await pi.session.navigateTree(pi.manager.getEntries().find((e) => e.type === 'custom_message').id);
  expect(pi.host.core.holds(id)).toContain('navigation');
  arm(id);
  await source.core.publish('X', event('after-tree'));
  await new Promise((r) => setTimeout(r, 100));
  expect(provider.requests).toHaveLength(1);
});
it('[L10 L12 L25] restoring the same real session imports offline events but does not re-arm', async () => {
  const cwd = await setup();
  const id = await bind();
  arm(id);
  await source.core.publish('X', event('initial'));
  await eventually(() => pi.host.core.receipt(id, 'initial').delivery.observation?.evidence === 'file-entry');
  const file = pi.manager.getSessionFile();
  await pi.close();
  pi = undefined;
  const result = await source.core.publish('X', event('offline'));
  expect(result.routes[0].admission).toBe('staged');
  pi = await piFixture({ home: join(root, 'state'), cwd, url: provider.url, sessionFile: file });
  await new Promise((r) => setTimeout(r, 120));
  expect(provider.requests).toHaveLength(1);
  // invite/branch binding：保守仪式保留 — recovery hold 必须由 owner 手动 resume
  // （2026-09-21 自动恢复仅限 standing binding：本地信任已决策的唤醒通道）
  expect(pi.host.core.holds(id)).toContain('recovery');
  expect(pi.host.core.receipt(id, 'offline').acceptedAt).toBeGreaterThan(0);
  control(id, 'resume', { holdReason: 'recovery' });
  arm(id);
  await eventually(() => provider.requests.length === 2);
});
it('[L18 G18] strict-no-auto-resume cannot be bypassed by a valid grant', async () => {
  await setup({ strict: true });
  const id = await bind();
  arm(id);
  await source.core.publish('X', event('strict'));
  await new Promise((r) => setTimeout(r, 150));
  expect(provider.requests).toHaveLength(0);
  expect(pi.host.core.receipt(id, 'strict').delivery.disposition).toBe('pending');
});

it('[standing-navigation] normal turn completion or session activity auto-resumes standing bindings from navigation hold', async () => {
  await setup();
  const standingSource = await createSource({
    version: 1,
    sourceId: 'watcher-standing',
    realm: 'test',
    home: join(root, 'state'),
    ownerToken: secret(),
    publisherTokens: { W: secret() },
    channels: [{ id: 'W', types: BUILTIN_TYPES, allowedModes: ['display', 'resume'], maxAutoTargets: 1, localTrust: true }],
  });
  const r = await pi.host.bindLocal({ sourceId: 'watcher-standing', channelId: 'W' });
  expect(r.standing).toBe(true);
  const id = r.bindingId;

  // 模拟导航发生（如 /session 切换或 /tree）：holdAll('navigation')
  pi.host.core.holdAll('navigation');
  expect(pi.host.core.holds(id)).toContain('navigation');

  // 当会话进行回合交互时，standing binding 自动解除 navigation hold
  await pi.session.prompt('hello');
  await eventually(() => !pi.host.core.holds(id).includes('navigation'));

  await standingSource.close();
});
