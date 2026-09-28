import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource, BUILTIN_TYPES } from '../../dist/source/index.js';
import { createTarget } from '../../dist/target/host.js';
import { secret, sha256, newId } from '../../dist/protocol/index.js';
export const idle = { idle: true, pending: false, knownWait: false, strictNoAutoResume: false };
export function event(id = newId('event'), data = { exitCode: 0 }) {
  return { kind: 'event', id, type: 'process.exited.v1', schemaVersion: 1, data };
}
export function progress(revision = 1, streamId = 'stream', tail = 'text') {
  return {
    kind: 'progress',
    type: 'process.progress.v1',
    schemaVersion: 1,
    streamId,
    revision,
    snapshot: { tail },
  };
}
export async function system({ targets = 2, maxAutoTargets = 2, clock, fault, sourceFault } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-test-'))),
    home = join(root, 'state');
  const clients = [];
  const config = {
    version: 1,
    sourceId: 'exec',
    realm: 'test',
    home,
    ownerToken: secret(),
    publisherTokens: { X: secret(), Y: secret() },
    channels: ['X', 'Y'].map((id) => ({
      id,
      types: BUILTIN_TYPES,
      allowedModes: ['display', 'resume'],
      maxAutoTargets,
    })),
  };
  const source = await createSource(config, { clock, fault: sourceFault });
  const target = [];
  for (let i = 0; i < targets; i++)
    target.push(
      await createTarget({ home, realm: 'test', fingerprint: sha256('target-' + i), clock, fault }),
    );
  const bind = async (index, channelId = 'X', resume = true, operationId) =>
    target[index].bind(
      source.core.createInvite({
        operationId: newId('invite'),
        channelId,
        ttlMs: 600000,
        bindingTtlMs: 86400000,
        allowResume: resume,
      }),
      { resume, operationId },
    );
  const control = (index, id, action, extra = {}) =>
    target[index].core.control(id, {
      operationId: newId('op'),
      expectedRevision: target[index].core.binding(id).revision,
      action,
      ...extra,
    });
  const arm = (index, id, extra = {}) =>
    control(index, id, 'arm', {
      grant: { eventTypes: ['process.exited.v1'], maxClaims: 1, ttlMs: 600000, ...extra },
    });
  return {
    root,
    home,
    config,
    source,
    target,
    bind,
    control,
    arm,
    clients,
    async close() {
      for (const c of clients) c.dispose();
      await source.close();
      for (const t of target) await t.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
export async function eventually(test, timeout = 5000) {
  const start = Date.now();
  let error;
  while (Date.now() - start < timeout) {
    try {
      const value = await test();
      if (value) return value;
    } catch (e) {
      error = e;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw error ?? new Error('Condition did not become true');
}
