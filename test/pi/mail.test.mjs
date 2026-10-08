import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Mailbox, MAIL_MAX_HOPS, MAIL_POLL_MS } from '../../dist/mail/index.js';
import { registerMail } from '../../dist/pi/mail.js';

// Session mail (delta-3, context plans/managed-delivery-v0.3/delta-3 §6).
// Each fake session is a minimal ExtensionAPI + ExtensionContext pair; the
// fake sendMessage persists a custom_message entry the way Pi does, so the
// dedupe and reply lookup read real session-shaped entries.

let home;
const sessions = [];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pi-relay-mail-'));
  delete process.env.PI_RELAY_MAIL;
});
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.shutdown();
  rmSync(home, { recursive: true, force: true });
  delete process.env.PI_RELAY_MAIL;
});

function session(sessionId, name, { persist = true } = {}) {
  const handlers = {};
  const tools = [];
  const sent = [];
  const entries = [];
  let currentId = sessionId;
  let currentName = name;
  const pi = {
    registerTool: (d) => tools.push(d),
    on: (event, fn) => ((handlers[event] ??= []).push(fn)),
    getSessionName: () => currentName,
    sendMessage: (message, options) => {
      sent.push({ message, options });
      if (persist) entries.push({ type: 'custom_message', ...message });
    },
  };
  const ctx = {
    cwd: '/work/' + sessionId,
    ui: { notify: () => {} },
    sessionManager: { getSessionId: () => currentId, getEntries: () => entries },
  };
  const getMail = registerMail(pi, () => home);
  const emit = async (event) => {
    for (const fn of handlers[event] ?? []) await fn({}, ctx);
  };
  const tool = tools.find((t) => t.name === 'relay_mail');
  const s = {
    pi,
    ctx,
    sent,
    entries,
    getMail,
    start: () => emit('session_start'),
    shutdown: () => emit('session_shutdown'),
    agentEnd: () => emit('agent_end'),
    switchTo: async (id) => {
      currentId = id;
      await emit('session_start');
    },
    rename: (n) => (currentName = n),
    call: async (params) => (await tool.execute('tc', params, undefined, undefined, ctx)).content[0].text,
    pump: () => getMail()?.pump(),
  };
  sessions.push(s);
  return s;
}

const inbox = (id) => join(home, 'mail', 'inbox', id);
const files = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []);

it('1-2: send wakes the recipient; a reply continues the thread with hop+1', async () => {
  const a = session('aaaaaaaa-1111', 'alpha');
  const b = session('bbbbbbbb-2222', 'beta');
  await a.start();
  await b.start();
  const sent = JSON.parse(await a.call({ verb: 'send', to: 'beta', body: 'build is green' }));
  expect(sent).toMatchObject({ to: { name: 'beta', sessionId: 'bbbbbbbb-2222' }, hop: 0, delivered: 'queued' });
  b.pump();
  expect(b.sent).toHaveLength(1);
  const [{ message, options }] = b.sent;
  expect(message.customType).toBe('pi-relay.mail.v1');
  expect(message.content).toContain('from session "alpha"');
  expect(message.content).toContain('build is green');
  expect(message.details).toMatchObject({ namespace: 'pi-relay/mail/v1', mailId: sent.id, hop: 0 });
  expect(options).toEqual({ triggerTurn: true, deliverAs: 'followUp' });
  expect(files(inbox('bbbbbbbb-2222'))).toEqual([]);
  expect(files(join(inbox('bbbbbbbb-2222'), '.claimed'))).toEqual([]);

  // reply without "to": goes back to the sender, same thread, hop 1
  const reply = JSON.parse(await b.call({ verb: 'send', replyTo: sent.id, body: 'thanks' }));
  expect(reply).toMatchObject({ to: { name: 'alpha' }, threadId: sent.threadId, hop: 1 });
  a.pump();
  expect(a.sent[0].message.details).toMatchObject({ threadId: sent.threadId, hop: 1 });
});

it('replyTo must name a mail this session actually received', async () => {
  const a = session('aaaaaaaa-1111', 'alpha');
  const b = session('bbbbbbbb-2222', 'beta');
  await a.start();
  await b.start();
  expect(await a.call({ verb: 'send', replyTo: 'mail-' + '0'.repeat(32), body: 'x' })).toMatch(/unknown_reply/);
});

