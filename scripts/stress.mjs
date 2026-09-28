import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { piFixture } from '../test/fixtures/pi.mjs';
import { providerFixture } from '../test/fixtures/provider.mjs';
import { event, progress, eventually } from '../test/fixtures/system.mjs';
import { createSource, BUILTIN_TYPES } from '../dist/source/index.js';
import { secret, newId } from '../dist/protocol/index.js';
const root = mkdtempSync(join(tmpdir(), 'relay-stress-')),
  home = join(root, 'state'),
  targets = [];
let source, provider;
const histogram = monitorEventLoopDelay({ resolution: 20 });
const report = {
  kind: 'real-Pi-local-provider-stress',
  durationMs: 60000,
  offeredProgress: 30000,
  uiMode: 'rpc-unavailable',
  slowTargetInjected: false,
  platform: process.platform,
  arch: process.arch,
  node: process.version,
};
try {
  provider = await providerFixture();
  source = await createSource({
    version: 1,
    sourceId: 'stress',
    realm: 'test',
    home,
    ownerToken: secret(),
    publisherTokens: { X: secret() },
    channels: [{ id: 'X', types: BUILTIN_TYPES, allowedModes: ['display', 'resume'], maxAutoTargets: 2 }],
  });
  const projections = [0, 0];
  for (let i = 0; i < 2; i++) {
    const cwd = join(root, 'pi-' + i);
    mkdirSync(cwd, { mode: 0o700 });
    const target = await piFixture({ home, cwd, url: provider.url });
    targets.push(target);
    const id = await target.host.bind(
      source.core.createInvite({
        operationId: newId('invite'),
        channelId: 'X',
        ttlMs: 600000,
        bindingTtlMs: 3600000,
        allowResume: true,
      }),
      { resume: true },
    );
    target.bindingId = id;
    target.host.core.options.onProgress = () => projections[i]++;
    target.host.core.control(id, {
      operationId: newId('arm'),
      expectedRevision: target.host.core.binding(id).revision,
      action: 'arm',
      grant: { eventTypes: ['process.exited.v1'], maxClaims: 1, ttlMs: 600000 },
    });
  }
  const before = process.memoryUsage().rss;
  let maximum = before;
  histogram.enable();
  const start = performance.now();
  let durableAdmissionMs;
  for (let batch = 0; batch < 600; batch++) {
    for (let n = 0; n < 50; n++)
      await source.core.publish(
        'X',
        progress(batch * 50 + n + 1, 'stress-stream', 'progress-not-for-the-model'),
      );
    if (batch === 100) {
      const t = performance.now();
      await source.core.publish('X', event('durable-during-progress'));
      durableAdmissionMs = performance.now() - t;
    }
    maximum = Math.max(maximum, process.memoryUsage().rss);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, start + (batch + 1) * 100 - performance.now())),
    );
  }
  await eventually(() => provider.requests.length === 2);
  for (const target of targets) {
    assert.equal(target.host.core.store.get('SELECT count(*) n FROM events').n, 1);
    assert.equal(target.host.core.progressSnapshot(target.bindingId).length, 1);
  }
  assert(!JSON.stringify(provider.requests).includes('progress-not-for-the-model'));
  for (const count of projections) assert(count <= 305, `Projection rate exceeded bound: ${count}`);
  Object.assign(report, {
    status: 'passed',
    elapsedMs: performance.now() - start,
    providerRequests: provider.requests.length,
    progressInModel: 0,
    targetProgressAdmissions: projections,
    durableAdmissionMs,
    rssStart: before,
    rssPeak: maximum,
    rssGrowth: maximum - before,
    eventLoopP99Ms: histogram.percentile(99) / 1e6,
  });
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  process.exitCode = 1;
} finally {
  histogram.disable();
  await source?.close();
  for (const target of targets) await target.close();
  await provider?.close();
  rmSync(root, { recursive: true, force: true });
  mkdirSync('artifacts/implementation/T11', { recursive: true });
  writeFileSync('artifacts/implementation/T11/stress.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
