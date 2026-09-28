import { describe, it, expect } from 'vitest';
import {
  validate,
  validateManaged,
  MANAGED_FEATURES,
  OWNER_SETUP_FEATURES,
  TARGET_FEATURES,
  SOURCE_FEATURES,
  MANAGED_SOURCE_FEATURES,
  MANAGED_TARGET_FEATURES,
} from '../../dist/protocol/index.js';

const publish = {
  protocol: 'pi-relay',
  major: 1,
  minor: 2,
  requestId: 'req-1',
  op: 'source.managed.publish',
  params: {
    event: {
      kind: 'event',
      id: 'evt-1',
      type: 'watcher.issue.v1',
      schemaVersion: 1,
      occurredAt: '2026-09-19T00:00:00Z',
      validUntil: '2026-09-19T12:00:00Z',
      data: { summary: 'blocked' },
    },
    options: {
      audienceRef: 'aud-1',
      scope: { id: 'scope-1', revision: 1 },
      consumerProfileId: 'watcher',
      requestedMode: 'resume',
    },
  },
};

function op(name, params) {
  return { protocol: 'pi-relay', major: 1, minor: 2, requestId: 'req-1', op: name, params };
}

describe('managed delivery contract (wire 1.2, stage 1)', () => {
  it('[A4] managed ops require params wrapping; all nine ops validate', () => {
    expect(() => validateManaged('Request', publish)).not.toThrow();
    const ok = [
      op('source.managed.receipt', { eventId: 'evt-1' }),
      op('source.managed.watch', { after: 0, limit: 128 }),
      op('source.managed.snapshot', { limit: 50 }),
      op('source.managed.snapshot', { afterEventId: 'evt-0', limit: 128 }),
      op('source.event.withdraw', { operationId: 'op-1', eventId: 'evt-1', reason: 'stale' }),
      op('source.scope.advance', {
        operationId: 'op-2',
        scopeId: 'scope-1',
        expectedRevision: 0,
        nextRevision: 1,
        state: 'active',
      }),
      op('source.response.applied', {
        operationId: 'op-3',
        responseId: 'resp-1',
        result: { outcome: 'applied', applicationRevision: 1, code: 'APPLIED' },
      }),
      op('consumer.respond', {
        operationId: 'op-4',
        deliveryRef: 'del-1',
        responseType: 'watcher.response.v1',
        schemaVersion: 1,
        data: { requestId: 'evt-1' },
      }),
      op('owner.setup.commit', {
        operationId: 'op-5',
        planDigest: 'a'.repeat(64),
        consentReceiptRef: 'consent-1',
      }),
    ];
    for (const request of ok) expect(() => validateManaged('Request', request)).not.toThrow();
    // Flat (1.1-style) managed frame is rejected: no dual parse paths.
    expect(() =>
      validateManaged('Request', {
        protocol: 'pi-relay',
        major: 1,
        minor: 2,
        requestId: 'req-1',
        op: 'source.managed.watch',
        after: 0,
        limit: 10,
      }),
    ).toThrow();
  });

  it('[A2] snapshot limits and unknown ops', () => {
    expect(() => validateManaged('Request', op('source.managed.snapshot', { limit: 129 }))).toThrow();
    expect(() => validateManaged('Request', op('source.managed.snapshot', { limit: 0 }))).toThrow();
    expect(() => validateManaged('Request', op('source.managed.nope', {}))).toThrow();
  });

  it('[M1] recorded requires observation; evidence enum enforced', () => {
    const base = {
      routeRef: 'r-1',
      targetRevision: 3,
      freshness: 'fresh',
      admission: 'accepted',
      delivery: 'recorded',
      withdrawal: 'none',
    };
    expect(() => validateManaged('RouteReceipt', base)).toThrow();
    expect(() =>
      validateManaged('RouteReceipt', {
        ...base,
        observation: { evidence: 'file-entry', observedAt: '2026-09-19T00:00:01Z' },
      }),
    ).not.toThrow();
    expect(() =>
      validateManaged('RouteReceipt', {
        ...base,
        observation: { evidence: 'telemetry', observedAt: '2026-09-19T00:00:01Z' },
      }),
    ).toThrow();
    expect(() =>
      validateManaged('RouteReceipt', { ...base, delivery: 'pending' }),
    ).not.toThrow();
  });

  it('[M1/A13] gate allow requires validUntil; decision/reasonCode coupling holds', () => {
    expect(() => validateManaged('GateResult', { decision: 'allow', reasonCode: 'CURRENT', guardEpoch: 1 })).toThrow();
    expect(() =>
      validateManaged('GateResult', {
        decision: 'allow',
        reasonCode: 'CURRENT',
        guardEpoch: 1,
        validUntil: '2026-09-19T00:00:01Z',
      }),
    ).not.toThrow();
    expect(() => validateManaged('GateResult', { decision: 'defer', reasonCode: 'BUSY', guardEpoch: 2 })).not.toThrow();
    expect(() => validateManaged('GateResult', { decision: 'drop', reasonCode: 'CANCELLED', guardEpoch: 2 })).not.toThrow();
    expect(() => validateManaged('GateResult', { decision: 'drop', reasonCode: 'BUSY', guardEpoch: 2 })).toThrow();
  });

  it('[M1] consumer response application_applied requires applicationResult', () => {
    const base = {
      responseId: 'resp-1',
      deliveryRef: 'del-1',
      responseType: 'watcher.response.v1',
      schemaVersion: 1,
      data: {},
      createdAt: '2026-09-19T00:00:00Z',
      state: 'target_staged',
    };
    expect(() => validateManaged('ConsumerResponse', base)).not.toThrow();
    expect(() => validateManaged('ConsumerResponse', { ...base, state: 'application_applied' })).toThrow();
    expect(() =>
      validateManaged('ConsumerResponse', {
        ...base,
        state: 'application_applied',
        applicationResult: { outcome: 'applied', applicationRevision: 1, code: 'APPLIED' },
      }),
    ).not.toThrow();
  });

  it('[A3/A9] 1.1 surface unchanged: minor-2 frames rejected by 1.1 Request, 1.1 frames still valid', () => {
    expect(() => validate('Request', publish)).toThrow();
    expect(() =>
      validate('Request', {
        protocol: 'pi-relay',
        major: 1,
        minor: 1,
        requestId: 'req-1',
        op: 'source.status',
      }),
    ).not.toThrow();
    expect(() =>
      validate('Request', {
        protocol: 'pi-relay',
        major: 1,
        minor: 1,
        requestId: 'req-1',
        op: 'source.withdraw',
        bindingId: 'bnd-1',
        operationId: 'op-1',
        preparedDigest: 'a'.repeat(64),
      }),
    ).not.toThrow();
  });

  it('[02 §2.1] managed feature constants stay disjoint from the 1.1 base arrays (stage-2 hosts advertise the union)', () => {
    expect(MANAGED_FEATURES).toHaveLength(6);
    expect(OWNER_SETUP_FEATURES).toEqual(['consent-pairing-v1']);
    for (const feature of MANAGED_FEATURES) {
      expect(TARGET_FEATURES).not.toContain(feature);
      expect(SOURCE_FEATURES).not.toContain(feature);
    }
    // Stage 2 flip: implemented features are advertised by hosts as the union of the
    // 1.1 base and the managed split (source/target sides respectively). The base
    // arrays themselves stay untouched for 1.1-only clients.
    expect([...SOURCE_FEATURES, ...MANAGED_SOURCE_FEATURES]).toHaveLength(
      SOURCE_FEATURES.length + 4,
    );
    expect([...TARGET_FEATURES, ...MANAGED_TARGET_FEATURES]).toHaveLength(
      TARGET_FEATURES.length + 2,
    );
  });
});
