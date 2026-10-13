import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { piFixture } from '../fixtures/pi.mjs';
import { providerFixture } from '../fixtures/provider.mjs';
import { event, eventually } from '../fixtures/system.mjs';
import { createSource, BUILTIN_TYPES } from '../../dist/source/index.js';
import { secret, newId } from '../../dist/protocol/index.js';

let root, source, pi, provider, bindingId;
const releases = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await source?.close();
  await pi?.close();
  await provider?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  root = source = pi = provider = bindingId = undefined;
});

function barrier() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  releases.push(release);
  return { promise, release };
}

const allow = () => ({
  decision: 'allow', reasonCode: 'CURRENT', guardEpoch: 1,
  validUntil: new Date(Date.now() + 30_000).toISOString(),
});

async function setup({ guard = async () => allow(), extraExtensions = [] } = {}) {
  root = mkdtempSync(join(tmpdir(), 'relay-managed-pi-'));
  const cwd = join(root, 'pi');
  mkdirSync(cwd, { mode: 0o700 });
  provider = await providerFixture();
  pi = await piFixture({ home: join(root, 'state'), cwd, url: provider.url, extraExtensions });
  source = await createSource({
    version: 1, sourceId: 'exec', realm: 'test', home: join(root, 'state'),
    ownerToken: secret(), publisherTokens: { X: secret() },
    channels: [{ id: 'X', types: BUILTIN_TYPES, allowedModes: ['display', 'resume'], maxAutoTargets: 2 }],
  });
  bindingId = await pi.host.bind(source.core.createInvite({
    operationId: newId('i'), channelId: 'X', ttlMs: 600000,
    bindingTtlMs: 3600000, allowResume: true,
  }), { resume: true });
  pi.host.core.control(bindingId, {
    operationId: newId('op'), expectedRevision: pi.host.core.binding(bindingId).revision,
    action: 'arm', grant: { eventTypes: ['process.exited.v1'], maxClaims: 2, ttlMs: 600000 },
  });
  pi.host.managed.registerConsumer({
    profileId: 'managed-profile', eventManifestDigest: 'events', responseManifestDigest: 'responses',
    guardImplementationId: 'test-guard', timeoutMs: 5000, requireCurrentScope: false,
  }, guard);
  source.managed.advanceScope({ kind: 'owner' }, {
    operationId: newId('op'), scopeId: 'scope', expectedRevision: 0, nextRevision: 1, state: 'active',
  });
  source.managed.provisionAudience({ kind: 'owner' }, {
    audienceRef: 'audience', channelId: 'X', consumerProfileId: 'managed-profile',
    requestedMode: 'resume', validUntilMs: 3600000,
  });
}

const publish = (id) => source.managed.publishManaged({ kind: 'owner' }, {
  event: {
    ...event(id), occurredAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 120000).toISOString(),
  },
  options: {
    audienceRef: 'audience', scope: { id: 'scope', revision: 1 },
    consumerProfileId: 'managed-profile', requestedMode: 'resume',
  },
});
const delivery = (id) => pi.host.managed.managedDeliveries().find((d) => d.eventId === id);
const consumed = () => pi.host.core.store.get(
  'SELECT consumed FROM grants WHERE binding=? AND active=1', bindingId,
).consumed;
const entries = () => pi.manager.getEntries().filter((e) =>
  e.type === 'custom_message' && e.customType === 'pi-relay.managed.delivery.v1');

function pumpResults() {
  const results = [];
  const pump = pi.host.managed.pumpManaged.bind(pi.host.managed);
  pi.host.managed.pumpManaged = async (...args) => {
    const result = await pump(...args);
    results.push(result);
    return result;
  };
  return results;
}

