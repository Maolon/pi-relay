/** Consumer registration surface (approved plan 02 §2.5 target consumer
 *  interface; stage 4 "公共 consumer registration").
 *
 *  Pi has no cross-extension service bus, and external processes must never
 *  hold route or target tokens (01 §1.2). The universal configuration surface
 *  is therefore declarative: any plugin, CLI, installer, or human drops a
 *  consumer declaration file into `<relay-home>/consumers/<profileId>.json`.
 *  The Pi extension scans that directory at session start (and on
 *  `/relay consumer rescan`), turning each declaration into a persistent
 *  target registration (`registerConsumer`, 02 §2.5) plus a live policy
 *  guard. In-process trusted code keeps using the programmatic
 *  `ManagedTarget.registerConsumer(profile, guard)` API directly.
 *
 *  Declarative guards are policy objects, not code: admission auto/hold,
 *  an exact event-type allowlist, and the scope-confirmation requirement.
 *  The network protocol still accepts no JavaScript, shell, or arbitrary
 *  reply endpoints. */
import { join, dirname } from 'node:path';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { canonical, sha256 } from '../protocol/canonical.js';
import { invariant } from '../protocol/errors.js';
import { installPrivate } from '../platform/atomic-file.js';
import { privateDir, privateJson } from '../platform/private-paths.js';
import type { GateResult } from '../protocol/managed-types.js';
import type { ManagedRoutePacket } from '../protocol/internal-types.js';
import type { ManagedGuardContext } from '../target/managed.js';

const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TYPE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\.v[0-9]{1,3}$/;

/** A declarative consumer registration. The file is the source of truth for
 *  what a plugin/CLI consumes; the target store keeps the durable
 *  registration row, and the Pi process holds the derived policy guard. */
export interface ConsumerDeclaration {
  readonly profileId: string;
  readonly displayName?: string;
  readonly description?: string;
  /** Exact event types this consumer accepts (guard allowlist). */
  readonly eventTypes: readonly string[];
  /** Response types this consumer may emit via `respond` (informational). */
  readonly responseTypes: readonly string[];
  readonly requestedMode: 'display' | 'resume';
  readonly policy: {
    /** `auto` lets the guard allow matching deliveries; `hold` defers every
     *  delivery (reason HELD_BY_POLICY) until the declaration changes. */
    readonly admission: 'auto' | 'hold';
    /** Require a confirmable current source scope before the guard runs. */
    readonly requireCurrentScope: boolean;
    /** Guard execution budget (ms), 100..10000. */
    readonly timeoutMs: number;
  };
}

/** Minimal sink so this module never imports the target runtime. */
export interface ConsumerRegistrationSink {
  registerConsumer(
    profile: {
      profileId: string;
      eventManifestDigest: string;
      responseManifestDigest: string;
      guardImplementationId: string;
      timeoutMs: number;
      requireCurrentScope?: boolean;
    },
    guard: (
      event: ManagedRoutePacket['event'],
      context: ManagedGuardContext,
      signal: AbortSignal,
    ) => Promise<GateResult>,
  ): { profileId: string; epoch: number };
}

