import type { FanoutResult, AdmissionResult } from '../protocol/types.js';

// SR-05: sealed ARCHITECTURE exit-code contract.
// 0 = explicit success scope; 2 = argument/schema; 3 = authorization/policy;
// 4 = partial/unknown/backpressure; 5 = platform/Store error.
const DEFINITE_ADMISSIONS = ['accepted', 'staged', 'buffered'];

export function exitFor(result: FanoutResult | AdmissionResult | Record<string, unknown>): number {
  const fanout = result as Partial<FanoutResult>;
  if (fanout.sourceState) {
    // A source-staged-but-not-materialized route is partial, never success.
    return (fanout.routes ?? []).some((r) => !DEFINITE_ADMISSIONS.includes(r.admission)) ? 4 : 0;
  }
  const control = result as { channelId?: string; action?: string; routes?: unknown };
  if (control.channelId && control.action) {
    const unknown = (control.routes as Array<{ outcome?: string; result?: { outcome?: string } }>).some(
      (r: { outcome?: string; result?: { outcome?: string } }) =>
        r.outcome === 'unknown' || r.result?.outcome === 'unknown',
    );
    return unknown ? 4 : 0;
  }
  const admission = result as Partial<AdmissionResult>;
  if (admission.outcome === 'admission-unknown') return 4;
  // A retryable failure (e.g. full spool) is backpressure, not a policy rejection.
  if (admission.outcome === 'rejected') return admission.error?.retryable ? 4 : 3;
  return 0;
}

export function classifyExit(error: { code: string }): number {
  switch (error.code) {
    case 'invalid_payload':
    case 'unsupported_feature':
    case 'stale_binding_revision':
    case 'id_conflict':
      return 2;
    case 'unauthorized':
    case 'egress_forbidden':
    case 'invalid_state':
    case 'not_found':
    case 'binding_overlap':
    case 'binding_revoked':
    case 'subscription_provisioning':
      return 3;
    case 'admission_unknown':
    case 'backpressure':
      return 4;
    default:
      return 5;
  }
}
