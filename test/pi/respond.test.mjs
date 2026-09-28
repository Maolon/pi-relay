import { it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createSource } from '../../dist/source/host.js';
import { createTarget } from '../../dist/target/host.js';
import { BUILTIN_TYPES } from '../../dist/protocol/validate.js';
import { secret, newId, sha256 } from '../../dist/protocol/canonical.js';
import { idle } from '../fixtures/system.mjs';
import {
  parseConsumerDeclaration,
  writeConsumerDeclaration,
  registerDeclarations,
} from '../../dist/consumer/index.js';
import { performRespond, managedDeliveryDetails } from '../../dist/pi/respond.js';

let source, target;
afterEach(async () => {
  await target?.close();
  await source?.close();
  source = target = undefined;
});

const OWNER = { kind: 'owner' };

// Minimal watcher.attention.v1 shape (field names are the watcher envelope
// contract — the respond data must round-trip exactly these).
const ENVELOPE_TYPE = {
  type: 'watcher.attention.v1',
  schemaVersion: 1,
  kind: 'event',
  dataSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      schemaVersion: { type: 'integer' },
      envelopeId: { type: 'string' },
      episodeId: { type: 'string' },
      episodeRevision: { type: 'integer' },
      watchId: { type: 'string' },
      generation: { type: 'integer' },
      missionRevision: { type: 'integer' },
      controlRevision: { type: 'integer' },
      ownerBindingEpoch: { type: 'integer' },
      target: { type: 'object' },
      reasonCode: { type: 'string' },
      summary: { type: 'string' },
      occurredAt: { type: 'string' },
      validUntil: { type: 'string' },
    },
    required: [
      'schemaVersion',
      'envelopeId',
      'episodeId',
      'episodeRevision',
      'watchId',
      'generation',
      'ownerBindingEpoch',
      'summary',
    ],
  },
};

function envelope(episodeId, episodeRevision = 1) {
  const now = Date.now();
  return {
    schemaVersion: 1,
    envelopeId: 'env-' + episodeId,
    episodeId,
    episodeRevision,
    watchId: 'watch-1',
    generation: 3,
    missionRevision: 1,
    controlRevision: 2,
    ownerBindingEpoch: 7,
    target: {},
    reasonCode: 'CHECK_FAILED',
    summary: 'watchdog detected a stuck build',
    occurredAt: new Date(now).toISOString(),
    validUntil: new Date(now + 120_000).toISOString(),
  };
}

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-respond-')));
  const home = join(root, 'state');
  source = await createSource({
    version: 1,
    sourceId: 'watcher-src',
    realm: 'test',
    home,
    ownerToken: secret(),
    publisherTokens: { X: secret() },
    channels: [
      { id: 'X', types: [...BUILTIN_TYPES, ENVELOPE_TYPE], allowedModes: ['display', 'resume'], maxAutoTargets: 2 },
    ],
  });
  target = await createTarget({ home, realm: 'test', fingerprint: sha256('respond-target') });
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
  target.core.control(bindingId, {
    operationId: newId('op'),
    expectedRevision: target.core.binding(bindingId).revision,
    action: 'arm',
    grant: { eventTypes: ['watcher.attention.v1'], maxClaims: 4, ttlMs: 600000 },
  });
  source.managed.advanceScope(OWNER, {
    operationId: newId('op'),
    scopeId: 'scope-w',
    expectedRevision: 0,
    nextRevision: 1,
    state: 'active',
  });
  const declHome = join(root, 'declhome');
  writeConsumerDeclaration(
    declHome,
    parseConsumerDeclaration({
      profileId: 'pi-watcher',
      eventTypes: ['watcher.attention.v1'],
      responseTypes: ['watcher.response.v1'],
      policy: { requireCurrentScope: false },
    }),
  );
  registerDeclarations(target.managed, declHome);
  return { root, declHome, bindingId };
}

