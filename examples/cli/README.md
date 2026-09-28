# Independent CLI source

Use the README's `source config-create`, `source serve`, per-target invites and finite `publish` command. The Source Host must be independent of both subscriber process trees.

Read a business CLI's output exactly once. Feed that stream to `pi-relay ingest --source-file /private/publisher-CHANNEL.json`. The ingest command does not spawn the CLI and EOF only ends the stream. The executor, which knows the actual exit code, publishes the independent durable exit event. Preserve complete business logs in the executor; relay progress retains only a bounded tail.

Credentials are private files, never command-line bearer values. After a lost response, inspect/retry the original event ID. Do not restart the business task merely because a relay response was uncertain.
