/** Session mail (delta-3): lightweight point-to-point messages between Pi
 *  sessions on one machine. Deliberately NOT the relay event bridge — no
 *  source, binding, grant, SQLite or daemon. The 0700 relay home is the trust
 *  boundary (delta-2 §1), so there is no signing or authorization either:
 *
 *    <home>/mail/peers/<sessionId>.json          one file per live session
 *    <home>/mail/inbox/<sessionId>/<id>.json     one file per undelivered mail
 *    <home>/mail/inbox/<sessionId>/.claimed/     mail being injected
 *    <home>/mail/tmp/                            staging for atomic rename
 *
 *  Every write is tmp + rename, so readers never see partial files and no
 *  locks are needed. Claiming is a rename into .claimed/: exactly one reader
 *  wins even when the same session is open twice. This module has no Pi
 *  dependency; src/pi/mail.ts wires it into the extension. */
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs';
import { join } from 'node:path';
import { newId } from '../protocol/canonical.js';
import { privateDir } from '../platform/private-paths.js';

export const MAIL_MAX_HOPS = 6;
export const MAIL_MAX_BODY_BYTES = 16384;
export const MAIL_POLL_MS = 5000;

export interface MailPeer {
  v: 1;
  sessionId: string;
  name?: string;
  pid: number;
  cwd: string;
  herdrPane?: string;
  updatedAt: string;
}

export interface Mail {
  v: 1;
  id: string;
  from: { sessionId: string; name?: string };
  to: string;
  body: string;
  replyTo?: string;
  threadId: string;
  hop: number;
  sentAt: string;
}

/** What the receiving side remembers about a delivered mail (enough to reply). */
export interface MailOrigin {
  threadId: string;
  hop: number;
  from: { sessionId: string; name?: string };
}

export type MailErrorCode =
  | 'disabled'
  | 'not_found'
  | 'ambiguous'
  | 'self'
  | 'invalid_payload'
  | 'unknown_reply';

export class MailError extends Error {
  constructor(
    readonly code: MailErrorCode,
    message: string,
    readonly candidates?: string[],
  ) {
    super(message);
    this.name = 'MailError';
  }
}

const SESSION_ID = /^[A-Za-z0-9._-]{1,200}$/;
const MAIL_ID = /^mail-[0-9a-f]{32}$/;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Short human label for a peer: its session name, else the session id prefix. */
export function peerLabel(peer: { sessionId: string; name?: string }): string {
  return peer.name || peer.sessionId.slice(0, 8);
}

