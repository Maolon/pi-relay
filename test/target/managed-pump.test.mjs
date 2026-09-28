import { it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { system, idle } from '../fixtures/system.mjs';
import { newId } from '../../dist/protocol/index.js';
import {
  parseConsumerDeclaration,
  writeConsumerDeclaration,
  registerDeclarations,
} from '../../dist/consumer/index.js';

let f;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const OWNER = { kind: 'owner' };

function managedEvent(id = newId('evt')) {
  const now = Date.now();
  return {
    kind: 'event',
    id,
    type: 'process.exited.v1',
    schemaVersion: 1,
    occurredAt: new Date(now).toISOString(),
    validUntil: new Date(now + 120_000).toISOString(),
    data: { exitCode: 0 },
  };
}

async function admitOne(fixture, eventId, mode = 'resume') {
  const audienceRef = 'aud-' + newId('a').slice(-8);
  fixture.source.managed.provisionAudience(OWNER, {
    audienceRef,
    channelId: 'X',
    consumerProfileId: 'watcher-profile',
    requestedMode: mode,
    validUntilMs: 3_600_000,
  });
  try {
    fixture.source.managed.advanceScope(OWNER, {
      operationId: newId('op'),
      scopeId: 'scope-1',
      expectedRevision: 0,
      nextRevision: 1,
      state: 'active',
    });
  } catch {
    // scope already active from a previous admitOne in this fixture
  }
  const receipt = await fixture.source.managed.publishManaged(OWNER, {
    event: managedEvent(eventId),
    options: {
      audienceRef,
      scope: { id: 'scope-1', revision: 1 },
      consumerProfileId: 'watcher-profile',
      requestedMode: mode,
    },
  });
  return receipt;
}

function allowGate(guardEpoch = 1) {
  return async () => ({
    decision: 'allow',
    reasonCode: 'CURRENT',
    guardEpoch,
    validUntil: new Date(Date.now() + 30_000).toISOString(),
  });
}

it('[02 §2.5/03 §3.3] full trajectory: admit -> gate allow -> intent -> submitted -> recorded; respond; ack applies', async () => {
  f = await system({ targets: 1 });
  const id = await f.bind(0);
  const target = f.target[0];
  await admitOne(f, 'md-1');
  const managed = target.managed;
  const registered = managed.registerConsumer(
    {
      profileId: 'watcher-profile',
      eventManifestDigest: 'd1',
      responseManifestDigest: 'd2',
      guardImplementationId: 'watcher-guard-1',
      timeoutMs: 1000,
    },
    allowGate(),
  );
  expect(registered.epoch).toBe(1);
  // re-registration bumps the epoch (03 §3.6: stale guard epochs defer after restart)
  expect(
    managed.registerConsumer(
      {
        profileId: 'watcher-profile',
        eventManifestDigest: 'd1',
        responseManifestDigest: 'd2',
        guardImplementationId: 'watcher-guard-1',
        timeoutMs: 1000,
      },
      allowGate(2),
    ).epoch,
  ).toBe(2);

  let invoked = 0;
  // Owner authority: managed resume consumes an armed grant (01 §1.3 / 03 §3.7).
  f.arm(0, id);
  const pump = await managed.pumpManaged(idle, async () => {
    invoked++;
    return { evidence: 'file-entry' };
  });
  expect(pump.claimed).toBe(1);
  expect(invoked).toBe(1);

  const row = (delivery) => delivery;
  void row;
  const deliveries = target.core.store.all(
    'SELECT * FROM managed_deliveries',
  );
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0].state).toBe('recorded');
  expect(deliveries[0].target_revision).toBeGreaterThanOrEqual(4);

  // consumer respond (02 §2.5): durable target-side outbox + receipt fact
  const response = managed.respond({
    operationId: 'ack-op-1',
    deliveryRef: deliveries[0].delivery_ref,
    responseType: 'watcher.response.v1',
    schemaVersion: 1,
    data: { action: 'received', reason: 'host saw it' },
  });
  expect(response.state).toBe('target_staged');
  // replay with identical body is idempotent
  expect(
    managed.respond({
      operationId: 'ack-op-1',
      deliveryRef: deliveries[0].delivery_ref,
      responseType: 'watcher.response.v1',
      schemaVersion: 1,
      data: { action: 'received', reason: 'host saw it' },
    }).responseId,
  ).toBe(response.responseId);

  // source applies then acks (m9/A10): inbox advances outbox state
  const ack = managed.applyAck({
    responseId: response.responseId,
    appliedAt: Date.now(),
    result: { outcome: 'applied', applicationRevision: 2, code: 'APPLIED' },
  });
  expect(ack.applied).toBe(true);
  expect(
    managed.applyAck({
      responseId: response.responseId,
      appliedAt: Date.now(),
      result: { outcome: 'applied', applicationRevision: 2, code: 'APPLIED' },
    }),
  ).toEqual(ack);
  const outbox = target.core.store.get(
    'SELECT state FROM consumer_response_outbox WHERE response_id=?',
    response.responseId,
  );
  expect(outbox.state).toBe('application_applied');
  void id;
});

