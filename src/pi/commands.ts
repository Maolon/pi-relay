import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { canonical, newId } from '../protocol/canonical.js';
import { cleanText } from '../protocol/format.js';
import { invariant, safeError } from '../protocol/errors.js';
import { readInvite } from '../client/index.js';
import type { OwnerCommand } from '../protocol/types.js';
import type { TargetHost } from '../target/host.js';
import {
  parseConsumerDeclaration,
  writeConsumerDeclaration,
  removeConsumerDeclaration,
  listConsumerDeclarations,
  registerDeclarations,
  declarationProfile as declarationProfileOf,
  declarationGuard as declarationGuardOf,
} from '../consumer/index.js';
import { performRespond } from './respond.js';
import { mailCommand, type SessionMail } from './mail.js';
export function words(text: string): string[] {
  const result: string[] = [];
  const re = /"(?:\\.|[^"\\])*"|'[^']*'|[^\s"']+/g;
  let end = 0;
  for (const match of text.matchAll(re)) {
    invariant(text.slice(end, match.index).trim() === '');
    const token = match[0];
    result.push(
      token.startsWith('"') ? JSON.parse(token) : token.startsWith("'") ? token.slice(1, -1) : token,
    );
    end = (match.index ?? 0) + token.length;
  }
  invariant(text.slice(end).trim() === '');
  return result;
}
export function registerCommands(
  pi: ExtensionAPI,
  getHost: () => TargetHost | undefined,
  changed: () => void,
  getHome: () => string = () => process.env.PI_RELAY_HOME ?? join(homedir(), '.pi', 'relay'),
  getMail: () => SessionMail | undefined = () => undefined,
): void {
  const command = async (args: string, ctx: ExtensionCommandContext) => {
    try {
      const input = words(args),
        verb = input.shift() ?? 'list';
      if (verb === 'mail') {
        // Session mail (delta-3) is independent of relay attachment.
        try {
          const text = JSON.stringify(mailCommand(getMail(), input), null, 2);
          if (ctx.hasUI) ctx.ui.notify(cleanText(text), 'info');
          else pi.appendEntry('pi-relay.owner-result.v1', { result: JSON.parse(text) });
        } catch (error) {
          const e = error as { code?: string; message?: string };
          ctx.ui.notify(`${e.code ?? 'error'}: ${e.message ?? String(error)}`, 'error');
        }
        return;
      }
      const host = getHost();
      invariant(host, 'target_offline');
      const { values, positionals } = parseArgs({
        args: input,
        allowPositionals: true,
        strict: true,
        options: {
          resume: { type: 'boolean' },
          'session-scoped': { type: 'boolean' },
          'operation-id': { type: 'string' },
          reason: { type: 'string' },
          'approve-current-branch': { type: 'boolean' },
          'skip-replay': { type: 'boolean' },
          'allow-unpersisted': { type: 'boolean' },
          types: { type: 'string' },
          claims: { type: 'string' },
          'ttl-ms': { type: 'string' },
          force: { type: 'boolean' },
          limit: { type: 'string' },
          state: { type: 'string' },
          until: { type: 'string' },
        },
      });
      let result: unknown;
      if (verb === 'consumer') {
        // Declarative consumer registration (stage 4): the file surface any
        // plugin/CLI can use. Registration happens in this trusted process;
        // nothing here exposes tokens to the model.
        const managed = host.managed;
        const sub = positionals.shift() ?? 'list';
        if (sub === 'list')
          result = { registrations: managed.listConsumers(), declarations: listConsumerDeclarations(getHome()) };
        else if (sub === 'show') {
          const id = positionals[0];
          invariant(id, 'invalid_payload');
          result = {
            registration: managed.listConsumers().find((r) => r.profileId === id) ?? null,
            deliveries: managed.managedDeliveries({ profileId: id, limit: Number(values.limit ?? 20) }),
          };
        } else if (sub === 'register') {
          const path = positionals[0];
          invariant(path, 'invalid_payload');
          const decl = parseConsumerDeclaration(JSON.parse(readFileSync(path, 'utf8')));
          const { file } = writeConsumerDeclaration(getHome(), decl, { force: values.force });
          const { epoch } = managed.registerConsumer(
            declarationProfileOf(decl),
            declarationGuardOf(decl),
          );
          result = { file, profileId: decl.profileId, epoch };
        } else if (sub === 'revoke') {
          const id = positionals[0];
          invariant(id, 'invalid_payload');
          // Remove the declaration too, or the next scan would resurrect it.
          const fileRemoved = removeConsumerDeclaration(getHome(), id);
          result = { ...managed.revokeConsumer(id), declarationFileRemoved: fileRemoved };
        } else if (sub === 'rescan') {
          result = registerDeclarations(managed, getHome());
        } else invariant(false, 'unsupported_feature');
      } else if (verb === 'respond') {
        // Host respond (handoff 2026-09-19): owner surface for the wake →
        // respond → applied loop. Identity fields are rebuilt from the
        // stored attention envelope, never from this command's input.
        result = performRespond(host.managed, getHome(), {
          deliveryRef: positionals[0],
          action: positionals[1] ?? '',
          reason: values.reason,
          until: values.until,
          operationId: values['operation-id'],
        });
      } else if (verb === 'deliveries') {
        result = host.managed.managedDeliveries({
          state: values.state,
          limit: Number(values.limit ?? 20),
        });
      } else if (verb === 'list' || verb === 'status') result = host.core.status();
      else if (verb === 'bind') {
        invariant(positionals.length === 1);
        // An unpersisted session (no model turn yet; slash commands write no entries)
        // has no stable identity to return to after a restart — its binding would be
        // unreachable though it still occupies a channel slot and a wake reservation.
        // Refuse unless explicitly overridden (fix-wake-budget-v0.2.1 T07).
        if (!values['allow-unpersisted']) {
          let file: string | undefined;
          try {
            file = ctx.sessionManager?.getSessionFile?.();
          } catch {
            file = undefined;
          }
          const persisted = !!file && existsSync(file);
          if (!persisted) {
            ctx.ui.notify(
              `pi-relay: this session has no persisted file yet — send one message first, or repeat with --allow-unpersisted (a binding made now would be unreachable after a restart). [session file reported: ${file ?? 'none'}]`,
              'info',
            );
            invariant(persisted, 'invalid_state');
          }
        }
        result = {
          bindingId: await host.bind(readInvite(positionals[0]), {
            operationId: values['operation-id'],
            resume: values.resume,
            affinity: values['session-scoped'] ? 'session' : 'branch',
            originAnchor: ctx.sessionManager.getLeafId(),
          }),
        };
      } else {
        const id = positionals[0];
        invariant(id);
        const binding = host.core.binding(id);
        if (verb === 'inspect')
          result = positionals[1]
            ? host.core.receipt(id, positionals[1])
            : { ...binding, handleFile: undefined, holds: host.core.holds(id) };
        else if (verb === 'import') result = host.import(id);
        else {
          const allowed = ['pause', 'resume', 'arm', 'disarm', 'seal', 'revoke', 'resolve-unknown'];
          invariant(allowed.includes(verb), 'unsupported_feature');
          const request: OwnerCommand = {
            operationId: values['operation-id'] ?? newId('op'),
            expectedRevision: binding.revision,
            action: verb as OwnerCommand['action'],
          };
          if (verb === 'resume') {
            request.holdReason = (values.reason ?? 'manual') as OwnerCommand['holdReason'];
            request.approveCurrentBranch = values['approve-current-branch'] ?? false;
          }
          if (verb === 'arm')
            request.grant = {
              eventTypes: values.types
                ? values.types.split(',')
                : Object.entries(binding.proposal.policy)
                    .filter(([, r]) => r.model === 'resume')
                    .map(([type]) => type),
              maxClaims: Number(values.claims ?? 1),
              ttlMs: Number(values['ttl-ms'] ?? 1800000),
              sessionScoped: values['session-scoped'] ?? false,
            };
          if (verb === 'resolve-unknown') {
            invariant(values['skip-replay'] && positionals[1]);
            request.deliveryId = positionals[1];
            request.resolution = 'skip-replay-and-unblock';
          }
          result = host.core.control(id, request);
        }
      }
      const text = JSON.stringify(result, null, 2);
      if (ctx.hasUI) ctx.ui.notify(cleanText(text), 'info');
      else pi.appendEntry('pi-relay.owner-result.v1', { result });
      changed();
    } catch (error) {
      const detail = safeError(error);
      ctx.ui.notify(`${detail.code}: ${detail.message}`, 'error');
    }
  };
  pi.registerCommand('events', {
    description: 'Relay owner controls. Default display; resume and arm are separate operations.',
    handler: command,
  });
  pi.registerCommand('relay', { description: 'Alias of /events', handler: command });
  pi.registerTool({
    name: 'events_status',
    label: 'Relay status',
    description:
      'Read-only relay status. Does not bind, arm, control, expose credentials, or read other sessions.',
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      const host = getHost();
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(host?.core.status() ?? { state: 'offline' }) },
        ],
        details: { readOnly: true },
      };
    },
  });
}