it('managed send stays submitted through real Pi startup; a matching late entry records it', async () => {
  const starting = barrier();
  let message;
  await setup({ extraExtensions: [(api) => api.on('before_agent_start', async (event) => {
    message = event.message;
    await starting.promise;
  })] });
  await publish('late-entry');
  await eventually(() => message && delivery('late-entry')?.state !== 'pending');
  expect(delivery('late-entry').state).toBe('submitted');
  expect(entries()).toEqual([]);
  expect(provider.requests).toHaveLength(0);
  expect(consumed()).toBe(1);

  // A real session entry with the wrong custom type is not delivery evidence.
  pi.manager.appendCustomMessageEntry('unrelated', message.content, true, message.details);
  await pi.port.observe();
  expect(delivery('late-entry').state).toBe('submitted');
  starting.release();
  await eventually(() => delivery('late-entry').state === 'recorded');
  expect(entries()).toHaveLength(1);
  expect(entries()[0].details.deliveryRef).toBe(delivery('late-entry').deliveryRef);
  await eventually(() => pi.session.isIdle);
  expect(provider.requests).toHaveLength(1);
  expect(pi.errors).toEqual([]);
});

it.each(['proof', 'guard'])('managed eligibility is refreshed after the %s await without consuming a grant', async (stage) => {
  const waiting = barrier();
  const starting = barrier();
  let entered = false, started = false, api;
  await setup({
    guard: async () => {
      if (stage === 'guard') { entered = true; await waiting.promise; }
      return allow();
    },
    extraExtensions: [(extension) => {
      api = extension;
      extension.on('before_agent_start', async (event) => {
        if (event.message.customType !== 'test.starting') return;
        started = true;
        await starting.promise;
      });
    }],
  });
  if (stage === 'proof') {
    const proof = pi.port.managed.proof;
    pi.port.managed.proof = async (...args) => {
      entered = true;
      await waiting.promise;
      return proof(...args);
    };
  }
  const results = pumpResults();
  await publish('became-busy');
  await eventually(() => entered);
  api.sendMessage({ customType: 'test.starting', content: 'other run', display: false },
    { triggerTurn: true, deliverAs: 'followUp' });
  await eventually(() => started);
  expect(pi.port.eligibility().idle).toBe(false);
  waiting.release();
  await eventually(() => results.some((r) => r.claimed > 0));
  expect(results.find((r) => r.claimed > 0).deferred).toBe(true);
  expect(delivery('became-busy').state).toBe('pending');
  expect(consumed()).toBe(0);
  expect(entries()).toEqual([]);
  expect(pi.port.ctx.hasPendingMessages()).toBe(false);
  const passes = results.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(results).toHaveLength(passes); // no setImmediate loop on a deferred pass

  starting.release();
  await eventually(() => delivery('became-busy').state === 'recorded');
  await eventually(() => pi.session.isIdle);
  expect(consumed()).toBe(1);
  expect(entries()).toHaveLength(1);
  expect(provider.requests).toHaveLength(2);
  expect(pi.errors).toEqual([]);
});

it('a managed pass rechecks eligibility between deliveries instead of queueing a second wake', async () => {
  const guarding = barrier();
  const starting = barrier();
  let entered = false, started = false;
  await setup({
    guard: async (event) => {
      if (event.id === 'first') { entered = true; await guarding.promise; }
      return allow();
    },
    extraExtensions: [(api) => api.on('before_agent_start', async (event) => {
      if (event.message.details.eventId !== 'first') return;
      started = true;
      await starting.promise;
    })],
  });
  const results = pumpResults();
  await publish('first');
  await eventually(() => entered);
  await publish('second');
  guarding.release();
  await eventually(() => started && results.some((r) => r.claimed > 0));
  expect(delivery('first').state).toBe('submitted');
  expect(delivery('second').state).toBe('pending');
  expect(consumed()).toBe(1);
  expect(pi.port.ctx.hasPendingMessages()).toBe(false);
  expect(results.find((r) => r.claimed > 0)).toEqual({ claimed: 1, deferred: true });
  starting.release();
  await eventually(() => delivery('first').state === 'recorded' && delivery('second').state === 'recorded');
  await eventually(() => pi.session.isIdle);
  expect(entries()).toHaveLength(2);
  expect(consumed()).toBe(2);
  expect(provider.requests).toHaveLength(2);
  expect(pi.errors).toEqual([]);
});
