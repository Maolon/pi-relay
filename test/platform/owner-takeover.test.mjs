import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync as mkdirFs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { OwnerLock, readOwnerToken } from '../../dist/platform/owner-lock.js';
import { privateDir } from '../../dist/platform/private-paths.js';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('.', import.meta.url));

let root;
const clean = (name) => realpathSync(mkdtempSync(join(tmpdir(), 'relay-owner-' + name + '-')));

beforeAll(() => {
  root = clean('suite');
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});


describe('owner takeover fencing protocol', () => {
  it('a later process takes over from an earlier holder and the incumbent fences out', async () => {
    const dir = privateDir(join(root, 'a'));
    const incumbent = OwnerLock.acquireSync(join(dir, 'owner.lock'));
    const first = readOwnerToken(dir);
    expect(first.generation).toBe(1);
    expect(first.pid).toBe(process.pid);

    const child = fork(fileURLToPath(new URL('../fixtures/owner-child.mjs', import.meta.url)), [dir, 'take', '20', '5000'], { cwd: process.cwd() });
    // Child challenges; our next fence check must reject us.
    let fenced = '';
    for (let i = 0; i < 200 && !fenced; i++) {
      try { incumbent.assertHeld(); await new Promise((r) => setTimeout(r, 10)); }
      catch (e) { fenced = e.code ?? ''; }
    }
    expect(fenced).toBe('owner_superseded');
    // Even after being fenced out, a write attempt fails deterministically.
    expect(() => incumbent.assertHeld()).toThrowError();

    // The incumbent's supervisor steps down, releasing the flock.
    incumbent.close();

    const took = await new Promise((resolve) => child.on('message', resolve));
    expect(took.took).toBe(true);
    expect(took.token.generation).toBe(2);
    expect(took.token.pid).toBe(child.pid);

    const after = readOwnerToken(dir);
    expect(after.generation).toBe(2);
    child.kill();
  }, 20000);

  it('a wedged incumbent produces an actionable owner_conflict timeout', async () => {
    const dir = privateDir(join(root, 'b'));
    const wedged = fork(fileURLToPath(new URL('../fixtures/owner-child.mjs', import.meta.url)), [dir, 'hold-ignore'], { cwd: process.cwd() });
    const held = await new Promise((resolve) => wedged.on('message', resolve));
    expect(held.pid).toBeGreaterThan(0);
    expect(readOwnerToken(dir).pid).toBe(held.pid);

    const challenger = fork(fileURLToPath(new URL('../fixtures/owner-child.mjs', import.meta.url)), [dir, 'take', '20', '300'], { cwd: process.cwd() });
    const result = await new Promise((resolve) => challenger.on('message', resolve));
    expect(result.took).toBe(false);
    expect(result.code).toBe('owner_conflict');
    // The token still names the wedged incumbent for actionable messages.
    expect(result.token.pid).toBe(held.pid);
    wedged.kill();
    challenger.kill();
  }, 20000);

  it('generation is monotonic across successive owners and stale challenges self-heal', async () => {
    const dir = privateDir(join(root, 'c'));
    const a = OwnerLock.acquireSync(join(dir, 'owner.lock'));
    expect(readOwnerToken(dir).generation).toBe(1);
    a.close();
    // An abandoned challenge (dead pid) must not block or evict owners.
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'owner-challenges'), { recursive: true });
    writeFileSync(join(dir, 'owner-challenges', 'dead-1.json'), JSON.stringify({ generation: 99, pid: 424242, at: 1, deadline: Date.now() + 60_000 }));
    const b = OwnerLock.acquireSync(join(dir, 'owner.lock'));
    expect(readOwnerToken(dir).generation).toBe(2);
    b.assertHeld(); // dead-pid challenge was cleaned up, never evicts
    expect(existsSync(join(dir, 'owner-challenges', 'dead-1.json'))).toBe(false);
    b.close();
  });

  it('two live owners never coexist within one process', () => {
    const dir = privateDir(join(root, 'd'));
    const a = OwnerLock.acquireSync(join(dir, 'owner.lock'));
    expect(() => OwnerLock.acquireSync(join(dir, 'owner.lock'))).toThrowError();
    a.close();
  });
});

