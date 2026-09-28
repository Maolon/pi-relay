// Generated from schemas/managed-internal.json (relay-internal managed transport). Run npm run generate:types; do not edit.

export type ManagedInternalContract =
  | ManagedRoutePacket
  | Request
  | Event
  | Scope
  | ManagedOptions
  | ApplicationResult
  | ScopeProofEntry
  | ScopeProof;
export type Request =
  | {
      protocol: 'pi-relay';
      major: 1;
      minor: 2;
      requestId: string;
      op: 'internal.target.admit';
      params: {
        packet: ManagedRoutePacket;
        bindingId: string;
        bindingRevision: number;
        attachmentId: string;
      };
    }
  | {
      protocol: 'pi-relay';
      major: 1;
      minor: 2;
      requestId: string;
      op: 'internal.target.control';
      params: {
        kind: 'event-withdraw' | 'scope-fence';
        eventId?: string;
        scopeId?: string;
        scopeRevision?: number;
        controlId: string;
        bindingId: string;
        bindingRevision: number;
        attachmentId: string;
      };
    }
  | {
      protocol: 'pi-relay';
      major: 1;
      minor: 2;
      requestId: string;
      op: 'internal.target.ack';
      params: {
        responseId: string;
        appliedAt: number;
        result: ApplicationResult;
        bindingId: string;
        bindingRevision: number;
        attachmentId: string;
      };
    }
  | {
      protocol: 'pi-relay';
      major: 1;
      minor: 2;
      requestId: string;
      op: 'internal.source.proof';
      params: {
        bindingId: string;
        /**
         * @minItems 1
         * @maxItems 32
         */
        eventIds: string[];
      };
    };
export type ApplicationResult = {
  [k: string]: unknown;
} & {
  outcome: 'applied' | 'stale' | 'rejected';
  applicationRevision: number;
  code: 'APPLIED' | 'STALE_EPISODE' | 'OWNER_MISMATCH' | 'ALREADY_CLOSED' | 'INVALID_RESPONSE';
};

export interface ManagedRoutePacket {
  packetVersion: 2;
  bindingId: string;
  sourceId: string;
  channelId: string;
  event: Event;
  sourceEventDigest: string;
  fanoutId: string;
  membershipRevision: number;
  routeCreatedAt: number;
  routeValidUntil: number;
  options: ManagedOptions;
  optionsDigest: string;
  proofKeyId: string;
  proof: string;
  routeRef: string;
}
export interface Event {
  kind: 'event';
  id: string;
  type: string;
  schemaVersion: number;
  subject?: string;
  occurredAt: string;
  validUntil: string;
  data: {};
}
export interface ManagedOptions {
  audienceRef: string;
  scope: Scope;
  consumerProfileId: string;
  requestedMode: 'display' | 'resume';
}
export interface Scope {
  id: string;
  revision: number;
}
export interface ScopeProofEntry {
  eventId: string;
  publisherId: string;
  scopeId: string;
  scopeRevision: number;
  scopeState: 'active' | 'paused' | 'closed';
  tombstoned: boolean;
  audienceState: 'open' | 'closed' | 'revoked';
}
export interface ScopeProof {
  issuedAt: number;
  validForMs: number;
  /**
   * @maxItems 32
   */
  proofs: ScopeProofEntry[];
}
