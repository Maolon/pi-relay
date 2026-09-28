import { it, expect } from 'vitest';
import { relayCompletion } from '../../examples/plugin/completion.mjs';
import { system, event } from '../fixtures/system.mjs';
import { connectChannel } from '../../dist/client/index.js';
it('[G13 M15 M19] the executor retains notification and upstream-ack ownership', async () => {
  const s = await system({ targets: 1 });
  const publisher = connectChannel(s.source.core.publisherHandle('X'));
  try {
    await s.bind(0);
    const value = event('already-seen');
    expect(
      await relayCompletion(publisher, {
        event: value,
        observedAsToolResult: true,
        notificationOwner: 'relay',
      }),
    ).toEqual({ skipped: 'already-observed-tool-result' });
    expect(
      await relayCompletion(publisher, {
        event: value,
        observedAsToolResult: false,
        notificationOwner: 'legacy',
      }),
    ).toEqual({ skipped: 'another-notification-owner' });
    expect(s.source.core.store.get('SELECT count(*) n FROM source_events').n).toBe(0);
    const result = await relayCompletion(publisher, {
      event: value,
      observedAsToolResult: false,
      notificationOwner: 'relay',
    });
    expect(result.routes[0].admission).toBe('accepted');
    expect(s.source.core.store.get('SELECT count(*) n FROM source_events').n).toBe(1);
  } finally {
    publisher.dispose();
    await s.close();
  }
});