describe('owner takeover regression guards (reviewer P1s)', () => {
  it('a failed token write leaks neither the flock nor the in-process entry', () => {
    const dir = privateDir(join(root, 'leak'));
    const mkdirSync = mkdirFs;
    // Block the token destination with a directory: the durable bookkeeping
    // fails AFTER the flock was taken (rename cannot replace a directory).
    mkdirSync(join(dir, 'owner-token.json'), { recursive: true });
    expect(() => OwnerLock.acquireSync(join(dir, 'owner.lock'))).toThrow();
    rmSync(join(dir, 'owner-token.json'), { recursive: true });
    // The flock and the in-process registration must have been rolled back.
    const retry = OwnerLock.acquireSync(join(dir, 'owner.lock'));
    expect(readOwnerToken(dir).generation).toBeGreaterThanOrEqual(1);
    retry.close();
  });
});

describe('owner takeover reviewer regressions', () => {
  const childPath = () => fileURLToPath(new URL('../fixtures/owner-child.mjs', import.meta.url));

  it('two simultaneous challengers both eventually win (re-challenge tracks new owners)', async () => {
    const dir = privateDir(join(root, 'conc'));
    const incumbent = OwnerLock.acquireSync(join(dir, 'owner.lock'));
    expect(readOwnerToken(dir).generation).toBe(1);
    // Both challengers fork BEFORE any takeover happens: they contend for the
    // same incumbent, exercising the re-challenge path (each must chase the
    // other's intermediate generation, not just the original one).
    const first = fork(childPath(), [dir, 'take', '50', '10000'], { cwd: process.cwd(), execArgv: [] });
    const second = fork(childPath(), [dir, 'take', '50', '10000'], { cwd: process.cwd(), execArgv: [] });
    // Simulate the incumbent supervisor: yield as soon as fenced, then let the
    // fixture supervisors chain the handoff (each child fences and yields too).
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        try { incumbent.assertHeld(); } catch { clearInterval(timer); incumbent.close(); resolve(undefined); }
      }, 20);
    });
    const r1 = await new Promise((resolve) => first.once('message', resolve));
    const r2 = await new Promise((resolve) => second.once('message', resolve));
    expect(r1.took).toBe(true);
    expect(r2.took).toBe(true);
    // Message order may not match fork order; the generations themselves prove
    // the chain: both challengers won, each at a strictly later generation.
    const generations = [r1.token.generation, r2.token.generation].sort((a, b) => a - b);
    expect(generations[1]).toBeGreaterThan(generations[0]);
    first.kill();
    second.kill();
  }, 25000);

  it('a same-process takeover also fences and transfers (async acquire path)', async () => {
    const dir = privateDir(join(root, 'sameproc'));
    const a = OwnerLock.acquireSync(join(dir, 'owner.lock'));
    const takeover = OwnerLock.acquire(join(dir, 'owner.lock'), { takeover: true, pollMs: 25, timeoutMs: 4000 });
    let fenced = '';
    for (let i = 0; i < 200 && !fenced; i++) {
      try { a.assertHeld(); await new Promise((r) => setTimeout(r, 10)); }
      catch (e) { fenced = e.code; }
    }
    expect(fenced).toBe('owner_superseded');
    a.close();
    const b = await takeover;
    expect(readOwnerToken(dir).pid).toBe(process.pid);
    expect(readOwnerToken(dir).generation).toBe(2);
    b.close();
  }, 10000);

  it('an expired-deadline challenge from a live pid never evicts the incumbent', async () => {
    const { writeFileSync, mkdirSync, existsSync } = await import('node:fs');
    const dir = privateDir(join(root, 'expired'));
    const a = OwnerLock.acquireSync(join(dir, 'owner.lock'));
    mkdirSync(join(dir, 'owner-challenges'), { recursive: true });
    writeFileSync(join(dir, 'owner-challenges', 'stale.json'), JSON.stringify({ generation: 99, pid: process.pid, at: 1, deadline: Date.now() - 1000 }));
    a.assertHeld(); // expired: ignored, and cleaned up opportunistically
    expect(existsSync(join(dir, 'owner-challenges', 'stale.json'))).toBe(false);
    a.close();
  });
});
