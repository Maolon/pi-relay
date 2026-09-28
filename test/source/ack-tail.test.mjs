import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource } from '../../dist/source/host.js';
import { createTarget } from '../../dist/target/host.js';
import { BUILTIN_TYPES } from '../../dist/protocol/validate.js';
import { secret, newId, sha256 } from '../../dist/protocol/index.js';
import { idle } from '../fixtures/system.mjs';

// Regression (ack tail, m9/A10): the source's sync pump must deliver
// application acks to the target over the real transport. The bug: the
// managedRoute:<routeRef> meta write iterated the packets array BEFORE it
// was built (never wrote anything), so the ack loop's binding lookup hit
// `continue` on every pass — unsent acks forever, swallowed silently.
// These tests run source and target in separate homes over real UDS.

let source, target;
afterEach(async () => {
  await target?.close();
  await source?.close();
  source = target = undefined;
});

const OWNER = { kind: 'owner' };

async function ackTailFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-acktail-')));
  chmodSync(root, 0o700);
  source = await createSource({
    version: 1,
    sourceId: 'ack-src',
    realm: 'acktail',
    home: join(root, 'shome'),
    ownerToken: secret(),
    publisherTokens: { X: secret() },
    channels: [{ id: 'X', types: BUILTIN_TYPES, allowedModes: ['display', 'resume'], maxAutoTargets: 2 }],
  });
  await source.start(); // 500ms managedSync: receipt watch + ack delivery
  target = await createTarget({ home: join(root, 'thome'), realm: 'acktail', fingerprint: sha256('ack-target') });
  const bindingId = await target.bind(
    source.core.createInvite({
      operationId: newId('invite'),
      channelId: 'X',
      ttlMs: 600000,
      bindingTtlMs: 86400000,
      allowResume: true,
    }),
    { resume: true },
  );
  source.managed.advanceScope(OWNER, {
    operationId: newId('op'),
    scopeId: 'scope-a',
    expectedRevision: 0,
    nextRevision: 1,
    state: 'active',
  });
  source.managed.provisionAudience(OWNER, {
    audienceRef: 'aud-a',
    channelId: 'X',
    consumerProfileId: 'watcher-profile',
    requestedMode: 'resume',
    validUntilMs: 3_600_000,
  });
  const now = Date.now();
  const receipt = await source.managed.publishManaged(OWNER, {
    event: {
      kind: 'event',
      id: newId('evt'),
      type: 'process.exited.v1',
      schemaVersion: 1,
      occurredAt: new Date(now).toISOString(),
      validUntil: new Date(now + 300_000).toISOString(),
      data: { exitCode: 0 },
    },
    options: {
      audienceRef: 'aud-a',
      scope: { id: 'scope-a', revision: 1 },
      consumerProfileId: 'watcher-profile',
      requestedMode: 'resume',
    },
  });
  expect(receipt.routes).toHaveLength(1);
  target.managed.registerConsumer(
    {
      profileId: 'watcher-profile',
      eventManifestDigest: sha256('e'),
      responseManifestDigest: sha256('r'),
      guardImplementationId: 'test-guard',
      timeoutMs: 2000,
      requireCurrentScope: false,
    },
    async () => ({
      decision: 'allow',
      reasonCode: 'CURRENT',
      guardEpoch: 1,
      validUntil: new Date(Date.now() + 30_000).toISOString(),
    }),
  );
  target.core.control(bindingId, {
    operationId: newId('op'),
    expectedRevision: target.core.binding(bindingId).revision,
    action: 'arm',
    grant: { eventTypes: ['process.exited.v1'], maxClaims: 2, ttlMs: 600000 },
  });
  const pump = await target.managed.pumpManaged(idle, async () => ({ evidence: 'file-entry' }));
  expect(pump.claimed).toBe(1);
  const delivery = target.managed.managedDeliveries()[0];
  expect(delivery.state).toBe('recorded');
  const respond = target.managed.respond({
    operationId: newId('op'),
    deliveryRef: delivery.deliveryRef,
    responseType: 'watcher.response.v1',
    schemaVersion: 1,
    data: { episodeId: 'ep-1', action: 'received', reason: 'test', evidenceIds: [], ownerBindingEpoch: 1 },
  });
  expect(respond.state).toBe('target_staged');
  return { delivery };
}

async function eventually(check, timeoutMs = 10_000, everyMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) return undefined;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

it('[ack tail] sync pump delivers application acks to the target over real transport', async () => {
  const { delivery } = await ackTailFixture();
  // 1. receipt watch ingests the consumer-response fact into source_responses
  const responseId = await eventually(() =>
    Promise.resolve(
      source.core.store.get('SELECT response_id FROM source_responses LIMIT 1')?.response_id,
    ),
  );
  expect(responseId).toBeDefined();
  // 2. the route->binding meta is written at capture time (the original bug)
  const acks = source.managed.pendingAcks();
  expect(acks).toHaveLength(0); // nothing applied yet
  expect(
    source.core.store.meta(
      'managedRoute:' +
        source.core.store.get('SELECT route_ref FROM source_responses WHERE response_id=?', responseId).route_ref,
    ),
  ).toBeDefined();
  // 3. confirmApplied stages the ack; the 500ms pump must deliver it
  expect(
    source.managed.confirmApplied(OWNER, {
      operationId: newId('op'),
      responseId,
      result: { outcome: 'applied', applicationRevision: 2, code: 'APPLIED' },
    }).applied,
  ).toBe(true);
  const done = await eventually(() => {
    const inbox = target.core.store.get('SELECT COUNT(*) AS n FROM application_ack_inbox')?.n ?? 0;
    const state = target.core.store.get(
      'SELECT state FROM consumer_response_outbox WHERE response_id=?',
      responseId,
    )?.state;
    const unsent = source.managed.pendingAcks().length;
    return inbox > 0 && state === 'application_applied' && unsent === 0 ? { inbox, state, unsent } : undefined;
  });
  expect(done).toMatchObject({ inbox: 1, state: 'application_applied', unsent: 0 });
  void delivery;
});

it('[ack tail] deterministic recovery flushes acks from pre-fix stores (missing route meta)', async () => {
  const { delivery } = await ackTailFixture();
  const responseId = await eventually(() =>
    Promise.resolve(
      source.core.store.get('SELECT response_id FROM source_responses LIMIT 1')?.response_id,
    ),
  );
  expect(responseId).toBeDefined();
  // Simulate the pre-fix store: the route->binding meta was never written.
  const routeRow = source.core.store.get(
    'SELECT route_ref FROM source_responses WHERE response_id=?',
    responseId,
  );
  source.core.store.run('DELETE FROM metadata WHERE key=?', 'managedRoute:' + routeRow.route_ref);
  expect(source.managed.confirmApplied(OWNER, {
    operationId: newId('op'),
    responseId,
    result: { outcome: 'applied', applicationRevision: 2, code: 'APPLIED' },
  }).applied).toBe(true);
  // recoverRouteBinding derives bindingId = digest^-1({routeRef, eventId})
  // and persists the repaired meta, so the ack still ships.
  const done = await eventually(() => {
    const state = target.core.store.get(
      'SELECT state FROM consumer_response_outbox WHERE response_id=?',
      responseId,
    )?.state;
    return state === 'application_applied' && source.managed.pendingAcks().length === 0;
  });
  expect(done).toBe(true);
  expect(source.core.store.meta('managedRoute:' + routeRow.route_ref)).toBeDefined();
  void delivery;
});