async function publishAttention(episodeId, eventId) {
  const now = Date.now();
  const receipt = await source.managed.publishManaged(OWNER, {
    event: {
      kind: 'event',
      id: eventId,
      type: 'watcher.attention.v1',
      schemaVersion: 1,
      occurredAt: new Date(now).toISOString(),
      validUntil: new Date(now + 300_000).toISOString(),
      data: envelope(episodeId),
    },
    options: {
      audienceRef: 'aud-w',
      scope: { id: 'scope-w', revision: 1 },
      consumerProfileId: 'pi-watcher',
      requestedMode: 'resume',
    },
  });
  return receipt;
}

async function provisioned() {
  source.managed.provisionAudience(OWNER, {
    audienceRef: 'aud-w',
    channelId: 'X',
    consumerProfileId: 'pi-watcher',
    requestedMode: 'resume',
    validUntilMs: 3_600_000,
  });
}

it('[respond] wake → respond(received) → outbox carries the watcher HostAck contract', async () => {
  const { declHome } = await setup();
  await provisioned();
  await publishAttention('ep-1', 'evt-respond-1');
  let invoked = 0;
  const pump = await target.managed.pumpManaged(idle, async () => {
    invoked++;
    return { evidence: 'file-entry' };
  });
  expect(pump.claimed).toBe(1);
  expect(invoked).toBe(1);
  const delivery = target.managed.managedDeliveries()[0];
  expect(delivery.state).toBe('recorded');

  const result = performRespond(target.managed, declHome, {
    deliveryRef: delivery.deliveryRef,
    action: 'received',
    reason: 'host saw it',
    operationId: 'respond-op-1',
  });
  expect(result.responseType).toBe('watcher.response.v1');
  expect(result.state).toBe('target_staged');

  // operationId idempotency: same op + same body replays the same responseId.
  const replay = performRespond(target.managed, declHome, {
    deliveryRef: delivery.deliveryRef,
    action: 'received',
    reason: 'host saw it',
    operationId: 'respond-op-1',
  });
  expect(replay.responseId).toBe(result.responseId);
  expect(replay.duplicate).toBe(true);

  // same operationId with a different body is a conflict, not a silent edit.
  const conflictCode = (() => {
    try {
      performRespond(target.managed, declHome, {
        deliveryRef: delivery.deliveryRef,
        action: 'resolved',
        reason: 'host saw it',
        operationId: 'respond-op-1',
      });
    } catch (e) {
      return e.code;
    }
  })();
  expect(conflictCode).toBe('id_conflict');

  // The staged body is exactly the watcher readResponses contract.
  const outbox = target.core.store.get(
    "SELECT body_json FROM consumer_response_outbox WHERE response_id=?",
    result.responseId,
  );
  const body = JSON.parse(outbox.body_json).body;
  expect(body.data).toMatchObject({
    schemaVersion: 1,
    requestId: 'env-ep-1',
    watchId: 'watch-1',
    generation: 3,
    episodeId: 'ep-1',
    expectedEpisodeRevision: 1,
    action: 'received',
    reason: 'host saw it',
    evidenceIds: [],
    ownerBindingEpoch: 7,
  });
});

it('[respond] defer requires until; bad actions are rejected before any write', async () => {
  const { declHome } = await setup();
  await provisioned();
  await publishAttention('ep-2', 'evt-respond-2');
  const delivery = target.managed.managedDeliveries()[0]; // pending is respondable
  const codes = ['defer-missing-until', 'bad-action'].map((variant) => {
    try {
      performRespond(
        target.managed,
        declHome,
        variant === 'defer-missing-until'
          ? { deliveryRef: delivery.deliveryRef, action: 'defer', reason: 'later' }
          : { deliveryRef: delivery.deliveryRef, action: 'postpone', reason: 'typo' },
      );
    } catch (e) {
      return e.code;
    }
  });
  expect(codes).toEqual(['invalid_payload', 'invalid_payload']);
  const deferred = performRespond(target.managed, declHome, {
    deliveryRef: delivery.deliveryRef,
    action: 'defer',
    reason: 'waiting on CI',
    until: '2026-09-19T12:00:00Z',
    operationId: 'respond-defer-1',
  });
  const outbox = target.core.store.get(
    'SELECT body_json FROM consumer_response_outbox WHERE response_id=?',
    deferred.responseId,
  );
  const body = JSON.parse(outbox.body_json).body;
  expect(body.data.until).toBe('2026-09-19T12:00:00Z');
  expect(body.data.action).toBe('defer');
});

