import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readInvite } from '../client/index.js';
import type { TargetHost } from '../target/host.js';
import { newId } from '../protocol/canonical.js';
import { safeError } from '../protocol/errors.js';
import { performRespond, RESPOND_ACTIONS } from './respond.js';

/**
 * Minimal agent-facing binding surface (owner requirement 2026-09-15): one
 * tool, three verbs — deliberately NOT one-tool-per-command. The point is that
 * an agent driving a companion CLI (canvas, office helper, ...) can self-bind
 * it to the live session without learning the /relay command surface.
 *
 * - bind consumes a single-use invite file (absolute path supplied by the
 *   caller), binds with resume mode, and arms immediately with a small default
 *   grant — an un-armed bind would never wake the session, which is the whole
 *   experience the caller wants. Hold/claim/revision control flow stays on the
 *   /relay commands; the tool never touches it.
 * - unbind revokes the binding and deactivates its grants (frees the channel slot).
 * - list reports the same authoritative status the slash commands show.
 */
export function registerBindingTool(
  pi: ExtensionAPI,
  getHost: () => TargetHost | undefined,
  getHome: () => string = () => process.env.PI_RELAY_HOME ?? join(homedir(), '.pi', 'relay'),
): void {
  registerRespondTool(pi, getHost, getHome);
  pi.registerTool({
    name: 'relay_bindings',
    label: 'pi-relay bindings',
    description:
      "Manage this session's pi-relay bindings. bind attaches an external event source (e.g. a companion CLI you are about to run) to THIS session using its single-use invite file and arms it so relayed events can wake the session; unbind revokes a binding; list shows binding states.",
    promptSnippet: 'relay_bindings: bind/unbind/list pi-relay event bindings for this session.',
    promptGuidelines: [
      'When a companion CLI or skill needs to push events into this session, call relay_bindings with action "bind" and the invite file path it printed, then run the CLI.',
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal('list'), Type.Literal('bind'), Type.Literal('unbind')]),
      invitePath: Type.Optional(
        Type.String({ description: 'Absolute path to the single-use invite JSON file (required for bind)' }),
      ),
      bindingId: Type.Optional(
        Type.String({ description: 'Binding id starting with bnd- (required for unbind)' }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const host = getHost();
      const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }], details: {} });
      if (!host) return text('pi-relay is not attached in this session yet.');
      try {
        if (params.action === 'list') {
          const status = host.core.status() as {
            targetFingerprint: string;
            bindings: Array<{
              bindingId: string;
              channelId: string;
              state: string;
              holds: string[];
              pending: number;
              grants: unknown[];
            }>;
          };
          return text(
            JSON.stringify(
              {
                fingerprint: status.targetFingerprint,
                bindings: status.bindings.map((b) => ({
                  id: b.bindingId,
                  channel: b.channelId,
                  state: b.state,
                  holds: b.holds,
                  pending: b.pending,
                  armed: b.grants.length > 0,
                })),
              },
              null,
              2,
            ),
          );
        }
        if (params.action === 'bind') {
          if (!params.invitePath)
            return text('bind requires invitePath: the absolute path to the invite JSON file.');
          // A session that can run tools has necessarily persisted; the check
          // keeps the failure actionable in any future embedding.
          const file = ctx.sessionManager?.getSessionFile?.();
          if (!file) return text('This session has no persisted file yet; send one message first.');
          const bindingId = await host.bind(readInvite(params.invitePath), {
            operationId: newId('op'),
            resume: true,
          });
          const binding = host.core.binding(bindingId);
          const eventTypes = Object.entries(binding.proposal.policy)
            .filter(([, rule]) => rule.model === 'resume')
            .map(([type]) => type);
          if (eventTypes.length === 0)
            return text(
              `Bound as ${bindingId}, but the invite carries no wake-capable event types — nothing will wake this session.`,
            );
          host.core.control(bindingId, {
            operationId: newId('op'),
            expectedRevision: binding.revision,
            action: 'arm',
            grant: { eventTypes, maxClaims: 4, ttlMs: 30 * 60 * 1000, sessionScoped: false },
          });
          return text(
            `Bound as ${bindingId} and armed (4 claims, 30 min TTL). Events relayed on this binding will now wake this session.`,
          );
        }
        // unbind
        if (!params.bindingId) return text('unbind requires bindingId (see action "list").');
        const binding = host.core.binding(params.bindingId);
        host.core.control(params.bindingId, {
          operationId: newId('op'),
          expectedRevision: binding.revision,
          action: 'revoke',
        });
        return text(`Binding ${params.bindingId} revoked.`);
      } catch (error) {
        const e = safeError(error);
        return text(`relay_bindings ${params.action} failed: ${e.code} — ${e.message}`);
      }
    },
  });
}

/** Host respond surface for the model (handoff 2026-09-19): after a
 *  pi-relay managed delivery wakes the session and a decision is reached,
 *  the agent reports it back so the publisher can apply it. The model picks
 *  action + reason only; episode identity, revisions, ownership and the
 *  response type are rebuilt from durable relay state. */
function registerRespondTool(
  pi: ExtensionAPI,
  getHost: () => TargetHost | undefined,
  getHome: () => string = () => process.env.PI_RELAY_HOME ?? join(homedir(), '.pi', 'relay'),
): void {
  pi.registerTool({
    name: 'relay_respond',
    label: 'pi-relay respond',
    description:
      "Respond to a pi-relay managed delivery that woke this session (deliveryRef is in the wake message). received/investigating acknowledges the host saw it; defer postpones re-notification until a time (until required); resolved/dismiss close the episode. Sends the response through pi-relay back to the event's publisher.",
    promptSnippet:
      'relay_respond: acknowledge/defer/resolve a managed delivery that woke this session (deliveryRef from the wake message).',
    promptGuidelines: [
      'After handling a pi-relay managed delivery wake, call relay_respond with the deliveryRef from the wake message and an honest action; give a concrete reason.',
    ],
    parameters: Type.Object({
      deliveryRef: Type.String({ description: 'Delivery ref from the wake message (mdel-...)' }),
      action: Type.Union(RESPOND_ACTIONS.map((a) => Type.Literal(a))),
      reason: Type.String({ description: 'Human-readable justification for the audit trail' }),
      until: Type.Optional(
        Type.String({ description: 'ISO-8601 timestamp; required for action "defer"' }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const host = getHost();
      const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }], details: {} });
      if (!host) return text('pi-relay is not attached in this session yet.');
      try {
        const result = performRespond(host.managed, getHome(), {
          deliveryRef: params.deliveryRef,
          action: params.action,
          reason: params.reason,
          until: params.until,
        });
        return text(
          `Response ${result.responseId} (${result.responseType}, state ${result.state}${result.duplicate ? ', duplicate replay' : ''}) staged for delivery ${params.deliveryRef}.`,
        );
      } catch (error) {
        const e = safeError(error);
        return text(`relay_respond failed: ${e.code} — ${e.message}`);
      }
    },
  });
}
