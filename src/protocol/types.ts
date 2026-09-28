// Generated from schemas/contracts.json. Run npm run generate:types; do not edit.

export type RelayContract =
  | ModelMode
  | PolicyRule
  | Policy
  | TypeManifest
  | Event
  | Progress
  | Value
  | ChannelConfig
  | SourceConfig
  | SourceHandle
  | BindingHandle
  | Invite
  | TargetProposal
  | PreparedBinding
  | MembershipProof
  | RoutePacket
  | GrantRequest
  | OwnerCommand
  | BridgeError
  | Observation
  | EventReceipt
  | AdmissionResult
  | FanoutRoute
  | FanoutResult
  | Discovery
  | ConnectResult
  | ConnectRequest
  | PublishRequest
  | ReceiptRequest
  | WatchRequest
  | SourcePublishRequest
  | SourceReceiptRequest
  | InviteRequest
  | EnrollRequest
  | SourceControlRequest
  | SourceWithdrawRequest
  | RouteRevokeRequest
  | UnsupportedRequest
  | Request
  | Response;
export type ModelMode = 'display' | 'resume';
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | {
      [k: string]: Json;
    };
export type Value = Event | Progress;
export type AdmissionResult =
  | {
      outcome: 'accepted';
      eventId: string;
      acceptedAt: number;
      bindingAdmissionSeq: number;
      duplicate: boolean;
      receiptCursor: number;
    }
  | {
      outcome: 'staged';
      eventId: string;
      durability: 'producer-outbox';
    }
  | {
      outcome: 'admission-unknown';
      eventId: string;
      staged: boolean;
    }
  | {
      outcome: 'buffered';
      streamId: string;
      revision: number;
      durability: 'none';
    }
  | {
      outcome: 'dropped';
      reason: 'progress-offline' | 'superseded';
    }
  | {
      outcome: 'rejected';
      error: BridgeError;
    };
export type Request =
  | ConnectRequest
  | PublishRequest
  | ReceiptRequest
  | WatchRequest
  | SourcePublishRequest
  | SourceReceiptRequest
  | InviteRequest
  | EnrollRequest
  | SourceControlRequest
  | SourceWithdrawRequest
  | RouteRevokeRequest
  | UnsupportedRequest
  | SourceStatusRequest;
export type Response =
  | {
      protocol: 'pi-relay';
      major: 1;
      minor: 1;
      requestId: string;
      ok: true;
      result: Json;
    }
  | {
      protocol: 'pi-relay';
      major: 1;
      minor: 1;
      requestId: string;
      ok: false;
      error: BridgeError;
    };

