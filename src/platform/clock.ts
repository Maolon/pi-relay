export interface Clock {
  now(): number;
}
export const wallClock: Clock = { now: () => Date.now() };
export type FaultPoint =
  | 'target.after_prepare_commit'
  | 'source.after_membership_commit'
  | 'target.before_finalize_commit'
  | 'source.after_capture_commit'
  | 'stage.after_file_fsync'
  | 'stage.after_install_before_dir_fsync'
  | 'source.after_route_materialize'
  | 'target.after_admission_commit_before_response'
  | 'target.after_intent_commit'
  | 'pi.after_invoke_before_store_update'
  | 'pi.after_runtime_entry_before_file_observation'
  | 'stage.after_admission_before_cleanup'
  | 'managed.after_intent_commit';
/** Test-only dependency injection. No environment-variable fault activation in production. */
export type FaultHook = (point: FaultPoint) => void;
