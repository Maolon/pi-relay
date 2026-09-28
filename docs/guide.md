# pi-relay guide

Reference for everything the [README](../README.md) only sketches. For
credentials, limits, backups and failure semantics see
[operations](ops/operations.md).

- [Session mail](#session-mail)
- [Event relay: source, channel, binding](#event-relay-source-channel-binding)
- [Model resumption](#model-resumption)
- [Local standing bindings](#local-standing-bindings)
- [Binding from another extension](#binding-from-another-extension)
- [Managed consumers and host responses](#managed-consumers-and-host-responses)
- [Streaming and recovery](#streaming-and-recovery)
- [Source authority recovery](#source-authority-recovery)
- [SDK](#sdk)
- [Platform notes](#platform-notes)

## Session mail

Pi sessions on the same machine can message each other. Mail is independent
of the event relay: no source, binding, grant, SQLite or daemon, just files
under the private relay home (`PI_RELAY_HOME`, default `~/.pi/relay`):

```
mail/peers/<sessionId>.json          one file per live session (name, pid, cwd, HERDR_PANE_ID)
mail/inbox/<sessionId>/<id>.json     one file per undelivered mail
```

The model uses the `relay_mail` tool: `peers` lists live sessions; `send`
queues a message for one session addressed by session name (`/name`), herdr
pane id or session id (prefix of at least 8 characters). Matching is exact;
an ambiguous name is refused with the candidates. A reply passes `replyTo`
(the received `mailId`) and may omit `to`. Bodies are limited to 16 KiB. The
owner surface is `/relay mail peers` and `/relay mail send TO TEXT`.

The recipient's extension watches its inbox and injects each mail as a
`pi-relay.mail.v1` message (`deliverAs: followUp`), which starts a turn when
the session is idle. Mail is labelled as coming from another session, not
the user. Each reply increments `hop`; from hop 6 on a mail is still shown
but no longer starts a turn, so two sessions cannot wake each other forever.

Mail to a session that is not running is refused (`not_found`); mail already
queued when a session exits waits for that session id to resume. Known
trade-offs: a crash while a mail is queued behind a running turn can lose that
mail, and a resumed session that gets a new session id does not inherit the
old inbox. There is no authentication: anything that can write the 0700
relay home is already the machine owner. `PI_RELAY_MAIL=0` disables mail.

## Event relay: source, channel, binding

A **Source Host** is an independent process that captures events from a
publisher (a build script, a watcher, a CLI) and routes them to the Pi
sessions subscribed to a **channel**. Each subscription is a **binding**
created from a single-use invite; knowing a channel name is not permission.

Create a configuration and start the source. `config-create` does not start
anything:

```sh
pi-relay source config-create \
  --out ~/relay-config --home ~/.pi/relay \
  --realm local --source executor --channel build
pi-relay source serve --config ~/relay-config/source.json
```

Create a separate single-use invite for each target session:

```sh
pi-relay source invite \
  --source-file ~/relay-config/owner.json --channel build \
  --out ~/relay-config/invite-a.json --operation-id invite-a
```

In the target session run `/events bind /home/you/relay-config/invite-a.json`
(an absolute path; `~` is not expanded inside Pi), or let
the model call `relay_bindings` with `action: "bind"`. Binding requires Source
Owner consent and Target Owner approval. A plain bind is **display only**.

Publish a durable event and read its receipt:

```json
{"kind":"event","id":"build-17-exit","type":"process.exited.v1","schemaVersion":1,"data":{"exitCode":0,"summary":"Build finished"}}
```

```sh
pi-relay publish --source-file ~/relay-config/publisher.json --event-file event.json
pi-relay receipt --source-file ~/relay-config/publisher.json --event-id build-17-exit
```

The publisher sees its channel's per-route disposition, not other sessions'
identifiers or transcripts. Source capture (`source-staged`), a route's
offline `staged`, target `accepted`, Pi submission and observed session
history are separate facts.

## Model resumption

Display-only events never start a model turn. To let an event wake the
model, the source must allow it (`config-create --allow-resume
--max-auto-targets 2`, invites with `--allow-resume`), the target must bind
with `/events bind PATH --resume`, and the owner must then **arm** a grant:

```text
/events arm BINDING_ID --types process.exited.v1 --claims 1 --ttl-ms 600000
/events inspect BINDING_ID EVENT_ID
/events pause BINDING_ID
/events resume BINDING_ID --reason manual
/events arm BINDING_ID --claims 1 --ttl-ms 600000
```

Control changes invalidate the previous grant revision. Resuming a hold is
not rearming. Old display-only events never become resumable because a new
permission was granted later. Navigation holds require `/events resume
BINDING_ID --reason navigation --approve-current-branch`; recovery holds
require `--reason recovery`. Both still require a new arm.

The `relay_bindings` tool's `bind` verb binds in resume mode and arms a
bounded default grant (4 claims / 30 minutes). Hold, claim and revision
control stays on the `/relay` commands.

One binding's `unknown` or in-flight attempt latches automatic resumption
for the **entire target store**: an unresolved attempt on binding A also
freezes model wakes on binding B of the same Pi session until it is
reconciled (see [operations](ops/operations.md#facts-unknown-and-controls)).

## Local standing bindings

For channels that never leave the machine, the invite ceremony is optional.
A channel whose owner opts in with `localTrust: true` can be bound directly
by any session in the same relay home and realm:

```js
const { bindingId, standing, armed } = await targetHost.bindLocal({
  sourceId: 'my-watcher', channelId: 'W',
});
```

- No invite, no invite TTL and no binding TTL. The standing grant is
  session-scoped with no claim cap; the wake budget is enforced by the
  eligibility gates, revision/scope/attachment fencing, the managed guard and
  the event-type allowlist.
- Authorization rests on the channel owner's `localTrust` declaration plus
  the 0700 private relay home (same uid). Enrollment still probes the live
  target endpoint.
- Several sessions may hold standing bindings on one channel without
  blocking each other. A standing enroll also cleans up crashed neighbors on
  the same channel.
- The source advertises `local-standing-v1`; an older source rejects the
  connect with `unsupported_feature`.

## Binding from another extension

A companion extension can ask the current session to bind itself over the Pi
event bus instead of routing through a tool call.

- Request channel `pi-relay:bind-request`:
  - invite bind (v1): `{ requestId, source, invitePath, projectRoot }` with an
    absolute path to an existing invite;
  - local standing bind (v2): `{ requestId, source, kind: 'local', sourceId,
    channelId, realm }`.
- Reply channel `pi-relay:bind-result` (same `requestId`):
  `{ ok: true, bindingId, armed }` (plus `standing: true` for v2) or
  `{ ok: false, error: { code, message } }`.

The listener does exactly what the `relay_bindings` bind tool does, so
auto-bind completes plumbing without creating new authority. Useful reply
codes: `invite_consumed` or messages containing "already" mean stop;
`not_attached` / `no_session_file` mean retry later; `local_trust_disabled`
means fall back to an invite. The listener never binds the same invite path
twice.

## Managed consumers and host responses

Plugins, CLIs and installers register managed consumers declaratively: drop
a JSON file into `<relay-home>/consumers/<profileId>.json`. The extension
scans the directory at session start and on `/relay consumer rescan`,
turning each file into a durable target registration plus a live policy
guard. External processes never hold route or target tokens.

```json
{
  "profileId": "my-watcher",
  "displayName": "my-watcher",
  "description": "wake on watched process exits",
  "eventTypes": ["process.exited.v1"],
  "responseTypes": ["watcher.response.v1"],
  "requestedMode": "resume",
  "policy": { "admission": "auto", "requireCurrentScope": true, "timeoutMs": 2000 }
}
```

- `eventTypes` is the guard allowlist; other types defer (`BUSY`) instead of
  waking the session.
- `policy.admission: "hold"` defers every delivery (review first).
- `policy.requireCurrentScope` (default true) requires a confirmable current
  source scope before the guard runs.

Management:

- CLI: `pi-relay consumer add --file watcher.json [--home DIR] [--force]`,
  `consumer list|show|rm`.
- In Pi: `/relay consumer list|show|register|revoke|rescan` and
  `/relay deliveries [--state S] [--limit N]`.
- SDK: `parseConsumerDeclaration`, `writeConsumerDeclaration` and
  `registerDeclarations` from `@maolon/pi-relay/consumer`.

Revoking a consumer makes the pump defer that profile's deliveries
(`GUARD_UNAVAILABLE`, no wake budget consumed); it never forges an outcome.

**Responding.** After a managed delivery wakes the session, the decision goes
back through the relay to the publisher:

- Owner: `/relay respond <deliveryRef> <action> [--reason <text>] [--until <ISO8601>]`
- Model: the `relay_respond` tool (`deliveryRef` from the wake message,
  `action`, `reason`; `until` required for `defer`).

`action` is one of `received | investigating | defer | resolved | dismiss`.
Deliveries in `recorded | submitted | held | pending` are respondable;
terminal states (`expired | withdrawn | suppressed`) reject with
`invalid_state`. The `operationId` is the idempotency key. Episode identity,
revisions and the response type are rebuilt from durable state, never from
caller input, so the model can pick an action but cannot forge identity.

## Streaming and recovery

`pi-relay ingest --source-file PATH` reads one stdin stream and emits bounded,
coalesced progress snapshots. EOF is **not** a process-exit fact: the
executor must separately publish `process.exited.v1` with the real exit
code. More than 16 streams per binding is rejected.

A finite publisher waits for per-route admission/staging results, not model
completion. Reuse the same event ID after an uncertain response; never
manufacture a new ID to retry. A restarted Source Host can explicitly replay
unresolved routes:

```sh
pi-relay source status --source-file ~/relay-config/owner.json
pi-relay source replay --source-file ~/relay-config/owner.json \
  --channel build --operation-id replay-17 --revision REVISION
```

Target startup imports its registered staging files; `/events import
BINDING_ID` imports another batch. Restoring a target adds a recovery hold
and disarms grants. Unknown submission attempts are never resent
automatically.

## Source authority recovery

Re-registering the same `sourceId` with new owner/publisher tokens (lost
secrets, a moved relay home) is rejected with `SourceAuthorityMismatch`
because the stored authority digest no longer matches. Recover as the local
operator:

```sh
# 1. stop the process still holding the old source store
# 2. quarantine it (moved under <home>/sources/.quarantine/, never deleted)
pi-relay source reset --source my-watcher --home ~/.pi/relay
# 3. create the source again with the new tokens
```

`resetSource(sourceId, home)` from `@maolon/pi-relay/source` does the same.
Reset on a source with no store is a no-op (`{ reset: false }`).

## SDK

```js
import { connectChannel, readSourceHandle } from '@maolon/pi-relay/client';

const publisher = connectChannel(readSourceHandle('/private/publisher.json'));
try {
  const result = await publisher.publish({
    kind: 'event', id: 'build-17-exit', type: 'process.exited.v1',
    schemaVersion: 1, data: { exitCode: 1, summary: 'Compiler failed' },
  });
  console.log(result); // admission, not "the build succeeded"
} finally {
  publisher.dispose();
}
```

| Entry point | Contents |
| --- | --- |
| `@maolon/pi-relay` | protocol + client re-exports; no Pi, SQLite or flock imports |
| `@maolon/pi-relay/client` | publisher client (`connectChannel`, `readSourceHandle`) |
| `@maolon/pi-relay/protocol` | wire types and validators; schemas under `/schemas/*` |
| `@maolon/pi-relay/source` | Source Host and source store (native state) |
| `@maolon/pi-relay/target` | target host (native state) |
| `@maolon/pi-relay/consumer` | managed consumer declarations |
| `@maolon/pi-relay/extension` | the Pi extension entry |

`@maolon/pi-relay` and `/client` have no startup side effects. All entry
points are ESM; the `require` condition points at the same files, so
CommonJS consumers work through Node's `require(esm)`.

## Platform notes

macOS and Linux are the supported platforms (see
[platform support](ops/platform-support.md)). All OS-specific behavior sits
behind one seam, `src/platform/os-interop.ts`:

- Transport: a Unix domain socket under a private runtime dir (a named pipe
  on Windows).
- Ownership lock: `flock` (an O_EXCL lock file with pid liveness on Windows).
- Privacy checks: uid plus 0700/0600 mode bits (NTFS profile ACLs on Windows).
- Durability: file fsync plus parent-directory fsync on POSIX.
