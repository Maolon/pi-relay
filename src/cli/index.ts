#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { exitFor, classifyExit } from './exit.js';
import { once } from 'node:events';
import { join, dirname, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { readFileSync, openSync, closeSync, fstatSync, constants } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import {
  SourcePublisher,
  BindingClient,
  readSourceHandle,
  readBindingHandle,
  openSource,
  openBinding,
} from '../client/index.js';
import type { SourceConfig, FanoutResult, AdmissionResult, Value, Progress } from '../protocol/types.js';
import { BUILTIN_TYPES, validate } from '../protocol/validate.js';
import { canonical, newId, secret, sha256 } from '../protocol/canonical.js';
import { parseJson } from '../protocol/json.js';
import { invariant, safeError, fail } from '../protocol/errors.js';
import { privateDir, privateJson } from '../platform/private-paths.js';
import { installPrivate } from '../platform/atomic-file.js';
import { createSource } from '../source/host.js';
import { resetSource } from '../source/core.js';
import {
  parseConsumerDeclaration,
  writeConsumerDeclaration,
  listConsumerDeclarations,
  removeConsumerDeclaration,
} from '../consumer/index.js';

const HELP = `pi-relay — explicit, local, capability-scoped event delivery

  source config-create --out DIR --source ID --channel ID [--home DIR] [--realm ID]
                       [--allow-resume] [--max-auto-targets N]
  source serve         --config FILE
  source invite        --source-file OWNER --channel ID --out FILE
                       [--allow-resume] [--operation-id ID] [--ttl-ms N] [--binding-ttl-ms N]
  source status        --source-file OWNER
  source reset         --source ID [--home DIR]   # quarantine a source store (authority recovery)
  source replay|close|revoke --source-file OWNER --channel ID --operation-id ID --revision N
  publish              --source-file HANDLE [--channel ID] --event-file FILE
  publish              --binding-file HANDLE --stdin
  ingest               --source-file HANDLE [--channel ID] [--stream-id ID]
  receipt              --binding-file HANDLE --event-id ID [--watch] [--after N]
  receipt              --source-file HANDLE [--channel ID] --event-id ID
  consumer add         --file FILE [--home DIR] [--force]
  consumer list        [--home DIR]
  consumer show        --profile ID [--home DIR]
  consumer rm          --profile ID --home DIR
  doctor               [--source-file HANDLE | --binding-file HANDLE]

Handles/config/invites are private files, never token arguments. Source serve runs
in the foreground and does not launch, own or kill a business process. Ingest EOF
is a progress fact, NOT a process-exit event. Supply process.exited.v1 explicitly.
Exit codes (sealed ARCHITECTURE contract): 0=explicit success scope (per-route
accepted/staged/buffered or a legal progress result); 2=argument/schema error;
3=authorization/policy rejection; 4=partial/unknown/backpressure (including any
source-staged-but-not-materialized route); 5=platform/Store error.
`;
const optionTypes = {
  out: 'string',
  source: 'string',
  channel: 'string',
  home: 'string',
  realm: 'string',
  config: 'string',
  'source-file': 'string',
  'binding-file': 'string',
  'event-file': 'string',
  'event-id': 'string',
  'stream-id': 'string',
  'operation-id': 'string',
  'ttl-ms': 'string',
  'binding-ttl-ms': 'string',
  'max-auto-targets': 'string',
  revision: 'string',
  after: 'string',
  profile: 'string',
  file: 'string',
  force: 'boolean',
  'allow-resume': 'boolean',
  'auto-required': 'boolean',
  stdin: 'boolean',
  watch: 'boolean',
  help: 'boolean',
} as const;
const optionSchema = Object.fromEntries(
  Object.entries(optionTypes).map(([k, type]) => [k, { type }]),
) as Record<string, { type: 'string' | 'boolean' }>;
async function output(value: unknown): Promise<void> {
  if (!process.stdout.write(canonical(value) + '\n')) await once(process.stdout, 'drain');
}
function number(value: string | boolean | undefined, fallback: number): number {
  const n = value === undefined ? fallback : Number(value);
  invariant(Number.isSafeInteger(n) && n >= 0);
  return n;
}
async function stdinText(limit = 131072): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const b of process.stdin) {
    const chunk = Buffer.from(b);
    size += chunk.length;
    invariant(size <= limit);
    chunks.push(chunk);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}