it('3: mail queued before the recipient exits is delivered once when it resumes', async () => {
  const a = session('aaaaaaaa-1111', 'alpha');
  const b1 = session('bbbbbbbb-2222', 'beta');
  await a.start();
  await b1.start();
  b1.getMail().box.unwatch(); // b1 is busy and never reads before exiting
  await a.call({ verb: 'send', to: 'beta', body: 'while you were away' });
  await b1.shutdown();
  expect(files(inbox('bbbbbbbb-2222'))).toHaveLength(1);
  // with no live peer file the session is unaddressable; new mail is refused
  expect(await a.call({ verb: 'send', to: 'beta', body: 'late' })).toMatch(/not_found/);
  // resume: a fresh process for the same session id reads the queued mail once
  const b2 = session('bbbbbbbb-2222', 'beta');
  await b2.start();
  b2.pump();
  expect(b2.sent).toHaveLength(1);
  expect(b2.sent[0].message.content).toContain('while you were away');
});

it('4: the same session open twice injects a mail in only one window', async () => {
  const a = session('aaaaaaaa-1111', 'alpha');
  const b1 = session('bbbbbbbb-2222', 'beta');
  const b2 = session('bbbbbbbb-2222', 'beta');
  await a.start();
  await b1.start();
  await b2.start();
  await a.call({ verb: 'send', to: 'bbbbbbbb-2222', body: 'one copy' });
  b1.pump();
  b2.pump();
  expect(b1.sent.length + b2.sent.length).toBe(1);
});

it('5: a crash after injection but before ack does not inject twice', async () => {
  const a = session('aaaaaaaa-1111', 'alpha');
  const b = session('bbbbbbbb-2222', 'beta');
  await a.start();
  await b.start();
  const { id } = JSON.parse(await a.call({ verb: 'send', to: 'beta', body: 'once' }));
  // crash window: injected (entry persisted) but claimed file never removed
  const box = b.getMail().box;
  const [mail] = box.claim();
  b.pi.sendMessage({ customType: 'pi-relay.mail.v1', content: 'x', display: true, details: {
    namespace: 'pi-relay/mail/v1', mailId: id, threadId: mail.threadId, hop: 0, from: mail.from } });
  const before = b.sent.length;
  expect(files(join(inbox('bbbbbbbb-2222'), '.claimed'))).toHaveLength(1);
  b.pump(); // restart recovery pass
  expect(b.sent.length).toBe(before);
  expect(files(join(inbox('bbbbbbbb-2222'), '.claimed'))).toEqual([]);
});

it('6: at the hop limit mail is shown but does not start a turn', async () => {
  const a = session('aaaaaaaa-1111', 'alpha');
  const b = session('bbbbbbbb-2222', 'beta');
  await a.start();
  await b.start();
  let last = JSON.parse(await a.call({ verb: 'send', to: 'beta', body: 'ping 0' }));
  const sides = [b, a];
  for (let hop = 1; hop <= MAIL_MAX_HOPS; hop++) {
    const receiver = sides[(hop - 1) % 2];
    receiver.pump();
    const got = receiver.sent.at(-1);
    expect(got.options.triggerTurn).toBe(got.message.details.hop < MAIL_MAX_HOPS);
    last = JSON.parse(await receiver.call({ verb: 'send', replyTo: last.id, body: 'ping ' + hop }));
    expect(last.hop).toBe(hop);
  }
  const final = sides[MAIL_MAX_HOPS % 2];
  final.pump();
  const got = final.sent.at(-1);
  expect(got.message.details.hop).toBe(MAIL_MAX_HOPS);
  expect(got.options.triggerTurn).toBe(false);
  expect(got.message.content).toContain('Hop limit reached');
});

it('6b: a fresh send in a mail-started turn continues the hop count; a user turn resets it', async () => {
  const a = session('aaaaaaaa-1111', 'alpha');
  const b = session('bbbbbbbb-2222', 'beta');
  await a.start();
  await b.start();
  // Ping-pong without replyTo: every send is a new thread, but the hop still climbs.
  let last = JSON.parse(await a.call({ verb: 'send', to: 'beta', body: 'ping 0' }));
  expect(last.hop).toBe(0);
  const sides = [b, a];
  for (let hop = 1; hop <= MAIL_MAX_HOPS; hop++) {
    const receiver = sides[(hop - 1) % 2];
    receiver.pump();
    const peer = hop % 2 === 1 ? 'alpha' : 'beta';
    last = JSON.parse(await receiver.call({ verb: 'send', to: peer, body: 'fresh ' + hop }));
    expect(last.hop).toBe(hop);
  }
  const final = sides[MAIL_MAX_HOPS % 2];
  final.pump();
  expect(final.sent.at(-1).options.triggerTurn).toBe(false);
  // The user speaking starts a new chain at hop 0.
  final.entries.push({ type: 'message', message: { role: 'user', content: 'start over' } });
  const fresh = JSON.parse(await final.call({ verb: 'send', to: final === a ? 'beta' : 'alpha', body: 'new' }));
  expect(fresh.hop).toBe(0);
});

