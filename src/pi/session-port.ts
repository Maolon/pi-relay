import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { TargetCore, Attempt, Eligibility } from '../target/core.js';
import type { ManagedTarget } from '../target/managed.js';
import type { ScopeProof } from '../protocol/internal-types.js';
import { deliveryContent } from '../protocol/format.js';
import { safeError } from '../protocol/errors.js';
import { observeFile } from './observer.js';
import { managedDeliveryDetails } from './respond.js';
export interface ManagedPumpPort {
  target: ManagedTarget;
  proof: (bindingId: string, eventIds: string[]) => Promise<ScopeProof | undefined>;
}
export class PiSessionPort {
  private disposed = false;
  private running = false;
  private rerunRequested = false;
  private scheduled?: NodeJS.Immediate;
  private timeout?: NodeJS.Timeout;
  private safetyTimer?: NodeJS.Timeout;
  knownWaits = 0;
  settled = true;
  constructor(
    readonly pi: ExtensionAPI,
    readonly ctx: ExtensionContext,
    readonly core: TargetCore,
    readonly strictNoAutoResume = false,
    readonly managed?: ManagedPumpPort,
    safetyNetMs = 30_000,
  ) {
    if (safetyNetMs > 0) {
      this.safetyTimer = setInterval(() => {
        if (this.disposed) return;
        this.schedule();
      }, safetyNetMs);
      this.safetyTimer.unref();
    }
  }
  eligibility(): Eligibility {
    return {
      idle: this.settled && this.ctx.isIdle(),
      pending: this.ctx.hasPendingMessages(),
      knownWait: this.knownWaits > 0,
      strictNoAutoResume: this.strictNoAutoResume,
    };
  }
  schedule(): void {
    if (this.disposed) return;
    // Entry/settled notifications can arrive while observeFile is awaiting I/O.
    // Preserve one drain rather than dropping its immediate while pump is running.
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    if (this.scheduled) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      void this.pump().catch((error) => {
        // Ownership loss is terminal for this local attachment: do not try to
        // record holds (that write is fenced too). The supervisor closes us.
        const code = safeError(error).code;
        if (code === 'owner_superseded' || this.disposed) return;
        try {
          this.core.holdAll('host-aborted');
        } catch {
          // A fenced holdAll means we lost ownership during error handling;
          // the supervisor owns shutdown from here.
        }
      });
    });
  }
  async observe(): Promise<void> {
    if (this.disposed) return;
    for (const entry of this.ctx.sessionManager.getEntries()) {
      this.core.observe(entry, 'runtime-entry');
      this.observeManagedEntry(entry);
    }
    await observeFile(
      this.core,
      this.ctx.sessionManager.getSessionFile(),
      () => !this.disposed && this.core.ready,
    );
  }

  /** Managed deliveries observe via their own namespace + deliveryRef
   *  (I18/M1: recorded requires real evidence, never connection liveness). */
  private observeManagedEntry(entry: unknown): void {
    const m = this.managed;
    if (!m || !entry || typeof entry !== 'object') return;
    const e = entry as { type?: string; details?: Record<string, unknown> };
    if (e.type !== 'custom_message') return;
    const details = e.details ?? {};
    if (details.namespace !== 'pi-relay/managed/delivery/v1') return;
    const deliveryRef = String(details.deliveryRef ?? '');
    if (!deliveryRef) return;
    try {
      m.target.observeSubmitted(deliveryRef, 'runtime-entry');
    } catch {
      // ownership races are terminal for this attachment; supervisor closes us
    }
  }
  async pump(): Promise<void> {
    if (this.disposed) return;
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    this.running = true;
    try {
      await this.observe();
      if (this.disposed) return;
      const attempt = this.core.claimOne(this.eligibility());
      if (attempt) {
        // This is deliberately the last synchronous check. No await may appear before sendMessage.
        if (!this.core.canInvoke(attempt, this.eligibility())) {
          this.core.abortedBeforeInvoke(attempt);
          return;
        }
        try {
          const packet = this.core.packet(attempt.bindingId, attempt.eventId);
          this.pi.sendMessage(
            {
              customType: 'pi-relay.delivery.v1',
              content: deliveryContent(packet, attempt.deliveryId),
              display: true,
              details: {
                namespace: 'pi-relay/delivery/v1',
                deliveryId: attempt.deliveryId,
                bindingId: attempt.bindingId,
                eventId: attempt.eventId,
                eventIds: [attempt.eventId],
                payloadDigest: attempt.payloadDigest,
                targetFingerprint: attempt.targetFingerprint,
                attachmentId: attempt.attachmentId,
                ownerEpoch: attempt.ownerEpoch,
              },
            },
            { triggerTurn: true, deliverAs: 'followUp' },
          );
          this.core.invoked(attempt);
        } catch {
          this.core.unknown(attempt);
          return;
        }
        if (this.timeout) clearTimeout(this.timeout);
        this.timeout = setTimeout(() => {
          if (this.disposed) return;
          const receipt = this.core.receipt(attempt.bindingId, attempt.eventId);
          if (receipt.delivery.disposition === 'submitted') this.core.unknown(attempt);
        }, 30000);
        this.timeout.unref();
        this.schedule();
        return;
      }
      // Managed pump (02 §2.5/03 §3.3): grant-gated, guard-checked, scope-proofed;
      // the invoke boundary keeps the no-await discipline inside pumpManaged.
      if (this.managed && !this.disposed) {
        try {
          const pumped = await this.managed.target.pumpManaged(
            this.eligibility(),
            async (request, deliveryRef) => {
              this.pi.sendMessage(
                {
                  customType: 'pi-relay.managed.delivery.v1',
                  content: `pi-relay managed delivery ${deliveryRef}: ${request.event.type} ${request.event.id}`,
                  display: true,
                  details: managedDeliveryDetails(request, deliveryRef),
                },
                { triggerTurn: true, deliverAs: 'followUp' },
              );
              return { evidence: 'runtime-entry' };
            },
            this.managed.proof,
          );
          // Re-arm only when this pass actually advanced work (delivered or
          // skipped forward); a pass that claimed nothing, or stopped on a
          // guard/proof defer, must wait for the next external trigger
          // (entry event, control, rescan) instead of hot-looping via
          // setImmediate — the unconditional reschedule here was a 100%-CPU
          // spin in every Pi session carrying this extension.
          if (pumped.claimed > 0 && !pumped.deferred) this.schedule();
        } catch (error) {
          const code = safeError(error).code;
          if (code === 'owner_superseded' || this.disposed) return;
          // Fault-injected crash between intent and invoke stays unknown (03 §3.6)
          // — the restore sweep on the next host marks it; no retry here.
        }
      }
    } finally {
      this.running = false;
      if (this.rerunRequested) {
        this.rerunRequested = false;
        this.schedule();
      }
    }
  }
  dispose(): void {
    this.disposed = true;
    this.rerunRequested = false;
    if (this.scheduled) clearImmediate(this.scheduled);
    if (this.timeout) clearTimeout(this.timeout);
    if (this.safetyTimer) clearInterval(this.safetyTimer);
  }
}
