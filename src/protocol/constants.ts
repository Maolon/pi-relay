/** Delta-2 local standing binding constants (plans/managed-delivery-v0.3/delta-2).
 *  The sentinel keeps every existing `expiresAt <= now` / `> now` check
 *  truthy for standing records without touching the sweep paths. */
export const STANDING_EXPIRES_AT = 9007199254740991;
/** TargetProposal.inviteId literal for standing proposals (no invite row exists). */
export const STANDING_INVITE_ID = 'local';
/** Sentinel infinite validity for local realm / localTrust managed audiences (incident 2026-09-23 / plan A).
 *  Aligned with STANDING_EXPIRES_AT (MAX_SAFE_INTEGER). */
export const FOREVER = STANDING_EXPIRES_AT;