it('7: ambiguous and unknown recipients are refused without writing mail', async () => {
  const a = session('aaaaaaaa-1111', 'alpha');
  const b = session('bbbbbbbb-2222', 'twin');
  const c = session('cccccccc-3333', 'twin');
  await a.start();
  await b.start();
  await c.start();
  const amb = await a.call({ verb: 'send', to: 'twin', body: 'x' });
  expect(amb).toMatch(/ambiguous/);
  expect(amb).toContain('bbbbbbbb');
  expect(amb).toContain('cccccccc');
  expect(await a.call({ verb: 'send', to: 'nobody', body: 'x' })).toMatch(/not_found/);
  expect(await a.call({ verb: 'send', to: 'alpha', body: 'x' })).toMatch(/self/);
  expect(files(inbox('bbbbbbbb-2222'))).toEqual([]);
  expect(files(inbox('cccccccc-3333'))).toEqual([]);
  // an unambiguous id prefix still works
  expect(JSON.parse(await a.call({ verb: 'send', to: 'cccccccc', body: 'x' })).to.sessionId).toBe('cccccccc-3333');
});

it('8: switching sessions in one process moves the peer registration', async () => {
  const a = session('aaaaaaaa-1111', 'alpha');
  const b = session('bbbbbbbb-2222', undefined);
  await a.start();
  await b.start();
  await b.switchTo('dddddddd-4444');
  const peers = JSON.parse(await a.call({ verb: 'peers' })).peers.map((p) => p.sessionId);
  expect(peers).toEqual(['dddddddd-4444']);
  expect(existsSync(join(home, 'mail', 'peers', 'bbbbbbbb-2222.json'))).toBe(false);
});

it('peers follow /name and prune dead processes', async () => {
  const a = session('aaaaaaaa-1111', 'alpha');
  const b = session('bbbbbbbb-2222', 'beta');
  await a.start();
  await b.start();
  writeFileSync(
    join(home, 'mail', 'peers', 'eeeeeeee-5555.json'),
    JSON.stringify({ v: 1, sessionId: 'eeeeeeee-5555', pid: 2 ** 22 + 12345, cwd: '/x', updatedAt: '' }),
  );
  b.rename('beta-renamed');
  b.pump();
  const peers = JSON.parse(await a.call({ verb: 'peers' })).peers;
  expect(peers.map((p) => p.name)).toEqual(['beta-renamed']);
  expect(existsSync(join(home, 'mail', 'peers', 'eeeeeeee-5555.json'))).toBe(false);
});

it('9: PI_RELAY_MAIL=0 registers nothing and the tool reports disabled', async () => {
  process.env.PI_RELAY_MAIL = '0';
  const a = session('aaaaaaaa-1111', 'alpha');
  await a.start();
  expect(existsSync(join(home, 'mail'))).toBe(false);
  expect(await a.call({ verb: 'peers' })).toMatch(/disabled/);
});

it('the watcher delivers without an explicit pump', async () => {
  const a = session('aaaaaaaa-1111', 'alpha');
  const b = session('bbbbbbbb-2222', 'beta');
  await a.start();
  await b.start();
  await a.call({ verb: 'send', to: 'beta', body: 'watched' });
  // fs.watch usually fires at once, but macOS FSEvents can drop or delay the
  // notification; the polling safety net must then deliver within one period.
  const deadline = Date.now() + MAIL_POLL_MS + 2000;
  while (!b.sent.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  expect(b.sent).toHaveLength(1);
});

it('Mailbox rejects oversized bodies and unsafe session ids', () => {
  expect(() => new Mailbox(home, { sessionId: '../escape', pid: process.pid, cwd: '/' })).toThrow(/invalid session id/);
  const box = new Mailbox(home, { sessionId: 'ffffffff-6666', pid: process.pid, cwd: '/' });
  expect(() => box.send({ to: 'x', body: 'y'.repeat(16385) })).toThrow(/exceeds/);
});