function types(value: unknown, field: string, max: number): string[] {
  invariant(Array.isArray(value) && value.length <= max, 'invalid_payload');
  const out: string[] = [];
  for (const item of value) {
    invariant(typeof item === 'string' && TYPE_ID.test(item), 'invalid_payload');
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

export function parseConsumerDeclaration(input: unknown): ConsumerDeclaration {
  invariant(typeof input === 'object' && input !== null, 'invalid_payload');
  const raw = input as Record<string, unknown>;
  invariant(typeof raw.profileId === 'string' && PROFILE_ID.test(raw.profileId), 'invalid_payload');
  invariant(raw.displayName === undefined || typeof raw.displayName === 'string', 'invalid_payload');
  invariant(raw.description === undefined || typeof raw.description === 'string', 'invalid_payload');
  const eventTypes = types(raw.eventTypes, 'eventTypes', 32);
  invariant(eventTypes.length > 0, 'invalid_payload');
  const responseTypes = types(raw.responseTypes ?? [], 'responseTypes', 16);
  const requestedMode = raw.requestedMode ?? 'resume';
  invariant(requestedMode === 'display' || requestedMode === 'resume', 'invalid_payload');
  const policyRaw = (raw.policy ?? {}) as Record<string, unknown>;
  const admission = policyRaw.admission ?? 'auto';
  invariant(admission === 'auto' || admission === 'hold', 'invalid_payload');
  const requireCurrentScope = policyRaw.requireCurrentScope ?? true;
  invariant(typeof requireCurrentScope === 'boolean', 'invalid_payload');
  const timeoutMs = policyRaw.timeoutMs ?? 2000;
  invariant(
    typeof timeoutMs === 'number' && Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 10_000,
    'invalid_payload',
  );
  return {
    profileId: raw.profileId,
    displayName: raw.displayName,
    description: raw.description,
    eventTypes,
    responseTypes,
    requestedMode,
    policy: { admission, requireCurrentScope, timeoutMs },
  };
}

/** Deterministic manifest digest over a type list (registration provenance). */
export function manifestDigestOf(list: readonly string[]): string {
  return sha256(canonical([...list]));
}

export function declarationProfile(decl: ConsumerDeclaration) {
  return {
    profileId: decl.profileId,
    eventManifestDigest: manifestDigestOf(decl.eventTypes),
    responseManifestDigest: manifestDigestOf(decl.responseTypes),
    guardImplementationId: `declaration:${decl.policy.admission}:${decl.policy.requireCurrentScope ? 'scoped' : 'unscoped'}`,
    timeoutMs: decl.policy.timeoutMs,
    requireCurrentScope: decl.policy.requireCurrentScope,
  };
}

/** The declarative policy guard: no code, only the file's stated policy.
 *  Unsubscribed event types defer (the source misrouted the audience);
 *  `hold` defers everything; otherwise allow with a bounded 1h admission
 *  window (contract: allow gates carry validUntil; expiry re-defers as
 *  STALE_REQUEST and the next pump pass re-guards). */
export function declarationGuard(decl: ConsumerDeclaration) {
  return async (
    event: ManagedRoutePacket['event'],
    _context: ManagedGuardContext,
    _signal: AbortSignal,
  ): Promise<GateResult> => {
    if (decl.policy.admission === 'hold')
      return { decision: 'defer', reasonCode: 'BUSY', guardEpoch: 1 };
    if (!decl.eventTypes.includes(event.type))
      return { decision: 'defer', reasonCode: 'BUSY', guardEpoch: 1 };
    return {
      decision: 'allow',
      reasonCode: 'CURRENT',
      guardEpoch: 1,
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    };
  };
}

export function consumersDir(home: string): string {
  return join(home, 'consumers');
}

export function declarationFile(home: string, profileId: string): string {
  invariant(PROFILE_ID.test(profileId), 'invalid_payload');
  return join(consumersDir(home), profileId + '.json');
}

export function writeConsumerDeclaration(
  home: string,
  decl: ConsumerDeclaration,
  options?: { force?: boolean },
): { file: string } {
  const file = declarationFile(home, decl.profileId);
  invariant(options?.force || !existsSync(file), 'invalid_state');
  privateDir(dirname(file));
  // Canonical JSON rejects undefined values; emit only defined fields.
  const body: Record<string, unknown> = { profileId: decl.profileId };
  if (decl.displayName !== undefined) body.displayName = decl.displayName;
  if (decl.description !== undefined) body.description = decl.description;
  body.eventTypes = [...decl.eventTypes];
  body.responseTypes = [...decl.responseTypes];
  body.requestedMode = decl.requestedMode;
  body.policy = { ...decl.policy };
  installPrivate(file, body);
  return { file };
}

export interface ListedDeclaration {
  file: string;
  declaration?: ConsumerDeclaration;
  error?: { code: string; message: string };
}

export function listConsumerDeclarations(home: string): ListedDeclaration[] {
  const dir = consumersDir(home);
  if (!existsSync(dir)) return [];
  const out: ListedDeclaration[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const file = join(dir, name);
    try {
      out.push({ file, declaration: parseConsumerDeclaration(privateJson(file, 65_536)) });
    } catch (error) {
      const detail = error as { code?: string; message?: string };
      out.push({
        file,
        error: { code: detail.code ?? 'invalid_payload', message: detail.message ?? 'unparseable declaration' },
      });
    }
  }
  return out;
}

export function removeConsumerDeclaration(home: string, profileId: string): boolean {
  const file = declarationFile(home, profileId);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}

export interface ScanReport {
  registered: { file: string; profileId: string; epoch: number }[];
  failed: { file: string; code: string; message: string }[];
}

/** Scan `<home>/consumers/*.json` and (re-)register each declaration.
 *  Bad files never abort the scan; they surface in `failed` for the owner. */
export function registerDeclarations(sink: ConsumerRegistrationSink, home: string): ScanReport {
  const report: ScanReport = { registered: [], failed: [] };
  for (const listed of listConsumerDeclarations(home)) {
    if (!listed.declaration) {
      report.failed.push({ file: listed.file, ...listed.error! });
      continue;
    }
    try {
      const { epoch } = sink.registerConsumer(
        declarationProfile(listed.declaration),
        declarationGuard(listed.declaration),
      );
      report.registered.push({ file: listed.file, profileId: listed.declaration.profileId, epoch });
    } catch (error) {
      const detail = error as { code?: string; message?: string };
      report.failed.push({
        file: listed.file,
        code: detail.code ?? 'invalid_state',
        message: detail.message ?? 'registration failed',
      });
    }
  }
  return report;
}