export interface PolicyRule {
  model: ModelMode;
  presentation: 'live' | 'card' | 'none';
}
export interface Policy {
  [k: string]: PolicyRule;
}
export interface TypeManifest {
  type: string;
  schemaVersion: number;
  kind: 'event' | 'progress';
  dataSchema: {
    [k: string]: Json;
  };
}
export interface Event {
  kind: 'event';
  id: string;
  type: string;
  schemaVersion: number;
  subject?: string;
  occurredAt?: string;
  validUntil?: string;
  data: Json;
}
export interface Progress {
  kind: 'progress';
  type: string;
  schemaVersion: number;
  streamId: string;
  revision: number;
  subject?: string;
  snapshot: Json;
}
export interface ChannelConfig {
  id: string;
  /**
   * @maxItems 64
   */
  types: TypeManifest[];
  /**
   * @maxItems 2
   */
  allowedModes: ModelMode[];
  maxAutoTargets: number;
  /**
   * Delta-2 trust-distance layering: channel opts into local standing binding (no invite ceremony; same-home same-realm direct bind). Default false keeps the full invite ceremony.
   */
  localTrust?: boolean;
}
export interface SourceConfig {
  version: 1;
  sourceId: string;
  realm: string;
  home: string;
  /**
   * @maxItems 32
   */
  channels: ChannelConfig[];
  ownerToken: string;
  publisherTokens: {
    [k: string]: string;
  };
}
export interface SourceHandle {
  version: 1;
  kind: 'source';
  sourceId: string;
  realm: string;
  discoveryFile: string;
  credential: string;
  channelId?: string;
}
export interface BindingHandle {
  version: 1;
  kind: 'binding';
  bindingId: string;
  sourceId: string;
  channelId: string;
  targetFingerprint: string;
  realm: string;
  discoveryFile: string;
  spoolDir: string;
  credential: string;
  proofKeyId: string;
  proofKey: string;
  expiresAt: number;
}
export interface Invite {
  version: 1;
  kind: 'invite';
  inviteId: string;
  sourceId: string;
  channelId: string;
  realm: string;
  discoveryFile: string;
  credential: string;
  expiresAt: number;
  bindingExpiresAt: number;
  /**
   * @maxItems 64
   */
  types: TypeManifest[];
  /**
   * @maxItems 2
   */
  allowedModes: ModelMode[];
}
export interface TargetProposal {
  operationId: string;
  inviteId: string;
  sourceId: string;
  channelId: string;
  targetFingerprint: string;
  realm: string;
  expiresAt: number;
  policy: Policy;
  /**
   * @maxItems 64
   */
  types: TypeManifest[];
  affinity: 'branch' | 'session';
  originAnchor: string | null;
  /**
   * Delta-2: local standing binding. When true, expiresAt carries STANDING_EXPIRES_AT (9007199254740991), inviteId is the literal "local", and the binding is exempt from the cross-target overlap guard.
   */
  standing?: boolean;
}
export interface PreparedBinding {
  bindingId: string;
  proposal: TargetProposal;
  handle: BindingHandle;
  preparedDigest: string;
}
export interface MembershipProof {
  bindingId: string;
  sourceId: string;
  channelId: string;
  targetFingerprint: string;
  operationId: string;
  preparedDigest: string;
  membershipRevision: number;
  expiresAt: number;
  proof: string;
}
export interface RoutePacket {
  packetVersion: 1;
  bindingId: string;
  sourceId: string;
  channelId: string;
  event: Event;
  sourceEventDigest: string;
  fanoutId: string;
  membershipRevision: number;
  routeCreatedAt: number;
  routeValidUntil: number;
  policySnapshotId: string;
  /**
   * @maxItems 2
   */
  allowedModelModes: ModelMode[];
  sourceWakeReservationId?: string;
  proofKeyId: string;
  proof: string;
}
export interface GrantRequest {
  /**
   * @maxItems 64
   */
  eventTypes: string[];
  maxClaims: number;
  ttlMs: number;
  sessionScoped?: boolean;
  /**
   * Delta-2: standing grant. When true, maxClaims and ttlMs are schema-required but semantically ignored (any in-range values accepted); claim checks skip expiry and claim-cap. Budget is bounded by eligibility gates, fencing and the managed guard instead.
   */
  standing?: boolean;
}
export interface OwnerCommand {
  operationId: string;
  expectedRevision: number;
  action:
    | 'pause'
    | 'resume'
    | 'arm'
    | 'disarm'
    | 'seal'
    | 'revoke'
    | 'renew'
    | 'resolve-unknown'
    | 'rotate-credential';
  grant?: GrantRequest;
  expiresAt?: number;
  holdReason?: 'manual' | 'navigation' | 'recovery' | 'foreground-changed' | 'host-aborted';
  approveCurrentBranch?: boolean;
  deliveryId?: string;
  resolution?: 'skip-replay-and-unblock';
}
export interface BridgeError {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  currentRevision?: number;
}
export interface Observation {
  evidence: 'runtime-entry' | 'file-entry';
  entryKind: 'custom_message';
  entryId: string;
  observedAt: number;
}
export interface EventReceipt {
  bindingId: string;
  sourceId: string;
  channelId: string;
  eventId: string;
  acceptedAt: number;
  payloadDigest: string;
  effectiveValidUntil: number;
  delivery: {
    disposition:
      | 'not-requested'
      | 'pending'
      | 'held'
      | 'dispatch-intent'
      | 'submitted'
      | 'recorded'
      | 'unknown'
      | 'suppressed'
      | 'expired';
    /**
     * @maxItems 32
     */
    holdReasons?: string[];
    deliveryId?: string;
    submittedAt?: number;
    observation?: Observation;
    controlAfterSubmission?: 'paused' | 'revoked' | 'expired';
  };
  presentation: {
    state: 'none' | 'buffered' | 'projected' | 'archived' | 'unavailable';
  };
  cursor: number;
}
export interface FanoutRoute {
  routeId: string;
  bindingId?: string;
  admission: 'accepted' | 'staged' | 'pending-registration' | 'rejected' | 'unknown' | 'source-staged';
  reason?: string;
}
export interface FanoutResult {
  sourceState: 'source-staged' | 'empty-audience' | 'buffered' | 'dropped';
  eventId?: string;
  fanoutId?: string;
  membershipRevision?: number;
  /**
   * @maxItems 32
   */
  routes: FanoutRoute[];
}
export interface Discovery {
  version: 1;
  kind: 'source' | 'binding';
  identity: string;
  realm: string;
  endpoint: string;
  attachmentId: string;
  ownerEpoch: number;
}
export interface ConnectResult {
  protocol: 'pi-relay';
  major: 1;
  minor: 1;
  /**
   * @maxItems 32
   */
  features: string[];
  sourceId: string;
  channelId?: string;
  bindingId?: string;
  targetFingerprint?: string;
  realm: string;
  attachmentId: string;
  ownerEpoch: number;
  bindingRevision?: number;
  preparedDigest?: string;
  limits: {
    [k: string]: number;
  };
  membershipRevision?: number;
  sourceRevision?: number;
}
export interface ConnectRequest {
  protocol: 'pi-relay';
  major: 1;
  minor: 1;
  requestId: string;
  op: 'connect';
  credential: string;
  bindingId?: string;
  sourceId?: string;
  inviteId?: string;
  /**
   * @maxItems 32
   */
  requiredFeatures: string[];
}
export interface PublishRequest {
  protocol: 'pi-relay';
  major: 1;
  minor: 1;
  requestId: string;
  op: 'publish';
  bindingId: string;
  bindingRevision: number;
  attachmentId: string;
  value?: Value;
  packet?: RoutePacket;
}
export interface ReceiptRequest {
  protocol: 'pi-relay';
  major: 1;
  minor: 1;
  requestId: string;
  op: 'receipt';
  bindingId: string;
  bindingRevision: number;
  attachmentId: string;
  eventId: string;
}
export interface WatchRequest {
  protocol: 'pi-relay';
  major: 1;
  minor: 1;
  requestId: string;
  op: 'watch';
  bindingId: string;
  bindingRevision: number;
  attachmentId: string;
  after: number;
  limit: number;
}
export interface SourcePublishRequest {
  protocol: 'pi-relay';
  major: 1;
  minor: 1;
  requestId: string;
  op: 'source.publish';
  channelId: string;
  value: Value;
  autoRequired?: boolean;
}
export interface SourceReceiptRequest {
  protocol: 'pi-relay';
  major: 1;
  minor: 1;
  requestId: string;
  op: 'source.receipt';
  channelId: string;
  eventId: string;
}
export interface InviteRequest {
  protocol: 'pi-relay';
  major: 1;
  minor: 1;
  requestId: string;
  op: 'source.invite';
  operationId: string;
  channelId: string;
  ttlMs: number;
  bindingTtlMs: number;
  allowResume: boolean;
}
export interface EnrollRequest {
  protocol: 'pi-relay';
  major: 1;
  minor: 1;
  requestId: string;
  op: 'source.enroll';
  prepared: PreparedBinding;
}
export interface SourceControlRequest {
  protocol: 'pi-relay';
  major: 1;
  minor: 1;
  requestId: string;
  op: 'source.control';
  operationId: string;
  channelId: string;
  action: 'close' | 'revoke' | 'replay';
  expectedRevision: number;
}
export interface SourceWithdrawRequest {
  protocol: 'pi-relay';
  major: 1;
  minor: 1;
  requestId: string;
  op: 'source.withdraw';
  bindingId: string;
  operationId: string;
  preparedDigest: string;
}
export interface RouteRevokeRequest {
  protocol: 'pi-relay';
  major: 1;
  minor: 1;
  requestId: string;
  op: 'route.revoke';
  bindingId: string;
  bindingRevision: number;
  attachmentId: string;
  operationId: string;
}
export interface UnsupportedRequest {
  protocol: 'pi-relay';
  major: 1;
  minor: 1;
  requestId: string;
  op: 'egress';
  value?: Json;
}
export interface SourceStatusRequest {
  protocol: 'pi-relay';
  major: 1;
  minor: 1;
  requestId: string;
  op: 'source.status';
}