export class Mailbox {
  readonly root: string;
  private readonly peersDir: string;
  private readonly tmpDir: string;
  private readonly inboxDir: string;
  private readonly claimedDir: string;
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    home: string,
    private self: Omit<MailPeer, 'v' | 'updatedAt'>,
  ) {
    if (!SESSION_ID.test(self.sessionId)) throw new MailError('invalid_payload', 'invalid session id');
    this.root = privateDir(join(home, 'mail'));
    this.peersDir = privateDir(join(this.root, 'peers'));
    this.tmpDir = privateDir(join(this.root, 'tmp'));
    this.inboxDir = privateDir(join(this.root, 'inbox', self.sessionId));
    this.claimedDir = privateDir(join(this.inboxDir, '.claimed'));
  }

  get sessionId(): string {
    return this.self.sessionId;
  }

  private writeAtomic(dest: string, value: unknown): void {
    const tmp = join(this.tmpDir, newId('tmp') + '.json');
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, dest);
  }

  /** Publish (or refresh) this session's peer file. */
  register(update: Partial<Pick<MailPeer, 'name'>> = {}): void {
    this.self = { ...this.self, ...update };
    const peer: MailPeer = { v: 1, ...this.self, updatedAt: new Date().toISOString() };
    if (!peer.name) delete peer.name;
    if (!peer.herdrPane) delete peer.herdrPane;
    this.writeAtomic(join(this.peersDir, this.self.sessionId + '.json'), peer);
  }

  get name(): string | undefined {
    return this.self.name;
  }

  /** Remove this session's peer file. The inbox stays: mail waits for a resume. */
  unregister(): void {
    const file = join(this.peersDir, this.self.sessionId + '.json');
    // Only remove our own registration; a newer process for the same session may own it now.
    const current = readJson<MailPeer>(file);
    if (current && current.pid !== this.self.pid) return;
    rmSync(file, { force: true });
  }

  /** Live peers other than this session. Dead peer files are pruned on the way. */
  peers(): MailPeer[] {
    const result: MailPeer[] = [];
    for (const f of readdirSync(this.peersDir)) {
      if (!f.endsWith('.json')) continue;
      const file = join(this.peersDir, f);
      const peer = readJson<MailPeer>(file);
      if (!peer || peer.v !== 1 || typeof peer.pid !== 'number') continue;
      if (!alive(peer.pid)) {
        rmSync(file, { force: true });
        continue;
      }
      if (peer.sessionId === this.self.sessionId) continue;
      result.push(peer);
    }
    return result.sort((a, b) => peerLabel(a).localeCompare(peerLabel(b)));
  }

  /** Exact match only, in order: session name, herdr pane, session id (full or >= 8-char prefix). */
  resolve(to: string): MailPeer {
    const target = to.trim();
    if (!target) throw new MailError('invalid_payload', 'recipient is required');
    if (target === this.self.sessionId || (this.self.name && target === this.self.name))
      throw new MailError('self', 'cannot send mail to this session itself');
    const peers = this.peers();
    const tiers: Array<(p: MailPeer) => boolean> = [
      (p) => p.name === target,
      (p) => p.herdrPane === target,
      (p) => p.sessionId === target || (target.length >= 8 && p.sessionId.startsWith(target)),
    ];
    for (const match of tiers) {
      const hits = peers.filter(match);
      if (hits.length === 1) return hits[0]!;
      if (hits.length > 1)
        throw new MailError(
          'ambiguous',
          `"${target}" matches ${hits.length} sessions`,
          hits.map((p) => `${peerLabel(p)} (${p.sessionId.slice(0, 8)}, ${p.cwd})`),
        );
    }
    throw new MailError(
      'not_found',
      `no live session named "${target}"`,
      peers.map((p) => peerLabel(p)),
    );
  }

  /** Queue a mail in the recipient's inbox. `origin` is the mail being replied to;
   *  `causedBy` is the mail that started the current turn (new thread, hop continues). */
  send(
    input: { to?: string; body: string; replyTo?: string },
    origin?: MailOrigin,
    causedBy?: MailOrigin,
  ): { mail: Mail; recipient: MailPeer } {
    if (typeof input.body !== 'string' || !input.body.trim())
      throw new MailError('invalid_payload', 'body is required');
    if (Buffer.byteLength(input.body) > MAIL_MAX_BODY_BYTES)
      throw new MailError('invalid_payload', `body exceeds ${MAIL_MAX_BODY_BYTES} bytes`);
    if (input.replyTo && !origin)
      throw new MailError('unknown_reply', `mail ${input.replyTo} was not delivered to this session`);
    const to = input.to ?? origin?.from.sessionId;
    if (!to) throw new MailError('invalid_payload', 'recipient is required');
    const recipient = this.resolve(to);
    const id = newId('mail');
    const mail: Mail = {
      v: 1,
      id,
      from: { sessionId: this.self.sessionId, ...(this.self.name ? { name: this.self.name } : {}) },
      to: recipient.sessionId,
      body: input.body,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      threadId: origin?.threadId ?? id,
      hop: origin ? origin.hop + 1 : causedBy ? causedBy.hop + 1 : 0,
      sentAt: new Date().toISOString(),
    };
    const inbox = privateDir(join(this.root, 'inbox', recipient.sessionId));
    this.writeAtomic(join(inbox, id + '.json'), mail);
    return { mail, recipient };
  }

  /** Claim every pending mail: leftovers in .claimed/ (crash recovery) first,
   *  then new inbox files. A lost rename race means another reader owns it. */
  claim(): Mail[] {
    const result: Mail[] = [];
    const take = (file: string) => {
      const mail = readJson<Mail>(file);
      if (mail && mail.v === 1 && MAIL_ID.test(mail.id) && typeof mail.body === 'string') result.push(mail);
      else rmSync(file, { force: true });
    };
    for (const f of readdirSync(this.claimedDir)) if (f.endsWith('.json')) take(join(this.claimedDir, f));
    for (const f of readdirSync(this.inboxDir)) {
      if (!f.endsWith('.json')) continue;
      const claimed = join(this.claimedDir, f);
      try {
        renameSync(join(this.inboxDir, f), claimed);
      } catch {
        continue;
      }
      take(claimed);
    }
    return result.sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  }

  /** Drop a claimed mail once it has been handed to the session. */
  ack(id: string): void {
    if (!MAIL_ID.test(id)) return;
    try {
      unlinkSync(join(this.claimedDir, id + '.json'));
    } catch {}
  }

  /** Call `onChange` when the inbox may have new mail: fs.watch plus a polling safety net. */
  watch(onChange: () => void, pollMs = MAIL_POLL_MS): void {
    this.unwatch();
    try {
      this.watcher = watch(this.inboxDir, () => onChange());
      this.watcher.on('error', () => this.watcher?.close());
    } catch {
      this.watcher = undefined;
    }
    this.timer = setInterval(onChange, pollMs);
    this.timer.unref();
  }

  unwatch(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  pending(): number {
    return existsSync(this.inboxDir) ? readdirSync(this.inboxDir).filter((f) => f.endsWith('.json')).length : 0;
  }
}
