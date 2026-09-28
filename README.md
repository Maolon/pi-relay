# pi-relay

A [Pi](https://pi.dev) extension that lets sessions talk to each other and lets
the outside world wake a session.

- **Session mail**: Pi sessions on the same machine send each other short
  messages. An idle recipient picks the message up as a new turn.
- **Event relay**: CLIs, scripts and other extensions publish durable events
  (for example "build finished, exit code 1") to one or more sessions. Events
  are shown in the session, and can wake the model only when the session
  owner has explicitly armed that.

Everything stays on one machine: a private state directory, Unix sockets and
SQLite. No network, no daemon installed for you.

> **Status: experimental (0.x).** Tested on macOS arm64 and Linux x64 with
> Pi 0.85.1. APIs and on-disk formats may change between minor versions.

## Install

```sh
pi install npm:@maolon/pi-relay
```

Requires Node ≥ 22.16. Installation builds two native modules
(`better-sqlite3`, `fs-ext`), so a C/C++ toolchain must be available.

## Session mail

Open two Pi sessions and give them names (`/name api`, `/name web`). Then just
ask:

> Tell the `web` session that the `/v2/users` endpoint now returns `createdAt`.

The model calls `relay_mail`, and the `web` session receives:

```text
[pi-relay mail] Message from session "api" (another agent session, not the user; ...)
```

Mail works without any setup. Loops are bounded: after six hops a reply is
still shown but no longer starts a turn. Set `PI_RELAY_MAIL=0` to turn it off.

## Event relay in 60 seconds

```sh
# 1. create a source with one channel, then run it in its own terminal
pi-relay source config-create --out ~/relay-config --home ~/.pi/relay \
  --realm local --source executor --channel build
pi-relay source serve --config ~/relay-config/source.json

# 2. mint a single-use invite for one session
pi-relay source invite --source-file ~/relay-config/owner.json \
  --channel build --out ~/relay-config/invite-a.json --operation-id invite-a
```

In the Pi session, bind with the invite's absolute path (`~` is not expanded
inside Pi): `/events bind /home/you/relay-config/invite-a.json`. Then publish:

```sh
echo '{"kind":"event","id":"build-17","type":"process.exited.v1","schemaVersion":1,"data":{"exitCode":0,"summary":"Build finished"}}' > event.json
pi-relay publish --source-file ~/relay-config/publisher.json --event-file event.json
```

The event appears in the session. Letting it start a model turn needs an
explicit opt-in at every level (source, invite, bind and `/events arm`); see
the [guide](docs/guide.md#model-resumption). Run the CLI with `npx
@maolon/pi-relay` if it is not installed globally.

## What the model gets

| Tool | Purpose |
| --- | --- |
| `relay_mail` | list live sessions (`peers`) and `send` / reply to mail |
| `relay_bindings` | `bind` / `unbind` / `list` event bindings, e.g. for a companion CLI's invite |
| `relay_respond` | acknowledge, defer or resolve a delivery that woke the session |
| `events_status` | read-only relay status |

No tool exposes credentials. Owner-only controls (arm, pause, revoke,
reconcile) live behind `/events` (alias `/relay`); plain `/events` lists this
session's bindings.

## SDK

```js
import { connectChannel, readSourceHandle } from '@maolon/pi-relay/client';

const channel = connectChannel(readSourceHandle('/private/publisher.json'));
await channel.publish({
  kind: 'event', id: 'build-17', type: 'process.exited.v1',
  schemaVersion: 1, data: { exitCode: 1, summary: 'Compiler failed' },
});
channel.dispose();
```

## Documentation

- [Guide](docs/guide.md): mail details, resumption, local standing bindings,
  extension-to-extension binding, managed consumers, streaming, SDK entry points
- [Operations](docs/ops/operations.md): credentials, limits, unknown
  reconciliation, backup and rollback
- [Platform support](docs/ops/platform-support.md)

## Development

```sh
npm ci --ignore-scripts && npm rebuild fs-ext --foreground-scripts
npm run typecheck && npm test
npm run test:ci        # native gate + typecheck + build + full suite
```

Tests use isolated temp directories and a loopback fake provider; they never
touch your Pi sessions or call a paid model. Work happens on `dev`; merging
to `main` publishes to npm (see [CONTRIBUTING](CONTRIBUTING.md)).

## License

[MIT](LICENSE)
