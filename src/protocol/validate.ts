import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import schema from './schemas/contracts.json' with { type: 'json' };
import managedSchema from './schemas/managed.json' with { type: 'json' };
import internalSchema from './schemas/managed-internal.json' with { type: 'json' };
import type * as T from './types.js';
import type * as M from './managed-types.js';
import type * as I from './internal-types.js';
import { assertJson, canonical, digest } from './canonical.js';
import { fail, invariant } from './errors.js';
export const LIMITS = Object.freeze({
  frameBytes: 131072,
  eventBytes: 65536,
  progressBytes: 16384,
  modelBytes: 8192,
  streamsPerBinding: 16,
  pendingPerBinding: 100,
  pendingPerTarget: 1000,
  bindingsPerSource: 32,
  fanoutConcurrency: 4,
  spoolBytes: 10485760,
  journalBytes: 52428800,
  receiptsPerBinding: 50000,
  retainedEvents: 10000,
});
export const TARGET_FEATURES = [
  'channel-bindings',
  'durable-events',
  'progress-snapshots',
  'receipt-query',
  'receipt-watch',
  'display',
  'resume',
  'offline-import',
] as const;
export const SOURCE_FEATURES = [
  'multi-session-fanout',
  'source-journal',
  'per-route-stage',
  'durable-events',
  'progress-snapshots',
  'receipt-query',
  // Delta-2: source accepts standing enrollment on localTrust channels.
  'local-standing-v1',
] as const;
const ajv = new Ajv2020({ strict: true, allErrors: false, allowUnionTypes: true, validateFormats: false });
ajv.addSchema(schema);
ajv.addSchema(managedSchema);
ajv.addSchema(internalSchema);
/** Managed delivery (wire 1.2) feature names per approved plan 02 §2.1 + delta-1.
 *  NOT advertised by hosts until each feature passes its implementation gate. */
export const MANAGED_FEATURES = [
  'managed-events-v1',
  'source-delivery-receipts-v1',
  'event-withdraw-v1',
  'scope-fencing-v1',
  'consumer-gate-v1',
  'consumer-responses-v1',
] as const;
export const OWNER_SETUP_FEATURES = ['consent-pairing-v1'] as const;
interface ManagedContracts {
  Request: M.Request;
  ManagedPublish: M.ManagedPublish;
  RouteReceipt: M.RouteReceipt;
  ManagedReceipt: M.ManagedReceipt;
  WithdrawResult: M.WithdrawResult;
  ScopeAdvance: M.ScopeAdvance;
  GateResult: M.GateResult;
  ConsumerResponse: M.ConsumerResponse;
  SetupPlan: M.SetupPlan;
}
/** Stage-2 advertisement split: source-side vs target-side managed features. */
export const MANAGED_SOURCE_FEATURES = [
  'managed-events-v1',
  'source-delivery-receipts-v1',
  'event-withdraw-v1',
  'scope-fencing-v1',
] as const;
export const MANAGED_TARGET_FEATURES = ['consumer-gate-v1', 'consumer-responses-v1'] as const;
interface InternalContracts {
  Request: I.Request;
  ManagedRoutePacket: I.ManagedRoutePacket;
}
/** Validate a relay-internal managed transport shape (op namespace 'internal.'). */
export function validateInternal<K extends keyof InternalContracts>(
  kind: K,
  value: unknown,
): InternalContracts[K] {
  assertJson(value);
  invariant(ajv.getSchema(`${internalSchema.$id}#/$defs/${kind}`)!(value));
  return value as InternalContracts[K];
}
/** Wire-level request validation: minor 1 -> 1.1 contract; minor 2 -> public managed
 *  contract unless the op is relay-internal ('internal.' namespace). */