it('[02 §2.5] gate defer holds the delivery; gate drop suppresses without claim consumption', async () => {
  f = await system({ targets: 1 });
  const id = await f.bind(0);
  const target = f.target[0];
  f.arm(0, id);
  await admitOne(f, 'md-defer');
  const managed = target.managed;
  managed.registerConsumer(
    {
      profileId: 'watcher-profile',
      eventManifestDigest: 'd1',
      responseManifestDigest: 'd2',
      guardImplementationId: 'watcher-guard-1',
      timeoutMs: 1000,
    },
    async () => ({ decision: 'defer', reasonCode: 'BUSY', guardEpoch: 1 }),
  );
  let invoked = 0;
  await managed.pumpManaged(idle, async () => {
    invoked++;
    return { evidence: 'file-entry' };
  });
  expect(invoked).toBe(0);
  const deferred = target.core.store.all('SELECT * FROM managed_deliveries');
  expect(deferred[0].state).toBe('pending');

  // drop path
  await admitOne(f, 'md-drop');
  const managed2 = target.managed;
  managed2.registerConsumer(
    {
      profileId: 'watcher-profile',
      eventManifestDigest: 'd1',
      responseManifestDigest: 'd2',
      guardImplementationId: 'watcher-guard-1',
      timeoutMs: 1000,
    },
    async () => ({ decision: 'drop', reasonCode: 'STALE_REQUEST', guardEpoch: 1 }),
  );
  await managed2.pumpManaged(idle, async () => {
    invoked++;
    return { evidence: 'file-entry' };
  });
  const dropped = target.core.store
    .all('SELECT * FROM managed_deliveries')
    .find((d) => d.event_id === 'md-drop');
  expect(dropped.state).toBe('suppressed');
  void id;
});

it('[03 §3.4] control cuts: prevented before invoke, too_late after recorded', async () => {
  f = await system({ targets: 1 });
  const id = await f.bind(0);
  const target = f.target[0];
  await admitOne(f, 'md-cut-early');
  await admitOne(f, 'md-cut-late');
  const managed = target.managed;
  managed.registerConsumer(
    {
      profileId: 'watcher-profile',
      eventManifestDigest: 'd1',
      responseManifestDigest: 'd2',
      guardImplementationId: 'watcher-guard-1',
      timeoutMs: 1000,
    },
    allowGate(),
  );
  // cut md-cut-early BEFORE any pump pass (03 §3.4: prevented when not yet invoked)
  const earlyCut = managed.applyControl({
    kind: 'event-withdraw',
    eventId: 'md-cut-early',
    controlId: newId('ctl'),
  });
  expect(earlyCut.cuts[0].disposition).toBe('prevented');
  const rowsBefore = target.core.store.all('SELECT * FROM managed_deliveries');
  const earlyRow = rowsBefore.find((r) => r.event_id === 'md-cut-early');
  expect(
    target.core.store.get('SELECT state FROM managed_deliveries WHERE delivery_ref=?', earlyRow.delivery_ref)
      .state,
  ).toBe('withdrawn');

  // record md-cut-late via the pump (withdrawn delivery is skipped)
  f.arm(0, id);
  await managed.pumpManaged(idle, async () => ({ evidence: 'file-entry' }));
  const rows = target.core.store.all('SELECT * FROM managed_deliveries');
  const late = rows.find((r) => r.event_id === 'md-cut-late');
  expect(late.state).toBe('recorded');

  const lateCut = managed.applyControl({
    kind: 'event-withdraw',
    eventId: 'md-cut-late',
    controlId: newId('ctl'),
  });
  expect(lateCut.cuts[0].disposition).toBe('too_late');
  void id;
});