function payloadFile(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    invariant(st.isFile() && st.size <= 131072, 'unsafe_path');
    const b = readFileSync(fd);
    invariant(b.length <= 131072);
    return parseJson(new TextDecoder('utf-8', { fatal: true }).decode(b));
  } finally {
    closeSync(fd);
  }
}
export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  let command = args.shift() ?? 'help',
    subcommand: string | undefined;
  if (command === 'source' || command === 'consumer') subcommand = args.shift();
  let parsed: { values: Record<string, unknown>; positionals: string[] } | undefined;
  try {
    parsed = parseArgs({ args, options: optionSchema, strict: true, allowPositionals: false });
  } catch {
    fail('invalid_payload'); // unknown/missing flags are argument errors (exit 2)
  }
  const { values, positionals } = parsed!;
  invariant(positionals.length === 0);
  const text = (key: string): string | undefined =>
    typeof values[key] === 'string' ? (values[key] as string) : undefined;
  const required = (key: string): string => {
    const value = text(key);
    invariant(value && value.length > 0);
    return value;
  };
  if (command === 'help' || values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === 'consumer') {
    // Declarative consumer registration (stage 4): file operations only.
    // The Pi process performs the live registration when it scans
    // <home>/consumers at session start (or via /relay consumer rescan).
    const home = privateDir(resolve(text('home') ?? join(homedir(), '.pi', 'relay')));
    const sub = subcommand ?? 'list';
    if (sub === 'add') {
      const decl = parseConsumerDeclaration(payloadFile(required('file')));
      const { file } = writeConsumerDeclaration(home, decl, { force: !!values.force });
      process.stdout.write(JSON.stringify({ file, profileId: decl.profileId }, null, 2) + '\n');
      process.stderr.write(
        'registered declaratively — the Pi session picks it up at next start or /relay consumer rescan\n',
      );
      return 0;
    }
    if (sub === 'list') {
      const listed = listConsumerDeclarations(home);
      process.stdout.write(JSON.stringify(listed, null, 2) + '\n');
      return 0;
    }
    if (sub === 'show') {
      const id = required('profile');
      const hit = listConsumerDeclarations(home).filter((x) => x.declaration?.profileId === id);
      process.stdout.write(JSON.stringify(hit, null, 2) + '\n');
      return 0;
    }
    if (sub === 'rm') {
      const removed = removeConsumerDeclaration(home, required('profile'));
      if (!removed) fail('not_found');
      process.stdout.write(JSON.stringify({ removed: true }, null, 2) + '\n');
      return 0;
    }
    fail('unsupported_feature');
  }
  invariant(
    !values['auto-required'] || (command === 'publish' && !!text('source-file') && !text('binding-file')),
    'unsupported_feature',
  );
  if (command === 'source' && subcommand === 'reset') {
    const home = privateDir(resolve(text('home') ?? join(homedir(), '.pi', 'relay')));
    await output(resetSource(required('source'), home));
    return 0;
  }
  if (command === 'source' && subcommand === 'config-create') {
    const dir = privateDir(resolve(required('out'))),
      home = privateDir(resolve(text('home') ?? join(homedir(), '.pi', 'relay'))),
      sourceId = required('source'),
      channel = required('channel'),
      realm = text('realm') ?? 'local';
    const config: SourceConfig = {
      version: 1,
      sourceId,
      realm,
      home,
      channels: [
        {
          id: channel,
          types: BUILTIN_TYPES,
          allowedModes: values['allow-resume'] ? ['display', 'resume'] : ['display'],
          maxAutoTargets: number(text('max-auto-targets'), values['allow-resume'] ? 1 : 0),
        },
      ],
      ownerToken: secret(),
      publisherTokens: { [channel]: secret() },
    };
    validate('SourceConfig', config);
    const discoveryFile = join(home, 'sources', sha256(sourceId), 'host.json'),
      configFile = join(dir, 'source.json'),
      ownerFile = join(dir, 'owner.json'),
      publisherFile = join(dir, 'publisher.json');
    installPrivate(configFile, config);
    installPrivate(ownerFile, {
      version: 1,
      kind: 'source',
      sourceId,
      realm,
      discoveryFile,
      credential: config.ownerToken,
    });
    installPrivate(publisherFile, {
      version: 1,
      kind: 'source',
      sourceId,
      realm,
      channelId: channel,
      discoveryFile,
      credential: config.publisherTokens[channel],
    });
    await output({ configFile, ownerFile, publisherFile });
    return 0;
  }
  if (command === 'source' && subcommand === 'serve') {
    const source = await createSource(validate('SourceConfig', privateJson(required('config'))));
    await output({
      state: 'ready',
      sourceId: source.core.config.sourceId,
      attachmentId: source.core.attachmentId,
    });
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        resolve();
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
    await source.close();
    return 0;
  }
  if (command === 'source') {
    const { rpc } = await openSource(readSourceHandle(required('source-file')));
    let sourceControl;
    try {
      if (subcommand === 'invite') {
        const invite = validate(
          'Invite',
          await rpc.call({
            op: 'source.invite',
            operationId: text('operation-id') ?? newId('invite-op'),
            channelId: required('channel'),
            ttlMs: number(text('ttl-ms'), 600000),
            bindingTtlMs: number(text('binding-ttl-ms'), 86400000),
            allowResume: values['allow-resume'] === true,
          }),
        );
        const requested = resolve(required('out'));
        const out = join(privateDir(dirname(requested)), basename(requested));
        installPrivate(out, invite);
        await output({ inviteFile: out, inviteId: invite.inviteId, expiresAt: invite.expiresAt });
      } else if (subcommand === 'status') await output(await rpc.call({ op: 'source.status' }));
      else {
        invariant(subcommand && ['replay', 'close', 'revoke'].includes(subcommand), 'unsupported_feature');
        sourceControl = await rpc.call({
          op: 'source.control',
          channelId: required('channel'),
          operationId: required('operation-id'),
          expectedRevision: number(required('revision'), 0),
          action: subcommand as 'replay' | 'close' | 'revoke',
        });
        await output(sourceControl);
      }
    } finally {
      rpc.dispose();
    }
    return sourceControl ? exitFor(sourceControl as Record<string, unknown>) : 0;
  }
  if (command === 'doctor') {
    const require = createRequire(import.meta.url),
      Database = require('better-sqlite3'),
      db = new Database(':memory:');
    const sqlite = db.prepare('SELECT sqlite_version() version').get();
    db.close();
    require('fs-ext');
    const checks: {
      native: string;
      node: string;
      abi: string | undefined;
      platform: string;
      sqlite: unknown;
      endpoint?: string;
    } = {
      native: 'loaded; run gate:native for behavioral qualification',
      node: process.version,
      abi: process.versions.modules,
      platform: process.platform + '-' + process.arch,
      sqlite,
    };
    if (text('source-file')) {
      const { rpc } = await openSource(readSourceHandle(required('source-file')));
      rpc.dispose();
      checks.endpoint = 'source authenticated';
    }
    if (text('binding-file')) {
      const { rpc } = await openBinding(readBindingHandle(required('binding-file')));
      rpc.dispose();
      checks.endpoint = 'binding authenticated';
    }
    await output(checks);
    return 0;
  }
  invariant(command === 'publish' || command === 'receipt' || command === 'ingest', 'unsupported_feature');
  invariant(!!text('source-file') !== !!text('binding-file'));
  const client = text('source-file')
    ? new SourcePublisher(
        readSourceHandle(required('source-file')),
        text('channel') ?? readSourceHandle(required('source-file')).channelId,
      )
    : new BindingClient(readBindingHandle(required('binding-file')));
  try {
    if (command === 'publish') {
      invariant(!!text('event-file') !== !!values.stdin);
      const value = validate(
        'Value',
        text('event-file') ? payloadFile(required('event-file')) : parseJson(await stdinText()),
      );
      invariant(!values['auto-required'] || value.kind === 'event', 'unsupported_feature');
      const result =
        client instanceof SourcePublisher
          ? await client.publish(value, { autoRequired: values['auto-required'] === true })
          : await client.publish(value);
      await output(result);
      return exitFor(result);
    }
    if (command === 'receipt') {
      if (values.watch) {
        invariant(client instanceof BindingClient, 'unsupported_feature');
        const abort = new AbortController();
        const stop = () => abort.abort();
        process.once('SIGINT', stop);
        try {
          for await (const update of client.watchReceipts({
            after: number(text('after'), 0),
            signal: abort.signal,
          }))
            await output(update);
        } finally {
          process.off('SIGINT', stop);
        }
        return 0;
      }
      await output(
        client instanceof SourcePublisher
          ? await client.getFanout(required('event-id'))
          : await client.getReceipt(required('event-id')),
      );
      return 0;
    }
    const decoder = new StringDecoder('utf8'),
      streamId = text('stream-id') ?? newId('stream');
    let tail = '',
      revision = 0,
      last = 0,
      result: FanoutResult | AdmissionResult | undefined;
    const send = async (eof = false) => {
      const value: Progress = {
        kind: 'progress',
        type: 'process.progress.v1',
        schemaVersion: 1,
        streamId,
        revision: ++revision,
        snapshot: { tail, ...(eof ? { eof: true } : {}) },
      };
      result = await client.publish(value);
      last = Date.now();
    };
    const append = (text: string) => {
      const bytes = Buffer.from(tail + text);
      tail = bytes.subarray(Math.max(0, bytes.length - 8000)).toString('utf8');
    };
    for await (const chunk of process.stdin) {
      append(decoder.write(chunk));
      if (Date.now() - last >= 200) await send();
    }
    append(decoder.end());
    await send(true);
    await output({ eof: true, processExitReported: false, result });
    return result ? exitFor(result) : 0;
  } finally {
    client.dispose();
  }
}
main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    const errorOut = safeError(error);
    process.stderr.write(canonical({ error: errorOut }) + '\n');
    process.exitCode = classifyExit(errorOut);
  });