export function validateWire(raw: unknown): T.Request {
  if (raw && typeof raw === 'object' && (raw as { minor?: number }).minor === 2) {
    const op = (raw as { op?: unknown }).op;
    const request =
      typeof op === 'string' && op.startsWith('internal.')
        ? validateInternal('Request', raw)
        : validateManaged('Request', raw);
    return request as unknown as T.Request;
  }
  return validate('Request', raw);
}
/** Validate a managed (minor 2) wire shape by def name. The 1.1 `validate` keeps its own surface. */
export function validateManaged<K extends keyof ManagedContracts>(kind: K, value: unknown): ManagedContracts[K] {
  assertJson(value);
  invariant(ajv.getSchema(`${managedSchema.$id}#/$defs/${kind}`)!(value));
  return value as ManagedContracts[K];
}
interface Contracts {
  Event: T.Event;
  Progress: T.Progress;
  Value: T.Value;
  Request: T.Request;
  Response: T.Response;
  RoutePacket: T.RoutePacket;
  Invite: T.Invite;
  SourceHandle: T.SourceHandle;
  BindingHandle: T.BindingHandle;
  SourceConfig: T.SourceConfig;
  TargetProposal: T.TargetProposal;
  PreparedBinding: T.PreparedBinding;
  MembershipProof: T.MembershipProof;
  OwnerCommand: T.OwnerCommand;
  EventReceipt: T.EventReceipt;
  Discovery: T.Discovery;
  TypeManifest: T.TypeManifest;
  ConnectResult: T.ConnectResult;
  FanoutResult: T.FanoutResult;
  AdmissionResult: T.AdmissionResult;
}
export function validate<K extends keyof Contracts>(kind: K, value: unknown): Contracts[K] {
  assertJson(value);
  invariant(ajv.getSchema(`${schema.$id}#/$defs/${kind}`)!(value));
  return value as Contracts[K];
}
export function deadline(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  invariant(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value));
  const result = Date.parse(value);
  invariant(Number.isSafeInteger(result));
  return result;
}
export function features(required: string[], available: readonly string[]): void {
  for (const feature of required) if (!available.includes(feature)) fail('unsupported_feature');
}
/** Schemas only come from owner-approved local manifests; $ref cannot initiate network access. */
export class Registry {
  private readonly validators = new Map<string, { hash: string; check: ValidateFunction }>();
  register(manifests: T.TypeManifest[]): void {
    for (const manifest of manifests) {
      validate('TypeManifest', manifest);
      const key = `${manifest.type}/${manifest.schemaVersion}/${manifest.kind}`,
        hash = digest(manifest);
      const prior = this.validators.get(key);
      invariant(!prior || prior.hash === hash, 'id_conflict');
      if (prior) continue;
      const isolated = new Ajv2020({
        strict: true,
        allErrors: false,
        allowUnionTypes: true,
        validateFormats: false,
      });
      let check: ValidateFunction;
      try {
        check = isolated.compile(manifest.dataSchema);
      } catch {
        fail('invalid_payload');
      }
      this.validators.set(key, { hash, check });
    }
  }
  check(value: T.Value): void {
    validate('Value', value);
    const entry = this.validators.get(`${value.type}/${value.schemaVersion}/${value.kind}`);
    if (!entry) fail('unknown_type');
    invariant(entry.check(value.kind === 'event' ? value.data : value.snapshot));
    invariant(
      Buffer.byteLength(canonical(value)) <=
        (value.kind === 'event' ? LIMITS.eventBytes : LIMITS.progressBytes),
    );
    if (value.kind === 'event') {
      deadline(value.validUntil, 0);
      deadline(value.occurredAt, 0);
    }
  }
}
export const BUILTIN_TYPES: T.TypeManifest[] = [
  {
    type: 'process.progress.v1',
    schemaVersion: 1,
    kind: 'progress',
    dataSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { tail: { type: 'string', maxLength: 8192 }, eof: { type: 'boolean' } },
      required: ['tail'],
    },
  },
  {
    type: 'process.exited.v1',
    schemaVersion: 1,
    kind: 'event',
    dataSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        exitCode: { type: 'integer' },
        summary: { type: 'string', maxLength: 8192 },
        artifactId: { type: 'string', maxLength: 128 },
      },
      required: ['exitCode'],
    },
  },
];