it('[respond] terminal delivery states reject with invalid_state; no envelope rejects too', async () => {
  const { declHome } = await setup();
  await provisioned();
  await publishAttention('ep-3', 'evt-respond-3');
  const delivery = target.managed.managedDeliveries()[0];
  for (const state of ['expired', 'withdrawn', 'suppressed']) {
    target.core.store.run('UPDATE managed_deliveries SET state=? WHERE delivery_ref=?', state, delivery.deliveryRef);
    let code;
    try {
      performRespond(target.managed, declHome, {
        deliveryRef: delivery.deliveryRef,
        action: 'received',
        reason: 'x',
      });
    } catch (e) {
      code = e.code;
    }
    expect(code).toBe('invalid_state');
  }
  target.core.store.run("UPDATE managed_deliveries SET state='pending' WHERE delivery_ref=?", delivery.deliveryRef);

  // A delivery whose event carries no attention envelope has nothing to
  // respond to (watcher readResponses would skip it).
  const now = Date.now();
  await source.managed.publishManaged(OWNER, {
    event: {
      kind: 'event',
      id: 'evt-plain-1',
      type: 'process.exited.v1',
      schemaVersion: 1,
      occurredAt: new Date(now).toISOString(),
      validUntil: new Date(now + 300_000).toISOString(),
      data: { exitCode: 0 },
    },
    options: {
      audienceRef: 'aud-w',
      scope: { id: 'scope-w', revision: 1 },
      consumerProfileId: 'pi-watcher',
      requestedMode: 'resume',
    },
  });
  const plain = target.managed.managedDeliveries({ eventId: 'evt-plain-1' })[0];
  expect(plain).toBeDefined();
  const noEnvelope = (() => {
    try {
      performRespond(target.managed, declHome, { deliveryRef: plain.deliveryRef, action: 'received', reason: 'x' });
    } catch (e) {
      return e.code;
    }
  })();
  expect(noEnvelope).toBe('invalid_state');

  // No declaration for the profile (empty home): no response channel.
  const noDeclaration = (() => {
    try {
      performRespond(target.managed, join(declHome, 'empty'), {
        deliveryRef: delivery.deliveryRef,
        action: 'received',
        reason: 'x',
      });
    } catch (e) {
      return e.code;
    }
  })();
  expect(noDeclaration).toBe('invalid_state');
});

it('[respond] wake details embed the attention envelope projection', async () => {
  const request = {
    event: { id: 'e1', type: 'watcher.attention.v1', data: envelope('ep-9', 4) },
    options: { scope: { id: 'scope-w', revision: 1 }, consumerProfileId: 'pi-watcher' },
  };
  const details = managedDeliveryDetails(request, 'mdel-x');
  expect(details.namespace).toBe('pi-relay/managed/delivery/v1');
  expect(details.envelope).toEqual({
    envelopeId: 'env-ep-9',
    episodeId: 'ep-9',
    episodeRevision: 4,
    watchId: 'watch-1',
    generation: 3,
    ownerBindingEpoch: 7,
  });
  const plain = managedDeliveryDetails(
    { event: { id: 'e2', type: 'process.exited.v1', data: { exitCode: 0 } }, options: { scope: {}, consumerProfileId: 'p' } },
    'mdel-y',
  );
  expect(plain.envelope).toBeUndefined();
  expect(plain.eventId).toBe('e2');
});
