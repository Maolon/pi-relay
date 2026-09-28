import type { BridgeError } from './types.js';
const messages = {
  unauthorized: 'Capability is missing, invalid, or outside the requested scope',
  invalid_payload: 'Request does not satisfy the relay contract',
  unsupported_version: 'Unsupported protocol version',
  unsupported_feature: 'Required capability is not implemented',
  unknown_type: 'Unregistered event type, kind, or schema version',
  id_conflict: 'The identifier already names different immutable content',
  binding_overlap: 'An active or provisioning binding already occupies this channel and target',
  binding_revoked: 'Binding authority has been revoked',
  binding_expired: 'Binding authority has expired',
  binding_sealed: 'Binding is sealed to new events',
  subscription_provisioning: 'Both-side registration is not complete',
  stale_binding_revision: 'Reconnect after a binding revision change',
  attachment_stale: 'Attachment is no longer current',
  backpressure: 'A bounded relay resource is full',
  store_unavailable: 'Durable storage did not complete the operation',
  owner_conflict: 'Another owner holds the operating-system lock',
  owner_superseded: 'Relay ownership was taken over by a newer session',
  unsafe_path: 'Private filesystem boundary check failed',
  target_offline: 'Target endpoint is unavailable',
  source_unavailable: 'Source endpoint is unavailable',
  local_trust_disabled: 'Channel did not opt into local standing binding',
  source_not_found: 'No source store or channel for this id',
  transport_unavailable: 'Transport is unavailable',
  admission_unknown: 'Admission may have completed; reconcile the same event ID',
  channel_closed: 'Channel no longer admits new captures or memberships',
  egress_forbidden: 'External writes are not supported',
  cursor_expired: 'Cursor is outside the retained receipt history',
  delivery_unknown: 'Delivery needs owner reconciliation',
  cancellation_too_late: 'The Pi submission horizon has been crossed',
  not_found: 'No authorized matching record',
  newer_schema: 'Database schema is newer than this implementation',
  invalid_state: 'Operation is not valid in this state',
  stale_scope_revision: 'Managed scope CAS failed; re-read the scope revision',
  cancelled: 'The event was withdrawn before capture',
} as const;
export type ErrorCode = keyof typeof messages;
const retryable = new Set<ErrorCode>([
  'backpressure',
  'store_unavailable',
  'target_offline',
  'source_unavailable',
  'transport_unavailable',
  'attachment_stale',
  'stale_binding_revision',
  'owner_superseded',
]);
export class RelayError extends Error {
  readonly detail: BridgeError;
  constructor(
    readonly code: ErrorCode,
    extras: Pick<BridgeError, 'retryAfterMs' | 'currentRevision'> = {},
  ) {
    code = Object.hasOwn(messages, code) ? code : 'transport_unavailable';
    super(messages[code]);
    this.name = 'RelayError';
    this.detail = {
      code,
      message: messages[code],
      retryable: retryable.has(code),
      ...Object.fromEntries(Object.entries(extras).filter(([, v]) => v !== undefined)),
    };
  }
}
export function fail(code: ErrorCode, extras?: Pick<BridgeError, 'retryAfterMs' | 'currentRevision'>): never {
  throw new RelayError(code, extras);
}
export function invariant(condition: unknown, code: ErrorCode = 'invalid_payload'): asserts condition {
  if (!condition) fail(code);
}
/** Do not echo upstream exceptions: they may contain payloads, tokens, or private paths. */
export function safeError(error: unknown): BridgeError {
  if (error instanceof RelayError) return error.detail;
  const code = (error as { code?: string })?.code;
  return new RelayError(
    code === 'SQLITE_BUSY' || code === 'SQLITE_FULL' || code === 'ENOSPC'
      ? 'backpressure'
      : 'store_unavailable',
    { retryAfterMs: 1000 },
  ).detail;
}