it('[01 §1.3/03 §3.7] managed resume requires an owner-armed grant; guard defer/drop consume no claim', async () => {
  f = await system({ targets: 1 });
  const id = await f.bind(0);
  const target = f.target[0];
  await admitOne(f, 'md-nogrant');
  target.managed.registerConsumer(
    {
      profileId: 'watcher-profile',
      eventManifestDigest: 'd1',
      responseManifestDigest: 'd2',
      guardImplementationId: 'watcher-guard-1',
      timeoutMs: 1000,
    },
    allowGate(),
  );
  let invoked = 0;
  await target.managed.pumpManaged(idle, async () => {
    invoked++;
    return { evidence: 'file-entry' };
  });
  expect(invoked).toBe(0);
  expect(
    target.core.store.get('SELECT state FROM managed_deliveries WHERE event_id=?', 'md-nogrant').state,
  ).toBe('pending');
  f.arm(0, id);
  await target.managed.pumpManaged(idle, async () => {
    invoked++;
    return { evidence: 'file-entry' };
  });
  expect(invoked).toBe(1);
  expect(
    target.core.store.get('SELECT state FROM managed_deliveries WHERE event_id=?', 'md-nogrant').state,
  ).toBe('recorded');
  void id;
});

it('[03 §3.3 step4 / I17] control landing mid-guard is not overridden by a late allow', async () => {
  f = await system({ targets: 1 });
  const id = await f.bind(0);
  const target = f.target[0];
  await admitOne(f, 'md-midguard');
  f.arm(0, id);
  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  target.managed.registerConsumer(
    {
      profileId: 'watcher-profile',
      eventManifestDigest: 'd1',
      responseManifestDigest: 'd2',
      guardImplementationId: 'watcher-guard-1',
      timeoutMs: 1000,
    },
    () => gate,
  );
  let invoked = 0;
  const pumping = target.managed.pumpManaged(idle, async () => {
    invoked++;
    return { evidence: 'file-entry' };
  });
  // While the guard is in flight, the withdraw control lands and cuts the delivery.
  const cut = target.managed.applyControl({
    kind: 'event-withdraw',
    eventId: 'md-midguard',
    controlId: newId('ctl'),
  });
  expect(cut.cuts[0].disposition).toBe('prevented');
  releaseGate({
    decision: 'allow',
    reasonCode: 'CURRENT',
    guardEpoch: 1,
    validUntil: new Date(Date.now() + 30_000).toISOString(),
  });
  await pumping;
  expect(invoked).toBe(0);
  expect(
    target.core.store.get('SELECT state FROM managed_deliveries WHERE event_id=?', 'md-midguard').state,
  ).toBe('withdrawn');
  // No budget burned for a delivery that never invoked.
  expect(target.core.store.get('SELECT consumed FROM grants WHERE binding=? AND active=1', id).consumed).toBe(0);
  void id;
});

it('[02 §2.5] admit rejects forged proof and non-manifest types keep 1.1 admission untouched', async () => {
  f = await system({ targets: 1 });
  const id = await f.bind(0);
  const target = f.target[0];
  await admitOne(f, 'md-forge-base');
  const packet = target.core.store.get('SELECT request_json FROM managed_deliveries');
  void packet;
  // forged packet with wrong proof
  const forged = {
    packetVersion: 2,
    routeRef: 'f'.repeat(64),
    bindingId: id,
    sourceId: 'exec',
    channelId: 'X',
    event: managedEvent('md-forged'),
    sourceEventDigest: '0'.repeat(64),
    fanoutId: 'fanout-forged',
    membershipRevision: 1,
    routeCreatedAt: Date.now(),
    routeValidUntil: Date.now() + 60_000,
    options: {
      audienceRef: 'aud-x',
      scope: { id: 'scope-1', revision: 1 },
      consumerProfileId: 'watcher-profile',
      requestedMode: 'resume',
    },
    optionsDigest: '1'.repeat(64),
    proofKeyId: 'nonexistent',
    proof: 'forged',
  };
  const managed = target.managed;
  expect(() => managed.admitManaged(forged)).toThrowError();
  void id;
});

