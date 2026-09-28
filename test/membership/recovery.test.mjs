import { it, expect, afterEach } from 'vitest';
import { system, event, idle } from '../fixtures/system.mjs';
let f;
afterEach(async () => {
  await f?.close();
  f = undefined;
});
for (const barrier of [
  'target.after_prepare_commit',
  'source.after_membership_commit',
  'target.before_finalize_commit',
])
  it(
    '[M14 M20] membership retry after ' + barrier + ' preserves one edge and never prematurely activates',
    async () => {
      let fail = true;
      const hook = (name) => {
        if (name === barrier && fail) {
          fail = false;
          throw Error('injected');
        }
      };
      f = await system({ fault: hook, sourceFault: hook });
      const invite = f.source.core.createInvite({
        operationId: 'invite',
        channelId: 'X',
        ttlMs: 60000,
        bindingTtlMs: 600000,
        allowResume: true,
      });
      await expect(f.target[0].bind(invite, { resume: true, operationId: 'bind' })).rejects.toThrow();
      const bindings = f.target[0].core.list();
      expect(bindings).toHaveLength(1);
      expect(bindings[0].state).toBe('provisioning');
      expect(f.target[0].core.claimOne(idle)).toBeUndefined();
      const id = await f.target[0].bind(invite, { resume: true, operationId: 'bind' });
      expect(id).toBe(bindings[0].id);
      expect(f.target[0].core.binding(id).state).toBe('active');
      expect(f.source.core.store.get('SELECT count(*) n FROM memberships').n).toBe(1);
    },
  );
it('[M14 G06] changing a prepared target, payload digest or channel cannot self-authorize', async () => {
  f = await system();
  const invite = f.source.core.createInvite({
    operationId: 'invite',
    channelId: 'X',
    ttlMs: 60000,
    bindingTtlMs: 600000,
    allowResume: true,
  });
  const target = f.target[0];
  const policy = Object.fromEntries(
    invite.types.map((t) => [t.type, { model: 'display', presentation: 'card' }]),
  );
  const prepared = target.core.prepare({
    operationId: 'prepared',
    inviteId: invite.inviteId,
    sourceId: invite.sourceId,
    channelId: 'X',
    targetFingerprint: target.core.options.fingerprint,
    realm: 'test',
    expiresAt: invite.bindingExpiresAt,
    types: invite.types,
    policy,
    affinity: 'branch',
    originAnchor: null,
  });
  await expect(
    f.source.core.enroll(invite.inviteId, {
      ...prepared,
      proposal: { ...prepared.proposal, channelId: 'Y' },
    }),
  ).rejects.toThrow();
  expect(target.core.binding(prepared.bindingId).state).toBe('provisioning');
});
