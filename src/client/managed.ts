import type { SourceHandle } from '../protocol/types.js';
import type {
  ManagedPublish,
  ManagedReceipt,
  WithdrawResult,
  ScopeAdvance,
  Event as ManagedEvent,
  ManagedOptions,
  ApplicationResult,
} from '../protocol/managed-types.js';
import { RpcClient } from '../transport/client.js';
import { openSource } from './index.js';
import { MANAGED_SOURCE_FEATURES } from '../protocol/validate.js';
import { invariant } from '../protocol/errors.js';

/**
 * Managed delivery source SDK (approved plan 02 §2.2).
 * Wire 1.2 minor-2 operations over an authenticated source connection;
 * the 1.1 SourcePublisher surface is unchanged.
 */
export class ManagedSourceClient {
  private closed = false;
  constructor(
    readonly handle: SourceHandle,
    private connection?: { rpc: RpcClient },
  ) {}
  private async conn(): Promise<{ rpc: RpcClient }> {
    invariant(!this.closed, 'transport_unavailable');
    return (this.connection ??= await openSource(this.handle, [...MANAGED_SOURCE_FEATURES]));
  }
  private async call(op: string, params: unknown): Promise<unknown> {
    const { rpc } = await this.conn();
    return rpc.call({ op, params } as never, 2);
  }
  async publishManaged(
    event: ManagedEvent,
    options: ManagedOptions,
  ): Promise<ManagedReceipt> {
    return (await this.call('source.managed.publish', { event, options })) as ManagedReceipt;
  }
  async getManagedReceipt(eventId: string): Promise<ManagedReceipt> {
    return (await this.call('source.managed.receipt', { eventId })) as ManagedReceipt;
  }
  async watchManagedUpdates(
    after: number,
    limit = 128,
  ): Promise<{ cursor: number; resyncRequired: boolean; snapshotCursor?: number; updates: unknown[] }> {
    return (await this.call('source.managed.watch', { after, limit })) as never;
  }
  async managedSnapshot(
    afterEventId: string | undefined,
    limit = 128,
  ): Promise<{ snapshotCursor: number; updates: unknown[] }> {
    return (await this.call('source.managed.snapshot', {
      ...(afterEventId ? { afterEventId } : {}),
      limit,
    })) as never;
  }
  async withdraw(
    operationId: string,
    eventId: string,
    reason: string,
  ): Promise<WithdrawResult> {
    return (await this.call('source.event.withdraw', { operationId, eventId, reason })) as WithdrawResult;
  }
  async advanceScope(
    operationId: string,
    scopeId: string,
    expectedRevision: number,
    state: 'active' | 'paused' | 'closed',
  ): Promise<{ revision: number; state: string }> {
    const params: ScopeAdvance = {
      operationId,
      scopeId,
      expectedRevision,
      nextRevision: expectedRevision + 1,
      state,
    };
    return (await this.call('source.scope.advance', params)) as { revision: number; state: string };
  }
  async confirmApplied(
    operationId: string,
    responseId: string,
    result: ApplicationResult,
  ): Promise<{ applied: boolean }> {
    return (await this.call('source.response.applied', {
      operationId,
      responseId,
      result,
    })) as { applied: boolean };
  }
  dispose(): void {
    this.closed = true;
    this.connection?.rpc.dispose();
    this.connection = undefined;
  }
}

export function connectManagedSource(handle: SourceHandle): ManagedSourceClient {
  return new ManagedSourceClient(handle);
}