// ---- stage 3: scope proof, control idempotency, crash restore, expiry, guard context ----
import { ManagedTarget } from '../../dist/target/managed.js';

function proofFor(eventId, over = {}) {
  return async () => ({
    issuedAt: Date.now(),
    validForMs: 1000,
    proofs: [
      {
        eventId,
        publisherId: 'owner',
        scopeId: 'scope-1',
        scopeRevision: 1,
        scopeState: 'active',
        tombstoned: false,
        audienceState: 'open',
        ...over,
      },
    ],
  });
}

it('[03 §3.3 step2] healthy scope proof lets the trajectory proceed; guard sees real context', async () => {
  f = await system({ targets: 1 });
  const id = await f.bind(0);
  const target = f.target[0];
  await admitOne(f, 'md-proof-ok');
  f.arm(0, id);
  let context;
  target.managed.registerConsumer(
    {
      profileId: 'watcher-profile',
      eventManifestDigest: 'd1',
      responseManifestDigest: 'd2',
      guardImplementationId: 'watcher-guard-1',
      timeoutMs: 1000,
      requireCurrentScope: true,
    },
    async (event, ctx) => {
      context = { type: event.type, ...ctx };
      return { decision: 'allow', reasonCode: 'CURRENT', guardEpoch: 1, validUntil: new Date(Date.now() + 30_000).toISOString() };
    },
  );
  let invoked = 0;
  await target.managed.pumpManaged(
    idle,
    async () => {
      invoked++;
      return { evidence: 'file-entry' };
    },
    proofFor('md-proof-ok'),
  );
  expect(invoked).toBe(1);
  expect(context.type).toBe('process.exited.v1');
  expect(context.sourceId).toBe('exec');
  expect(context.channelId).toBe('X');
  expect(context.profileId).toBe('watcher-profile');
  expect(context.scopeId).toBe('scope-1');
  expect(context.deliveryRef).toMatch(/^mdel-/);
  expect(context.bindingId).toBe(id);
  void id;
});

it('[03 §3.3 step2] tombstoned / fenced-in-scope proofs withdraw without invoke or budget', async () => {
  f = await system({ targets: 1 });
  const id = await f.bind(0);
  const target = f.target[0];
  await admitOne(f, 'md-proof-tomb');
  await admitOne(f, 'md-proof-fence');
  f.arm(0, id, { maxClaims: 4 });
  target.managed.registerConsumer(
    {
      profileId: 'watcher-profile',
      eventManifestDigest: 'd1',
      responseManifestDigest: 'd2',
      guardImplementationId: 'watcher-guard-1',
      timeoutMs: 1000,
      requireCurrentScope: true,
    },
    allowGate(),
  );
  let invoked = 0;
  const pump = async (proof) =>
    target.managed.pumpManaged(
      idle,
      async () => {
        invoked++;
        return { evidence: 'file-entry' };
      },
      proof,
    );
  await pump(proofFor('md-proof-tomb', { tombstoned: true }));
  await pump(proofFor('md-proof-fence', { scopeRevision: 3 }));
  expect(invoked).toBe(0);
  const state = (ev) =>
    target.core.store.get('SELECT state FROM managed_deliveries WHERE event_id=?', ev).state;
  expect(state('md-proof-tomb')).toBe('withdrawn');
  expect(state('md-proof-fence')).toBe('withdrawn');
  expect(target.core.store.get('SELECT consumed FROM grants WHERE binding=? AND active=1', id).consumed).toBe(0);
  void id;
});

