# Operations and boundaries

## Ownership and deployment

The Source Host owns reading/capture, membership and per-route distribution. Each Pi attachment owns one target Inbox and dispatcher. These are independent OS-held locks with fixed inodes; a stopped owner cannot be replaced because of a stale heartbeat. Do not remove lock files or kill an unrelated process to resolve contention.

Run the Source Host in a foreground terminal or an existing executor whose lifetime is independent of every subscriber. `source serve` does not spawn the business CLI, install a service or migrate itself to the latest Pi session. The original executor remains responsible for process exit codes, complete logs, stopping work and upstream acknowledgments.

A target's revoke takes effect in its local transaction first; the target then retries a restricted Source withdrawal notification. Offline Source acknowledgment is not required to prevent local admission. Source global revoke cuts its future routes first and reports each target's notification separately. Neither operation retracts input already submitted to Pi. The last unsubscribe never kills the Source Host or business job.

## Facts, unknown and controls

`accepted` requires an Inbox transaction. `dispatch-intent` reserves a grant and records an attempt, but does not prove that Pi was called. `submittedAt` requires the public call to have occurred. `recorded` requires an exact `custom_message`, namespace, target, event, delivery ID, digest and content match, with `runtime-entry` or `file-entry` evidence. Neither means the model understood or completed the business task.

Restoring an intent/submission without sufficient evidence yields unknown. Reconcile against the exact original session; do not send the event again under a new ID. To deliberately leave an unknown attempt unresolved while allowing unrelated authorized work:

```text
/events resolve-unknown BINDING_ID DELIVERY_ID --skip-replay
/events resume BINDING_ID --reason recovery
/events arm BINDING_ID --claims 1 --ttl-ms 600000
```

The first operation suppresses this attempt's automatic replay; it does not assert success, an empty Pi queue or cancellation. Pause, revoke, deadline and record facts are separate. A post-submit control returns too-late/unknown IDs and never clears Pi's global queues.

Owner operation IDs are stable and compare-and-swap revisions matter. Retrying an operation with different contents is a conflict. Source control callers provide the current source revision; source status does not reveal bearer values. Source publisher, invite, route ingress and owner capabilities are not interchangeable. The model gets `events_status` (read-only), `relay_bindings`, `relay_respond` and `relay_mail`; none of them exposes bearer values.

## Files and credentials

Use a private local filesystem root, directories mode 0700 and credential files mode 0600. Online bearers have at least 256 random bits and hashed database comparisons. Offline RoutePackets use a separate per-binding HMAC key and contain no raw bearer. Do not put credentials in prompts, event content, shell arguments, repository files or transcripts. Capabilities belong in explicit private files/FDs.

Staging uses full writes, file fsync, no-replace hard-link installation and parent fsync. Import validates the registered target scope, HMAC, immutable identity, original deadline and current revocation. It removes only the admitted file whose identity it inspected. One subscriber never removes another's copy. Malformed inputs produce bounded rejection evidence, not arbitrary path traversal or schema download.

This is not a sandbox against a malicious process with the same UID or a fully privileged installed extension. Advisory bridge locks do not protect all unrelated Pi writers. Unsupported filesystems and a changed Node ABI must be qualified before use.

## Wake budget semantics

A channel's `maxAutoTargets` bounds how many resume-eligible members keep a
model-wake reservation for one published event. Allocation is
**presence-recency first**: memberships are ordered by the last confirmed
contact (`last_seen`, stamped at enroll's live-target probe and at every
successful dispatch delivery), then by newest membership cut, then binding id;
the slice of that order up to `maxAutoTargets` carries the reservation, all
other resume members freeze display-only exactly as before. Membership age
never confers wake priority, and a member that has never answered a probe
sorts last.

Operational consequences:

- A binding that is offline but was recently present keeps its reservation;
  on restore the staged route still wakes.
- With demand above budget among equally recent targets the cap still
  excludes some members; that residual over-subscription is a documented
  boundary, not a defect. Raising `maxAutoTargets` is the owner's control.
- Source replay re-dispatches captured routes; it never upgrades a route that
  was frozen display-only at capture time. Replay is not a repair path for
  allocation decisions.

## Bounds and retention

Defaults: 128 KiB frame, 64 KiB durable event, 16 KiB progress, 16 streams/binding, 100 pending resumable events/binding, 1000/target, 32 live source subscriptions, four concurrent durable routes, 10 MiB pending spool/binding, 50 MiB journal payload and 10,000 retained events/store. SQLite itself has a 512 MiB page limit so metadata also encounters a hard rejection. Busy, full and quota failures cannot return accepted for an uncommitted transaction.

Progress holds only the latest snapshot per stream; it is lossy and does not consume a model grant. Presentation is capped at five updates/second. Model content is clipped to a bounded UTF-8 representation, with authoritative non-secret provenance. This formatting does not make untrusted source instructions safe to obey.

This development implementation retains durable facts and refuses new work at retention limits; **automatic historical GC and quota-aware retention maintenance are not release-qualified**. A route's deadline is frozen on first capture, normally at most one hour without a stricter event deadline. Replay never refreshes it. Startup import is bounded to 256 files/binding; use explicit import for further batches. Receipt queries are bounded and invalid/expired cursors fail instead of silently skipping history.

## Backup, stop and rollback

Stop new claims and source distribution first, then record in-flight/unknown receipts. The Store SDK has a SQLite online backup method; otherwise stop the owner cleanly and preserve the entire private state directory, including all credential keys and any SQLite WAL/SHM files. Never copy only a live database while discarding its WAL.

Disable the explicitly loaded extension and stop only your foreground Source Host. Uninstalling the package does not delete state and does not kill external tasks. Restarting never automatically arms a grant. Do not downgrade-write an unknown database schema or delete a corrupt database; preserve it for diagnosis. Copying/moving a session file changes its fingerprint and does not inherit the original live binding automatically.

## Supported versus deferred

The implementation provides local reception, display, explicit idle resume, independent source fanout and offline staging. It refuses remote/network ingress, automatic source migration, steering/next-input, arbitrary stdin, business replies/egress, controller election and implicit assistant-message forwarding. Voice and watcher adapters must register their own trusted schemas; the built-in concrete adapters cover process progress and exit facts only. Upstream at-least-once/exactly-once guarantees cannot be invented by this relay.

## Installation

Install as a Pi package (runs `npm install`, which builds the native
`better-sqlite3` and `fs-ext` modules):

```sh
pi install npm:@maolon/pi-relay
```

State: the relay home defaults to `~/.pi/relay` (0700); `PI_RELAY_HOME`
overrides per environment. The `pi-relay` CLI is available through
`npx @maolon/pi-relay` or a global `npm install -g @maolon/pi-relay`.
`/reload` in a session picks up an updated package.

## Owner takeover (latest-active-wins)

Two processes opening the same session file (same fingerprint) no longer
deadlock the newer one: the newest session takes over the target store. The
earlier holder is fenced out at its next write (owner-token generation
check), closes within ~500 ms, and shows `relay detached here` — the session
keeps working, just without relay. A wedged holder (not responding within
10 s) produces an actionable error naming its pid. Serial safety: a
challenger writes only after acquiring the flock; a superseded owner never
writes after its first failed fence check.
