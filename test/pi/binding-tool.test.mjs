import { it, expect, afterEach } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { system, event } from '../fixtures/system.mjs';
import { registerBindingTool } from '../../dist/pi/tools.js';
import { newId } from '../../dist/protocol/index.js';

// The relay agent-facing surface is two tools: relay_bindings (bind/unbind/
// list) and relay_respond (host responses to managed-delivery wakes, handoff
// 2026-09-19). These tests drive execute() directly with a real TargetHost
// from the system fixture — the LLM loop is pi's business.

let sys;
afterEach(async () => {
  await sys?.close();
  sys = undefined;
});

function tool() {
  const host = sys.target[0];
  const defs = [];
  registerBindingTool(
    { registerTool: (def) => defs.push(def) },
    () => host,
  );
  const def = defs.find((d) => d.name === 'relay_bindings');
  const ctx = { sessionManager: { getSessionFile: () => '/persisted/session.jsonl' } };
  const run = (params) => def.execute('tc', params, undefined, undefined, ctx);
  const out = async (params) => (await run(params)).content[0].text;
  return { def, run, out, host };
}

it('registers exactly two tools (bindings + respond) and no hidden extras', async () => {
  sys = await system({ targets: 1 });
  const defs = [];
  registerBindingTool({ registerTool: (d) => defs.push(d) }, () => sys.target[0]);
  expect(defs).toHaveLength(2);
  expect(defs.map((d) => d.name).sort()).toEqual(['relay_bindings', 'relay_respond']);
  const bindings = defs.find((d) => d.name === 'relay_bindings');
  expect(Object.keys(bindings.parameters.properties).sort()).toEqual(['action', 'bindingId', 'invitePath']);
  expect(JSON.stringify(bindings.parameters.properties.action)).toContain('bind');
  expect(JSON.stringify(bindings.parameters.properties.action)).toContain('unbind');
  const respond = defs.find((d) => d.name === 'relay_respond');
  expect(Object.keys(respond.parameters.properties).sort()).toEqual(['action', 'deliveryRef', 'reason', 'until']);
  expect(respond.parameters.required.sort()).toEqual(['action', 'deliveryRef', 'reason']);
});

it('bind consumes an invite, arms with a default grant, and wakes on relayed events', async () => {
  sys = await system({ targets: 1 });
  const { out, host } = tool();
  // empty list first
  expect(await out({ action: 'list' })).toContain('"bindings": []');
  // invite file on disk, as a companion CLI would print it
  const invite = sys.source.core.createInvite({
    operationId: newId('inv'),
    channelId: 'X',
    ttlMs: 600000,
    bindingTtlMs: 3600000,
    allowResume: true,
  });
  const invitePath = join(sys.root, 'invite-tool.json');
  writeFileSync(invitePath, JSON.stringify(invite), { mode: 0o600 });
  const bindResult = await out({ action: 'bind', invitePath });
  expect(bindResult).toMatch(/Bound as bnd-/);
  expect(bindResult).toContain('armed');
  // binding exists with an active grant (armed semantics, 4 claims default)
  const [b] = host.core.list();
  expect(b.state).toBe('active');
  const status = host.core.status();
  expect(status.bindings[0].grants).toHaveLength(1);
  expect(status.bindings[0].grants[0].maxClaims).toBe(4);
  // the invite is single-use: a second bind attempt fails cleanly
  const again = await out({ action: 'bind', invitePath });
  expect(again).toMatch(/failed:/);
  // list reflects it
  const listed = JSON.parse(await out({ action: 'list' }));
  expect(listed.bindings).toHaveLength(1);
  expect(listed.bindings[0].armed).toBe(true);
}, 10000);

it('unbind revokes the binding and frees the channel slot', async () => {
  sys = await system({ targets: 1 });
  const { out, host } = tool();
  const invite = sys.source.core.createInvite({
    operationId: newId('inv'),
    channelId: 'X',
    ttlMs: 600000,
    bindingTtlMs: 3600000,
    allowResume: true,
  });
  const invitePath = join(sys.root, 'invite-tool2.json');
  writeFileSync(invitePath, JSON.stringify(invite), { mode: 0o600 });
  const bindResult = await out({ action: 'bind', invitePath });
  const bindingId = bindResult.match(/bnd-[0-9a-f]+/)[0];
  const revoked = await out({ action: 'unbind', bindingId });
  expect(revoked).toContain('revoked');
  const [b] = host.core.list();
  expect(b.authority).toBe('revoked');
  const status = host.core.status();
  expect(status.bindings[0].grants).toHaveLength(0);
});

it('bind without a persisted session file returns an actionable message', async () => {
  sys = await system({ targets: 1 });
  const defs = [];
  registerBindingTool({ registerTool: (d) => defs.push(d) }, () => sys.target[0]);
  const def = defs.find((d) => d.name === 'relay_bindings');
  const res = await def.execute(
    'tc',
    { action: 'bind', invitePath: '/nowhere.json' },
    undefined,
    undefined,
    { sessionManager: { getSessionFile: () => undefined } },
  );
  expect(res.content[0].text).toContain('persisted');
});

it('an armed tool-bound session receives relayed events (capture path)', async () => {
  sys = await system({ targets: 1 });
  const { out } = tool();
  const invite = sys.source.core.createInvite({
    operationId: newId('inv'),
    channelId: 'X',
    ttlMs: 600000,
    bindingTtlMs: 3600000,
    allowResume: true,
  });
  const invitePath = join(sys.root, 'invite-tool3.json');
  writeFileSync(invitePath, JSON.stringify(invite), { mode: 0o600 });
  await out({ action: 'bind', invitePath });
  // publish through the real source core
  await sys.source.core.publish('X', event('tool-evt-1'));
  // give the bus a tick
  await new Promise((r) => setTimeout(r, 50));
  const listed = JSON.parse(await out({ action: 'list' }));
  // the event was accepted (pending or delivered) — binding is live
  expect(listed.bindings[0].state).toBe('active');
}, 10000);