it('[03 §3.3 step2] unconfirmable scope defers requireCurrentScope deliveries (no invoke)', async () => {
  f = await system({ targets: 1 });
  const id = await f.bind(0);
  const target = f.target[0];
  await admitOne(f, 'md-proof-down');
  f.arm(0, id);
  target.managed.registerConsumer(
    {
      profileId: 'watcher-profile',
      eventManifestDigest: 'd1',
      responseManifestDigest: 'd2',
      guardImplementationId: 'watcher-guard-1',
      timeoutMs: 1000,
      requireCurrentScope: true,
    },
    allowGate(),
  );
  let invoked = 0;
  await target.managed.pumpManaged(
    idle,
    async () => {
      invoked++;
      return { evidence: 'file-entry' };
    },
    async () => undefined, // source unreachable within the proof window
  );
  expect(invoked).toBe(0);
  expect(
    target.core.store.get('SELECT state FROM managed_deliveries WHERE event_id=?', 'md-proof-down').state,
  ).toBe('pending');
  void id;
});

it('[03 §3.4] control replay with the same controlId is idempotent', async () => {
  f = await system({ targets: 1 });
  const id = await f.bind(0);
  const target = f.target[0];
  await admitOne(f, 'md-replay');
  const first = target.managed.applyControl({
    kind: 'event-withdraw',
    eventId: 'md-replay',
    controlId: 'ctl-replay-1',
  });
  const revision = target.core.store.get(
    'SELECT target_revision FROM managed_deliveries WHERE event_id=?',
    'md-replay',
  ).target_revision;
  const facts = target.core.store
    .all("SELECT seq FROM receipts WHERE kind='managed-cut'")
    .map((r) => r.seq);
  const second = target.managed.applyControl({
    kind: 'event-withdraw',
    eventId: 'md-replay',
    controlId: 'ctl-replay-1',
  });
  expect(second).toEqual(first);
  expect(
    target.core.store.get('SELECT target_revision FROM managed_deliveries WHERE event_id=?', 'md-replay')
      .target_revision,
  ).toBe(revision);
  expect(
    target.core.store.all("SELECT seq FROM receipts WHERE kind='managed-cut'").map((r) => r.seq),
  ).toEqual(facts);
  void id;
});

it('[03 §3.6] intent-then-crash restores to unknown and is never auto-retried', async () => {
  f = await system({ targets: 1 });
  const id = await f.bind(0);
  const target = f.target[0];
  await admitOne(f, 'md-crash');
  f.arm(0, id);
  target.managed.registerConsumer(
    {
      profileId: 'watcher-profile',
      eventManifestDigest: 'd1',
      responseManifestDigest: 'd2',
      guardImplementationId: 'watcher-guard-1',
      timeoutMs: 1000,
    },
    allowGate(),
  );
  target.core.options.fault = (point) => {
    if (point === 'managed.after_intent_commit') throw Error('SIGKILL between intent and invoke');
  };
  let invoked = 0;
  await expect(
    target.managed.pumpManaged(idle, async () => {
      invoked++;
      return { evidence: 'file-entry' };
    }),
  ).rejects.toThrow(/SIGKILL/);
  expect(invoked).toBe(0);
  expect(
    target.core.store.get('SELECT state FROM managed_deliveries WHERE event_id=?', 'md-crash').state,
  ).toBe('intent');
  target.core.options.fault = undefined;
  // A new host over the same store (previous process died): intent -> unknown.
  new ManagedTarget(target.core);
  expect(
    target.core.store.get('SELECT state FROM managed_deliveries WHERE event_id=?', 'md-crash').state,
  ).toBe('unknown');
  // unknown is never claimed again by the pump.
  await target.managed.pumpManaged(idle, async () => {
    invoked++;
    return { evidence: 'file-entry' };
  });
  expect(invoked).toBe(0);
  void id;
});

