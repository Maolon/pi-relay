import { it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { writeFileSync, mkdtempSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { system, idle } from '../fixtures/system.mjs';
import {
  parseConsumerDeclaration,
  manifestDigestOf,
  declarationProfile,
  declarationGuard,
  writeConsumerDeclaration,
  listConsumerDeclarations,
  removeConsumerDeclaration,
  registerDeclarations,
} from '../../dist/consumer/index.js';

let f;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const FULL = {
  profileId: 'pi-watcher',
  displayName: 'pi-watcher',
  description: 'watches process exits',
  eventTypes: ['process.exited.v1'],
  responseTypes: ['watcher.response.v1'],
  requestedMode: 'resume',
  policy: { admission: 'auto', requireCurrentScope: true, timeoutMs: 1500 },
};

const EVENT = { type: 'process.exited.v1' };
const CONTEXT = {
  deliveryRef: 'mdel-x',
  bindingId: 'bnd-x',
  bindingRevision: 1,
  profileId: 'pi-watcher',
  sourceId: 's',
  channelId: 'X',
  scopeId: 'scope-1',
  scopeRevision: 1,
};

it('[stage 4] parses full declarations and applies defaults', () => {
  const full = parseConsumerDeclaration(FULL);
  expect(full.profileId).toBe('pi-watcher');
  expect(full.policy).toEqual({ admission: 'auto', requireCurrentScope: true, timeoutMs: 1500 });
  const minimal = parseConsumerDeclaration({ profileId: 'x-1', eventTypes: ['a.b.v1'] });
  expect(minimal.requestedMode).toBe('resume');
  expect(minimal.policy).toEqual({ admission: 'auto', requireCurrentScope: true, timeoutMs: 2000 });
  expect(minimal.responseTypes).toEqual([]);
});

it('[stage 4] rejects malformed declarations', () => {
  const bad = [
    { profileId: '-bad', eventTypes: ['a.b.v1'] },
    { profileId: 'ok', eventTypes: [] },
    { profileId: 'ok', eventTypes: ['not-a-type'] },
    { profileId: 'ok', eventTypes: ['a.b.v1'], policy: { admission: 'sometimes' } },
    { profileId: 'ok', eventTypes: ['a.b.v1'], policy: { timeoutMs: 50 } },
    { profileId: 'ok', eventTypes: ['a.b.v1'], policy: { timeoutMs: 20000 } },
    { eventTypes: ['a.b.v1'] },
  ];
  for (const input of bad) expect(() => parseConsumerDeclaration(input)).toThrow();
});

it('[stage 4] manifest digests are deterministic and order-sensitive', () => {
  expect(manifestDigestOf(['a.v1', 'b.v2'])).toBe(manifestDigestOf(['a.v1', 'b.v2']));
  expect(manifestDigestOf(['a.v1', 'b.v2'])).not.toBe(manifestDigestOf(['b.v2', 'a.v1']));
  const profile = declarationProfile(parseConsumerDeclaration(FULL));
  expect(profile.guardImplementationId).toBe('declaration:auto:scoped');
  expect(profile.timeoutMs).toBe(1500);
  expect(profile.requireCurrentScope).toBe(true);
});

it('[stage 4] policy guard: allow subscribed, defer unsubscribed and held', async () => {
  const guard = declarationGuard(parseConsumerDeclaration(FULL));
  const allowed = await guard(EVENT, CONTEXT, new AbortController().signal);
  expect(allowed.decision).toBe('allow');
  const other = await guard({ type: 'other.v9' }, CONTEXT, new AbortController().signal);
  expect(other.decision).toBe('defer');
  expect(other.reasonCode).toBe('BUSY');
  const held = declarationGuard(parseConsumerDeclaration({ ...FULL, policy: { admission: 'hold' } }));
  const heldResult = await held(EVENT, CONTEXT, new AbortController().signal);
  expect(heldResult.decision).toBe('defer');
  expect(heldResult.reasonCode).toBe('BUSY');
});

it('[stage 4] declaration files roundtrip: write, list, force, remove', () => {
  f = undefined; // no relay system needed
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'relay-decl-')));
  chmodSync(home, 0o700);
  const decl = parseConsumerDeclaration(FULL);
  const { file } = writeConsumerDeclaration(home, decl);
  expect(file.endsWith('pi-watcher.json')).toBe(true);
  expect(() => writeConsumerDeclaration(home, decl)).toThrow();
  writeConsumerDeclaration(home, decl, { force: true });
  const listed = listConsumerDeclarations(home);
  expect(listed).toHaveLength(1);
  expect(listed[0].declaration.profileId).toBe('pi-watcher');
  expect(removeConsumerDeclaration(home, 'pi-watcher')).toBe(true);
  expect(removeConsumerDeclaration(home, 'pi-watcher')).toBe(false);
  expect(listConsumerDeclarations(home)).toHaveLength(0);
});

it('[stage 4] registerDeclarations registers good files, reports bad ones, epoch bumps on rescan', async () => {
  f = await system({ targets: 1 });
  const managed = f.target[0].managed;
  const home = join(f.root, 'decl-home');
  writeConsumerDeclaration(home, parseConsumerDeclaration(FULL));
  writeFileSync(
    join(home, 'consumers', 'broken.json'),
    JSON.stringify({ profileId: 'broken', eventTypes: 'nope' }),
  );
  const scan = registerDeclarations(managed, home);
  expect(scan.registered).toHaveLength(1);
  expect(scan.registered[0].profileId).toBe('pi-watcher');
  expect(scan.registered[0].epoch).toBe(1);
  expect(scan.failed).toHaveLength(1);
  expect(scan.failed[0].file.endsWith('broken.json')).toBe(true);
  const again = registerDeclarations(managed, home);
  expect(again.registered[0].epoch).toBe(2);
  const consumers = managed.listConsumers();
  expect(consumers).toHaveLength(1);
  expect(consumers[0].profileId).toBe('pi-watcher');
  expect(consumers[0].guardLive).toBe(true);
  const revoked = managed.revokeConsumer('pi-watcher');
  expect(revoked.revoked).toBe(true);
  expect(managed.revokeConsumer('pi-watcher').revoked).toBe(false);
  expect(managed.listConsumers()).toHaveLength(0);
  void idle;
});
