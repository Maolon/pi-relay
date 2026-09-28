import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { TargetCore } from '../target/core.js';
import { canonical } from '../protocol/canonical.js';
import { cleanText, clipUtf8 } from '../protocol/format.js';
export class Presentation {
  private dirty = true;
  private disposed = false;
  private timer: NodeJS.Timeout;
  constructor(
    readonly pi: ExtensionAPI,
    readonly ctx: ExtensionContext,
    readonly core: TargetCore,
  ) {
    this.timer = setInterval(() => {
      try {
        this.flush();
      } catch {
        this.dirty = true;
      }
    }, 200);
    this.timer.unref();
  }
  changed(): void {
    this.dirty = true;
  }
  flush(): void {
    if (this.disposed || !this.dirty) return;
    this.dirty = false;
    // Presence-only widget (owner 2026-09-21): the status line says just that
    // the relay is attached to this session — 'relay: on'. Binding/hold/
    // progress detail (provisioning, recovery, foreground holds) lives in
    // /relay list and the relay_bindings tool; the widget never shouts it.
    const attached = this.core.list().some(
      (b) => b.authority === 'valid' && b.state === 'active',
    );
    if (this.ctx.mode === 'tui')
      this.ctx.ui.setWidget('pi-relay', attached ? ['relay: on'] : undefined);
    const entries = this.ctx.sessionManager.getEntries();
    for (const binding of this.core.list()) {
      const unshown = this.core.store.all<{ id: string }>(
        "SELECT id FROM events WHERE binding=? AND presentation='none' ORDER BY seq LIMIT 32",
        binding.id,
      );
      if (unshown.length === 32) this.dirty = true;
      for (const row of unshown) {
        const packet = this.core.packet(binding.id, row.id);
        const rule = binding.proposal.policy[packet.event.type];
        if (rule?.presentation === 'none') {
          this.core.markPresentation(binding.id, row.id, 'unavailable');
          continue;
        }
        const exists = entries.some(
          (e) =>
            e.type === 'custom' &&
            e.customType === 'pi-relay.card.v1' &&
            (e.data as { bindingId?: string; eventId?: string; targetFingerprint?: string })?.bindingId ===
              binding.id &&
            (e.data as { eventId?: string })?.eventId === row.id &&
            (e.data as { targetFingerprint?: string })?.targetFingerprint === this.core.options.fingerprint,
        );
        if (!exists)
          this.pi.appendEntry('pi-relay.card.v1', {
            bindingId: binding.id,
            eventId: row.id,
            targetFingerprint: this.core.options.fingerprint,
            source: binding.proposal.sourceId,
            channel: binding.proposal.channelId,
            summary: clipUtf8(cleanText(canonical(packet.event)), 2048),
          });
        this.core.markPresentation(binding.id, row.id, this.ctx.mode === 'tui' ? 'projected' : 'unavailable');
      }
    }
  }
  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    if (this.ctx.mode === 'tui') this.ctx.ui.setWidget('pi-relay', undefined);
  }
}
export function registerPresentation(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<{ source: string; channel: string; summary: string }>(
    'pi-relay.card.v1',
    (entry) => ({
      render: (width: number) => [
        clipUtf8(
          cleanText(
            `[relay ${entry.data?.source ?? 'unknown'}/${entry.data?.channel ?? 'unknown'}] ${entry.data?.summary ?? ''}`,
          ),
          Math.max(1, width),
        ),
      ],
      invalidate: () => {},
    }),
  );
}