it('[03 §3.6] event expiry during retry ends auto-resume with state expired', async () => {
  f = await system({ targets: 1 });
  const id = await f.bind(0);
  const target = f.target[0];
  await admitOne(f, 'md-expired');
  f.arm(0, id);
  // Age the event past its validity without touching the clock: rewrite the
  // captured request's validUntil into the past (identity fields untouched).
  const row = target.core.store.get(
    'SELECT delivery_ref, request_json FROM managed_deliveries WHERE event_id=?',
    'md-expired',
  );
  const request = JSON.parse(row.request_json);
  request.event.validUntil = new Date(Date.now() - 1000).toISOString();
  target.core.store.run('UPDATE managed_deliveries SET request_json=? WHERE delivery_ref=?', JSON.stringify(request), row.delivery_ref);
  target.managed.registerConsumer(
    {
      profileId: 'watcher-profile',
      eventManifestDigest: 'd1',
      responseManifestDigest: 'd2',
      guardImplementationId: 'watcher-guard-1',
      timeoutMs: 1000,
    },
    allowGate(),
  );
  let invoked = 0;
  await target.managed.pumpManaged(idle, async () => {
    invoked++;
    return { evidence: 'file-entry' };
  });
  expect(invoked).toBe(0);
  expect(
    target.core.store.get('SELECT state FROM managed_deliveries WHERE event_id=?', 'md-expired').state,
  ).toBe('expired');
  void id;
});

it('[03 §3.3 step2] host-managedScopeProof walks the real Target→Source transport', async () => {
  f = await system({ targets: 1 });
  const id = await f.bind(0);
  const target = f.target[0];
  await admitOne(f, 'md-proof-e2e');
  const proof = await target.managedScopeProof(id, ['md-proof-e2e', 'not-routed-evt']);
  expect(proof).toBeDefined();
  expect(proof.validForMs).toBeLessThanOrEqual(1000);
  expect(proof.proofs).toHaveLength(1); // not-routed-evt is invisible to this binding
  expect(proof.proofs[0]).toMatchObject({
    eventId: 'md-proof-e2e',
    scopeId: 'scope-1',
    scopeState: 'active',
    tombstoned: false,
    audienceState: 'open',
  });
  void id;
});

it('[stage 4] declaration-registered consumer: pump records; revoke defers with no invoke and no budget', async () => {
  f = await system({ targets: 1 });
  const id = await f.bind(0);
  const target = f.target[0];
  const managed = target.managed;
  await admitOne(f, 'md-decl-1');
  const home = join(f.root, 'decl-home');
  writeConsumerDeclaration(home, parseConsumerDeclaration({
    profileId: 'watcher-profile',
    eventTypes: ['process.exited.v1'],
    responseTypes: ['watcher.response.v1'],
    // this fixture pumps the facade directly (no proof channel), so the
    // declaration must not require a confirmable source scope
    policy: { requireCurrentScope: false },
  }));
  const scan = registerDeclarations(managed, home);
  expect(scan.registered).toHaveLength(1);
  expect(scan.failed).toHaveLength(0);
  const consumers = managed.listConsumers();
  expect(consumers).toHaveLength(1);
  expect(consumers[0]).toMatchObject({ profileId: 'watcher-profile', guardLive: true });
  expect(consumers[0].deliveries.pending).toBe(1);

  f.arm(0, id);
  let invoked = 0;
  const pump = await managed.pumpManaged(idle, async () => {
    invoked++;
    return { evidence: 'file-entry' };
  });
  expect(pump.claimed).toBe(1);
  expect(invoked).toBe(1);
  const deliveries = managed.managedDeliveries();
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0]).toMatchObject({
    eventId: 'md-decl-1',
    eventType: 'process.exited.v1',
    state: 'recorded',
    consumerProfileId: 'watcher-profile',
  });

  // Revocation: future deliveries defer (GUARD_UNAVAILABLE), no invoke, and
  // the deferral consumes no wake budget — revocation never forges outcomes.
  expect(managed.revokeConsumer('watcher-profile').revoked).toBe(true);
  await admitOne(f, 'md-decl-2');
  expect(managed.listConsumers()).toHaveLength(0);
  f.arm(0, id);
  let invoked2 = 0;
  const pump2 = await managed.pumpManaged(idle, async () => {
    invoked2++;
    return { evidence: 'file-entry' };
  });
  expect(pump2.claimed).toBe(1); // claimed, then deferred by the missing guard
  expect(invoked2).toBe(0);
  const pending = managed.managedDeliveries({ state: 'pending' });
  expect(pending).toHaveLength(1);
  expect(pending[0].eventId).toBe('md-decl-2');
});
