import { it, expect } from 'vitest';
import { mkdtempSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createSource } from '../../dist/source/host.js';
import { resetSource, SourceAuthorityMismatch } from '../../dist/source/index.js';
import { BUILTIN_TYPES } from '../../dist/protocol/validate.js';
import { secret } from '../../dist/protocol/index.js';

// Handoff 2026-09-20 (pi-watcher -> pi-relay), issue A/P1: re-registering the
// same sourceId with new authority tokens (root migration, lost secrets, an
// E2E run that used a production home) used to fail as a bare invalid_state
// with no recovery. Contract: named library error with actionable message +
// wire code stays invalid_state; resetSource quarantines (never deletes) the
// old store; re-registration then succeeds.

function config(home, ownerToken) {
  return {
    version: 1,
    sourceId: 'reset-test',
    realm: 'local',
    home,
    channels: [{ id: 'ch', types: BUILTIN_TYPES, allowedModes: ['display'], maxAutoTargets: 0 }],
    ownerToken,
    publisherTokens: { ch: secret() },
  };
}

function tokens() {
  return [secret(), secret()];
}

async function cli(args) {
  const child = spawn(process.execPath, ['dist/cli/index.js', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '',
    err = '';
  child.stdout.on('data', (b) => (out += b));
  child.stderr.on('data', (b) => (err += b));
  child.stdin.end();
  const [code] = await once(child, 'exit');
  return { code, out, err, json: () => JSON.parse(out) };
}

it('[ops] authority mismatch raises the named error and keeps the wire code stable', async () => {
  const home = mkdtempSync(join(tmpdir(), 'relay-reset-'));
  const [tokenA, tokenB] = tokens();
  const a = await createSource(config(home, tokenA));
  await a.close();
  const attempt = createSource(config(home, tokenB));
  await expect(attempt).rejects.toBeInstanceOf(SourceAuthorityMismatch);
  try {
    await createSource(config(home, tokenB));
  } catch (e) {
    expect(e.detail.code).toBe('invalid_state');
    expect(e.detail.retryable).toBe(false);
    expect(e.message).toContain('pi-relay source reset');
    expect(e.message).toContain(e.storeDir);
    expect(e.sourceId).toBe('reset-test');
  }
});

it('[ops] resetSource quarantines the store and unlocks re-registration', async () => {
  const home = mkdtempSync(join(tmpdir(), 'relay-reset-'));
  const [tokenA, tokenB] = tokens();
  const a = await createSource(config(home, tokenA));
  const storeDir = a.core.store.dir;
  await a.close();
  const r = resetSource('reset-test', home);
  expect(r.reset).toBe(true);
  expect(r.quarantined.startsWith(join(realpathSync(home), 'sources', '.quarantine'))).toBe(true);
  expect(existsSync(r.quarantined)).toBe(true);
  expect(existsSync(storeDir)).toBe(false);
  // Idempotent: a second reset of the now-absent store reports nothing to do.
  expect(resetSource('reset-test', home).reset).toBe(false);
  const b = await createSource(config(home, tokenB));
  expect(b.core.config.sourceId).toBe('reset-test');
  await b.close();
  // Quarantine keeps the forensic copy, does not delete it.
  expect(readdirSync(join(realpathSync(home), 'sources', '.quarantine')).length).toBe(1);
});

it('[ops] CLI source reset drives the same recovery end-to-end', async () => {
  const home = mkdtempSync(join(tmpdir(), 'relay-reset-'));
  const [tokenA, tokenB] = tokens();
  const a = await createSource(config(home, tokenA));
  await a.close();
  const out = await cli(['source', 'reset', '--source', 'reset-test', '--home', home]);
  expect(out.code).toBe(0);
  const parsed = out.json();
  expect(parsed.reset).toBe(true);
  expect(parsed.quarantined).toContain('.quarantine');
  // No store left: an immediate second reset is a no-op.
  const again = await cli(['source', 'reset', '--source', 'reset-test', '--home', home]);
  expect(again.code).toBe(0);
  expect(again.json().reset).toBe(false);
  const b = await createSource(config(home, tokenB));
  await b.close();
});
