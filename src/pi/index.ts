import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { readOwnerToken } from '../platform/owner-lock.js';
import { homedir } from 'node:os';
import { createTarget, type TargetHost } from '../target/host.js';
import { sessionFingerprint } from '../platform/private-paths.js';
import { newId, sha256 } from '../protocol/canonical.js';
import { invariant, safeError } from '../protocol/errors.js';
import { PiSessionPort } from './session-port.js';
import { Presentation, registerPresentation } from './presentation.js';
import { installBusEndpoint } from '../transport/in-process.js';
import { registerAutoBindListener } from './auto-bind.js';
import { registerCommands } from './commands.js';
import { registerDeclarations } from '../consumer/index.js';
import { registerBindingTool } from './tools.js';
import { registerMail } from './mail.js';
import type { FaultHook } from '../platform/clock.js';
export interface RelayExtensionOptions {
  home?: string;
  realm?: string;
  strictNoAutoResume?: boolean;
  fault?: FaultHook;
  onAttached?: (host: TargetHost, port: PiSessionPort) => void;
}
/** Registration is inert: no locks, databases, sockets, or timers until session_start. */
export function createRelayExtension(options: RelayExtensionOptions = {}): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    let host: TargetHost | undefined,
      port: PiSessionPort | undefined,
      presentation: Presentation | undefined,
      generation = 0,
      removeBus: (() => void) | undefined,
      removeAutoBind: (() => void) | undefined;
    const autoResumeStanding = (reason: 'recovery' | 'host-aborted' | 'navigation') => {
      if (!host) return;
      for (const b of host.core.list()) {
        if (b.standing === true && host.core.holds(b.id).includes(reason)) {
          try {
            host.core.control(b.id, {
              operationId: newId('op'),
              expectedRevision: host.core.binding(b.id).revision,
              action: 'resume',
              holdReason: reason,
              ...(reason === 'navigation' ? { approveCurrentBranch: true } : {}),
            });
          } catch {
            /* owner surface remains available: /events resume <id> --reason <reason> */
          }
        }
      }
    };

    const changed = () => {
      presentation?.changed();
      port?.schedule();
    };
    const dispose = async () => {
      generation++;
      removeBus?.();
      removeBus = undefined;
      removeAutoBind?.();
      removeAutoBind = undefined;
      port?.dispose();
      port = undefined;
      presentation?.dispose();
      presentation = undefined;
      const previous = host;
      host = undefined;
      await previous?.close();
    };
    registerPresentation(pi);
    const getMail = registerMail(pi, () =>
      (options.home ?? process.env.PI_RELAY_HOME ?? join(homedir(), '.pi', 'relay')));
    registerCommands(pi, () => host, changed, () =>
      (options.home ?? process.env.PI_RELAY_HOME ?? join(homedir(), '.pi', 'relay')), getMail);
    registerBindingTool(pi, () => host, () =>
      (options.home ?? process.env.PI_RELAY_HOME ?? join(homedir(), '.pi', 'relay')));
    pi.registerFlag('relay-strict-no-auto-resume', {
      description:
        'Disable automatic relay resume, including while unobservable third-party UI might be waiting',
      type: 'boolean',
      default: false,
    });
    pi.on('session_start', async (_event, ctx) => {
      await dispose();
      const current = generation;
      let fingerprint2 = '';
      try {
        const { VERSION } = await import('@earendil-works/pi-coding-agent');
        // 下界检查而非精确钉死：精确钉会在每次 pi 升级时把 relay extension 打成 inert
        // （2026-09-21 实测：0.85.1 钉 × pi 0.86.1 → session_start 必抛 unsupported_version）。
        // API 若真的破坏性变更，后续步骤会可见地报错，而不是静默 inert。
        const [vmaj, vmin] = VERSION.split('.').map(Number);
        invariant(vmaj === 0 && vmin >= 85, 'unsupported_version');
        const realm = options.realm ?? 'local',
          home = options.home ?? process.env.PI_RELAY_HOME ?? join(homedir(), '.pi', 'relay');
        const fingerprint = sessionFingerprint(
          realm,
          ctx.sessionManager.getSessionId(),
          ctx.sessionManager.getSessionFile(),
          newId('ephemeral'),
        );
        fingerprint2 = fingerprint;
        const next = await createTarget({
          home,
          realm,
          fingerprint,
          fault: options.fault,
          onChange: changed,
          onProgress: () => presentation?.changed(),
          onSuperseded: () => {
            // Bound to this host: a stale supervisor callback must never
            // dispose a newer attachment created by a session switch.
            if (host !== next) return;
            void dispose().then(() => {
              try {
                ctx.ui.notify(
                  'pi-relay: a newer session took over this session\u2019s relay ownership; relay detached here',
                  'info',
                );
              } catch {}
            });
          },
        });
        if (current !== generation) {
          await next.close();
          return;
        }
        host = next;
        removeBus = installBusEndpoint(pi.events, 'pi-relay:' + fingerprint, () => next.handler());
        removeAutoBind = registerAutoBindListener(pi.events, () => host, () =>
          ctx.sessionManager?.getSessionFile?.());
        const strictNoAutoResume =
          options.strictNoAutoResume ?? pi.getFlag('relay-strict-no-auto-resume') === true;
        const safetyNetMs =
          process.env.PI_RELAY_SAFETY_NET_MS !== undefined
            ? Number(process.env.PI_RELAY_SAFETY_NET_MS)
            : 30_000;
        port = new PiSessionPort(
          pi,
          ctx,
          host.core,
          strictNoAutoResume,
          {
            target: host.managed,
            proof: (bindingId, eventIds) => next.managedScopeProof(bindingId, eventIds),
          },
          safetyNetMs,
        );
        presentation = new Presentation(pi, ctx, host.core);
        // Declarative consumer registration (stage 4): any plugin, CLI or
        // human drops a file into <home>/consumers/ — scan and register each
        // declaration before the first pump pass can run.
        const scan = registerDeclarations(next.managed, home);
        if (scan.failed.length)
          try {
            ctx.ui.notify(
              `pi-relay: ${scan.failed.length} consumer declaration(s) failed to register — see /relay consumer list`,
              'error',
            );
          } catch {}
        // TEST-ONLY smoke consumer (no watcher attached): an always-allow guard
        // so managed deliveries can be exercised against a real Pi session.
        // Real consumers register via the ./consumer SDK surface (stage 4).
        if (process.env.PI_RELAY_MANAGED_SMOKE === '1') {
          next.managed.registerConsumer(
            {
              profileId: 'smoke',
              eventManifestDigest: sha256('smoke-events'),
              responseManifestDigest: sha256('smoke-responses'),
              guardImplementationId: 'smoke-guard-v1',
              timeoutMs: 2000,
              requireCurrentScope: false,
            },
            async () => ({
              decision: 'allow',
              reasonCode: 'CURRENT',
              guardEpoch: 1,
              validUntil: new Date(Date.now() + 5000).toISOString(),
            }),
          );
        }
        for (const b of host.core.list()) host.import(b.id);
        await port.observe();
        // Restart recovery (2026-09-21) + Navigation recovery: createTarget holds every
        // binding with 'recovery' until the host is confirmed alive. For STANDING bindings
        // (machine-local trust, session-scoped — e.g. pi-watcher's wake channel)
        // a successful observe of THIS live session IS the confirmation: auto-clear
        // recovery and navigation holds so they deliver after a restart or session switch
        // without a manual /events resume. Invite/branch bindings keep the conservative
        // manual recovery ceremony; strict-no-auto-resume keeps the hold for standing bindings too.
        if (!strictNoAutoResume) {
          autoResumeStanding('recovery');
          autoResumeStanding('navigation');
        }
        options.onAttached?.(host, port);
        changed();
      } catch (error) {
        const detail = safeError(error);
        if (detail.code === 'owner_conflict') {
          // Actionable takeover timeout: name the incumbent process.
          const home2 = options.home ?? process.env.PI_RELAY_HOME ?? join(homedir(), '.pi', 'relay');
          const incumbent = readOwnerToken(join(home2, 'targets', fingerprint2));
          const alive = incumbent ? (() => { try { process.kill(incumbent.pid, 0); return true; } catch { return false; } })() : false;
          ctx.ui.notify(
            `pi-relay: ${detail.message}` +
              (incumbent
                ? ` (pid ${incumbent.pid}, ${alive ? 'still running' : 'not responding'})`
                : ' (holder unknown)'),
            'error',
          );
        } else {
          ctx.ui.notify(`pi-relay: ${detail.message}`, 'error');
        }
        await dispose();
      }
    });
    pi.on('session_shutdown', dispose);
    const navigation = () => {
      host?.core.holdAll('navigation');
    };
    pi.on('session_before_switch', navigation);
    pi.on('session_before_fork', navigation);
    pi.on('session_before_tree', navigation);
    pi.on('input', (event) => {
      if (event.source !== 'extension') {
        host?.core.foregroundInput();
        autoResumeStanding('navigation');
      }
    });
    pi.on('session_tree', () => {
      autoResumeStanding('navigation');
      port?.schedule();
    });
    pi.on('agent_start', () => {
      if (port) port.settled = false;
    });
    pi.on('agent_end', (event) => {
      const wasAborted = event.messages.some((m) => m.role === 'assistant' && m.stopReason === 'aborted');
      if (wasAborted) {
        host?.core.holdAll('host-aborted');
      } else if (host) {
        // Normal completion clears prior host-aborted and navigation holds for standing bindings
        autoResumeStanding('host-aborted');
        autoResumeStanding('navigation');
      }
      port?.schedule();
    });
    pi.on('agent_settled', () => {
      if (port) port.settled = true;
      autoResumeStanding('navigation');
      changed();
    });
    pi.on('ui_prompt_start', () => {
      if (port) port.knownWaits++;
    });
    pi.on('ui_prompt_end', () => {
      if (port) port.knownWaits = Math.max(0, port.knownWaits - 1);
      changed();
    });
    pi.on('session_before_compact', () => {
      if (port) port.settled = false;
    });
    pi.on('session_compact', () => {
      if (port) port.settled = true;
      port?.schedule();
      changed();
    });
    pi.on('session_compact_failed', () => {
      if (port) port.settled = true;
      host?.core.holdAll('host-aborted');
      changed();
    });
    pi.on('message_end', () => {
      port?.schedule();
    });
  };
}
export default createRelayExtension();
