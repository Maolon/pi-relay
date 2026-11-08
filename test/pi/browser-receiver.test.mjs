import { it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Mailbox } from '../../dist/mail/index.js';
import { SessionMail } from '../../dist/pi/mail.js';

// AP Browser Connect receiver protocol: a saved browser binding becomes ready
// only while this exact SessionMail activation publishes a fresh lease. Browser
// mail is acknowledged only after the session has durably recorded its dedupe
// entry; rejected and expired deliveries never reach the model.

const SESSION_ID = 'session-a';
const roots = [];
const receivers = [];

afterEach(() => {
  for (const receiver of receivers.splice(0).reverse()) receiver.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(home, { failOnceAfterPersist = false } = {}) {
  const entries = [];
  const sent = [];
  let fail = failOnceAfterPersist;
  const pi = {
    getSessionName: () => 'browser-receiver-test',
    sendMessage: (message, options) => {
      sent.push({ message, options });
      entries.push({ type: 'custom_message', ...message });
      if (fail) {
        fail = false;
        throw new Error('simulated crash after durable session entry');
      }
    },
  };
  const ctx = { sessionManager: { getEntries: () => entries } };
  const box = new Mailbox(home, { sessionId: SESSION_ID, pid: process.pid, cwd: '/work' });
  const mail = new SessionMail(pi, ctx, box);
  receivers.push(mail);
  return { mail, box, entries, sent };
}

function root() {
  const home = mkdtempSync(join(tmpdir(), 'pi-relay-browser-receiver-'));
  roots.push(home);
  return home;
}

const inbox = (home) => join(home, 'mail', 'inbox', SESSION_ID);
const control = (home) => join(inbox(home), '.ap-browser');
const leasePath = (home) => join(control(home), 'receiver.json');
const receiptPath = (home, id) => join(control(home), 'receipts', id + '.json');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const lease = (home) => readJson(leasePath(home));

function putBrowserMail(home, currentLease, id, overrides = {}) {
  const mail = {
    v: 1,
    id,
    from: { sessionId: 'ap-browser-test', name: 'Chrome' },
    to: SESSION_ID,
    body: 'Explain the selected element.',
    threadId: id,
    hop: 0,
    sentAt: new Date().toISOString(),
    ap_browser: {
      action: 'ask',
      receiver_epoch: currentLease.receiver_epoch,
      expires_at: Date.now() + 10_000,
    },
    ...overrides,
  };
  writeFileSync(join(inbox(home), id + '.json'), JSON.stringify(mail));
  return mail;
}

it('publishes a fresh ready lease, rotates epochs, and publishes offline on stop', () => {
  const home = root();
  const first = fixture(home);
  first.mail.start();
  const active = lease(home);
  expect(active).toMatchObject({
    v: 1,
    session_id: SESSION_ID,
    pid: process.pid,
    state: 'ready',
  });
  expect(active.receiver_epoch).toMatch(/^[A-Za-z0-9-]+$/);
  expect(active.expires_at - active.issued_at).toBe(20_000);
  expect(active.expires_at).toBeGreaterThan(Date.now());

  first.mail.stop();
  expect(lease(home)).toMatchObject({ state: 'offline', receiver_epoch: active.receiver_epoch });

  const second = fixture(home);
  second.mail.start();
  expect(lease(home)).toMatchObject({ state: 'ready' });
  expect(lease(home).receiver_epoch).not.toBe(active.receiver_epoch);
});

it('renews the same epoch before the lease expires', () => {
  vi.useFakeTimers();
  const home = root();
  const receiver = fixture(home);
  try {
    receiver.mail.start();
    const initial = lease(home);
    vi.advanceTimersByTime(5000);
    const renewed = lease(home);
    expect(renewed.receiver_epoch).toBe(initial.receiver_epoch);
    expect(renewed.issued_at).toBeGreaterThan(initial.issued_at);
    expect(renewed.expires_at).toBeGreaterThan(initial.expires_at);
  } finally {
    receiver.mail.stop();
    vi.useRealTimers();
  }
});

it('an old receiver cannot overwrite a newer receiver lease', () => {
  const home = root();
  const first = fixture(home);
  const second = fixture(home);
  first.mail.start();
  second.mail.start();
  const current = lease(home);
  first.mail.stop();
  expect(lease(home)).toMatchObject({ state: 'ready', receiver_epoch: current.receiver_epoch });
});

it('accepts valid browser mail with an explicit receipt and deduplicates replay', () => {
  const home = root();
  const receiver = fixture(home);
  receiver.mail.start();
  const current = lease(home);
  const id = 'mail-' + 'a'.repeat(32);
  const mail = putBrowserMail(home, current, id);
  // A crash leftover and a new drop can share one ID in the same claim batch.
  // The first injection must update the batch-local dedupe view immediately.
  writeFileSync(join(inbox(home), '.claimed', id + '.json'), JSON.stringify(mail));

  receiver.mail.pump();
  expect(receiver.sent).toHaveLength(1);
  expect(readJson(receiptPath(home, id))).toMatchObject({
    v: 1,
    event_id: id,
    session_id: SESSION_ID,
    receiver_epoch: current.receiver_epoch,
    status: 'accepted',
  });

  // Even if the claimed file survives or the same drop is replayed, the durable
  // custom_message entry prevents a second model injection.
  writeFileSync(join(inbox(home), id + '.json'), JSON.stringify(mail));
  receiver.mail.pump();
  expect(receiver.sent).toHaveLength(1);
  expect(readJson(receiptPath(home, id)).status).toBe('accepted');
});

it('recovers the crash window after session persistence without duplicate injection', () => {
  const home = root();
  const receiver = fixture(home, { failOnceAfterPersist: true });
  receiver.mail.start();
  const current = lease(home);
  const id = 'mail-' + 'b'.repeat(32);
  putBrowserMail(home, current, id);

  receiver.mail.pump();
  expect(receiver.sent).toHaveLength(1);
  expect(receiver.entries).toHaveLength(1);
  expect(() => readJson(receiptPath(home, id))).toThrow();

  receiver.mail.pump();
  expect(receiver.sent).toHaveLength(1);
  expect(readJson(receiptPath(home, id)).status).toBe('accepted');
});

it('rejects stale targets and expires old deadlines without model injection', () => {
  const home = root();
  const receiver = fixture(home);
  receiver.mail.start();
  const current = lease(home);
  const wrongTo = 'mail-' + 'c'.repeat(32);
  const wrongEpoch = 'mail-' + 'd'.repeat(32);
  const expired = 'mail-' + 'e'.repeat(32);
  putBrowserMail(home, current, wrongTo, { to: 'another-session' });
  putBrowserMail(home, current, wrongEpoch, {
    ap_browser: { receiver_epoch: 'stale-epoch', expires_at: Date.now() + 10_000 },
  });
  putBrowserMail(home, current, expired, {
    ap_browser: { receiver_epoch: current.receiver_epoch, expires_at: Date.now() - 1 },
  });

  receiver.mail.pump();
  expect(receiver.sent).toHaveLength(0);
  // Negative receipts echo the intended route so the sending host can match
  // them with the same session_id/receiver_epoch checks as accepted receipts.
  expect(readJson(receiptPath(home, wrongTo))).toMatchObject({
    status: 'rejected',
    session_id: 'another-session',
    receiver_epoch: current.receiver_epoch,
  });
  expect(readJson(receiptPath(home, wrongEpoch))).toMatchObject({
    status: 'rejected',
    session_id: SESSION_ID,
    receiver_epoch: 'stale-epoch',
  });
  expect(readJson(receiptPath(home, expired))).toMatchObject({
    status: 'expired',
    session_id: SESSION_ID,
    receiver_epoch: current.receiver_epoch,
  });
});
