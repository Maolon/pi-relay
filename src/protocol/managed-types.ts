// Generated from schemas/managed.json (managed delivery wire 1.2, approved delta-1). Run npm run generate:types; do not edit.

export type ManagedContract =
  | Scope
  | Event
  | ManagedOptions
  | ManagedPublish
  | ApplicationResult
  | ConsumerResponse
  | DeliveryObservation
  | RouteReceipt
  | ManagedReceipt
  | WithdrawResult
  | ScopeAdvance
  | GateResult
  | ResponseApplied
  | Request
  | SetupPlan;
export type ApplicationResult = {
  [k: string]: unknown;
} & {
  outcome: 'applied' | 'stale' | 'rejected';
  applicationRevision: number;
  code: 'APPLIED' | 'STALE_EPISODE' | 'OWNER_MISMATCH' | 'ALREADY_CLOSED' | 'INVALID_RESPONSE';
};
export type ConsumerResponse = {
  [k: string]: unknown;
} & {
  responseId: string;
  deliveryRef: string;
  responseType: string;
  schemaVersion: number;
  data: {};
  createdAt: string;
  state: 'target_staged' | 'source_recorded' | 'application_applied';
  applicationResult?: ApplicationResult;
};
export type RouteReceipt = {
  [k: string]: unknown;
} & {
  routeRef: string;
  targetRevision: number;
  targetUpdatedAt?: string;
  freshness: 'fresh' | 'stale' | 'offline';
  admission: 'accepted' | 'staged' | 'rejected' | 'unknown';
  delivery:
    | 'pending'
    | 'held'
    | 'intent'
    | 'submitted'
    | 'recorded'
    | 'unknown'
    | 'suppressed'
    | 'expired'
    | 'withdrawn';
  withdrawal: 'none' | 'pending' | 'prevented' | 'too_late' | 'unknown';
  observation?: DeliveryObservation;
};
export type GateResult = {
  [k: string]: unknown;
} & {
  decision: 'allow' | 'defer' | 'drop';
  reasonCode:
    | 'CURRENT'
    | 'BUSY'
    | 'SOURCE_UNAVAILABLE'
    | 'GUARD_UNAVAILABLE'
    | 'STALE_REQUEST'
    | 'CANCELLED'
    | 'WRONG_OWNER'
    | 'EXPIRED';
  guardEpoch: number;
  validUntil?: string;
};
export type Request =
  | {
      protocol: 'pi-relay';
      major: 1;
      minor: 2;
      requestId: string;
      op: 'source.managed.publish';
      params: ManagedPublish;
    }
  | {
      protocol: 'pi-relay';
      major: 1;
      minor: 2;
      requestId: string;
      op: 'source.managed.receipt';
      params: {
        eventId: string;
      };
    }
  | {
      protocol: 'pi-relay';
      major: 1;
      minor: 2;
      requestId: string;
      op: 'source.managed.watch';
      params: {
        after: number;
        limit: number;
      };
    }
  | {
      protocol: 'pi-relay';
      major: 1;
      minor: 2;
      requestId: string;
      op: 'source.managed.snapshot';
      params: {
        afterEventId?: string;
        limit: number;
      };
    }
  | {
      protocol: 'pi-relay';
      major: 1;
      minor: 2;
      requestId: string;
      op: 'source.event.withdraw';
      params: {
        operationId: string;
        eventId: string;
        reason: string;
      };
    }
  | {
      protocol: 'pi-relay';
      major: 1;
      minor: 2;
      requestId: string;
      op: 'source.scope.advance';
      params: ScopeAdvance;
    }
  | {
      protocol: 'pi-relay';
      major: 1;
      minor: 2;
      requestId: string;
      op: 'source.response.applied';
      params: ResponseApplied;
    }
  | {
      protocol: 'pi-relay';
      major: 1;
      minor: 2;
      requestId: string;
      op: 'consumer.respond';
      params: {
        operationId: string;
        deliveryRef: string;
        responseType: string;
        schemaVersion: number;
        data: {};
      };
    }
  | {
      protocol: 'pi-relay';
      major: 1;
      minor: 2;
      requestId: string;
      op: 'owner.setup.commit';
      params: {
        operationId: string;
        planDigest: string;
        consentReceiptRef: string;
      };
    };

export interface Scope {
  id: string;
  revision: number;
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
export interface ManagedPublish {
  event: Event;
  options: ManagedOptions;
}
export interface DeliveryObservation {
  evidence: 'runtime-entry' | 'file-entry';
  observedAt: string;
}
export interface ManagedReceipt {
  eventId: string;
  sourceState: 'captured' | 'empty_audience' | 'rejected' | 'unknown';
  sourceCursor: number;
  scope: Scope;
  /**
   * @maxItems 32
   */
  routes: RouteReceipt[];
  /**
   * @maxItems 64
   */
  responses: ConsumerResponse[];
}
export interface WithdrawResult {
  operationId: string;
  eventId: string;
  sourceApplied: boolean;
  /**
   * @maxItems 32
   */
  routes: {
    routeRef: string;
    disposition: 'prevented' | 'too_late' | 'pending' | 'unknown';
  }[];
}
export interface ScopeAdvance {
  operationId: string;
  scopeId: string;
  expectedRevision: number;
  nextRevision: number;
  state: 'active' | 'paused' | 'closed';
}
export interface ResponseApplied {
  operationId: string;
  responseId: string;
  result: ApplicationResult;
}
export interface SetupPlan {
  sourceRef: string;
  channelId: string;
  consumerProfileId: string;
  audienceIntent: 'single-current-owner';
  requestedMode: 'display' | 'resume';
  grant: {
    maxClaims: number;
    ttlMs: number;
    /**
     * @maxItems 64
     */
    eventTypes: string[];
  };
}
