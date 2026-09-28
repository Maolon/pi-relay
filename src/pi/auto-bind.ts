import type { EventBus } from '../transport/in-process.js';
import type { TargetHost } from '../target/host.js';
import { readInvite } from '../client/index.js';
import { newId } from '../protocol/canonical.js';
import { safeError } from '../protocol/errors.js';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/** Inter-extension auto-bind contract v1 (handoff 2026-09-21 from pi-watcher,
 *  commit 4a9c1da). An owner pre-authorized a binding by minting a single-use
 *  invite (relay-setup); the watcher extension requests this session bind+arm
 *  itself over the pi.events bus so the wake path needs no human/tool round
 *  trip. Relay performs exactly what the model-facing relay_bindings bind does
 *  — no new authority is created: the invite is the authority, and the arm
 *  grant stays the bounded tool default (4 claims / 30 min). */
export interface BindRequestEvent {
  requestId: string;
  source: string;
  invitePath?: string;
  projectRoot?: string;
  /** Contract v2 discriminator: absent = v1 invite path; 'local' = delta-2
   *  local standing binding (sourceId + channelId instead of invitePath). */
  kind?: 'invite' | 'local';
  sourceId?: string;
  channelId?: string;
  realm?: string;
}
export interface BindResultEvent {
  requestId: string;
  ok: boolean;
  bindingId?: string;
  armed?: boolean;
  standing?: boolean;
  error?: { code: string; message: string };
}

/**
 * Registers the `pi-relay:bind-request` listener. Reply codes the requester
 * treats specially (v1): invite-consumed/already* stops it silently,
 * not_attached makes it retry on its own backoff, everything else surfaces
 * once. Errors pass the canonical relay code/message through — e.g. a channel
 * already bound elsewhere fails as binding_overlap whose canonical message
 * contains "already", which the requester's consumer regex already handles.
 */
export function registerAutoBindListener(
  bus: EventBus | undefined,
  getHost: () => TargetHost | undefined,
  getSessionFile: () => string | undefined,
): () => void {
  // One bind per invite path per listener lifetime: a retried request after a
  // successful bind must never consume a second invite or double-arm.
  const bound = new Set<string>();
  // Standing path is idempotent host-side; no invite path is consumed.
  const off = bus?.on('pi-relay:bind-request', (data) => {
    void (async () => {
      const e = data as BindRequestEvent;
      const reply = (r: BindResultEvent) => {
        try {
          bus?.emit('pi-relay:bind-result', r);
        } catch {
          /* a dead consumer does not fail the listener */
        }
      };
      if (!e || typeof e !== 'object' || typeof e.requestId !== 'string' || !e.requestId) return;
      const malformed = (message: string) =>
        reply({ requestId: e.requestId, ok: false, error: { code: 'invalid_payload', message } });
      if (typeof e.source !== 'string' || !e.source) return malformed('bind-request envelope malformed');
      const host = getHost();
      if (!host)
        return reply({
          requestId: e.requestId,
          ok: false,
          error: { code: 'not_attached', message: 'pi-relay host not attached in this session yet' },
        });
      if (!getSessionFile?.())
        return reply({
          requestId: e.requestId,
          ok: false,
          error: { code: 'no_session_file', message: 'this session has no persisted file yet' },
        });
      // Contract v2: kind 'local' takes the delta-2 standing path.
      if (e.kind === 'local') {
        if (
          typeof e.sourceId !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(e.sourceId) ||
          typeof e.channelId !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(e.channelId)
        )
          return malformed('kind local requires sourceId and channelId');
        try {
          const r = await host.bindLocal({ sourceId: e.sourceId, channelId: e.channelId });
          return reply({
            requestId: e.requestId,
            ok: true,
            bindingId: r.bindingId,
            armed: r.armed,
            standing: true,
          });
        } catch (error) {
          const d = safeError(error);
          return reply({ requestId: e.requestId, ok: false, error: { code: d.code, message: d.message } });
        }
      }
      if (typeof e.invitePath !== 'string')
        return malformed('bind-request envelope malformed');
      if (!isAbsolute(e.invitePath) || !existsSync(e.invitePath))
        return malformed('invitePath must be an existing absolute path');
      if (bound.has(e.invitePath))
        return reply({
          requestId: e.requestId,
          ok: false,
          error: { code: 'invite_consumed', message: 'this listener already bound this invite' },
        });
      try {
        const bindingId = await host.bind(readInvite(e.invitePath), {
          operationId: newId('op'),
          resume: true,
        });
        bound.add(e.invitePath);
        const binding = host.core.binding(bindingId);
        const eventTypes = Object.entries(binding.proposal.policy)
          .filter(([, rule]) => rule.model === 'resume')
          .map(([type]) => type);
        if (eventTypes.length === 0)
          return reply({ requestId: e.requestId, ok: true, bindingId, armed: false });
        host.core.control(bindingId, {
          operationId: newId('op'),
          expectedRevision: binding.revision,
          action: 'arm',
          grant: { eventTypes, maxClaims: 4, ttlMs: 30 * 60 * 1000, sessionScoped: false },
        });
        reply({ requestId: e.requestId, ok: true, bindingId, armed: true });
      } catch (error) {
        const d = safeError(error);
        reply({ requestId: e.requestId, ok: false, error: { code: d.code, message: d.message } });
      }
    })();
  });
  return () => off?.();
}
