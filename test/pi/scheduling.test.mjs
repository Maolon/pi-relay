import { it, expect } from 'vitest';
import { PiSessionPort } from '../../dist/pi/session-port.js';

const turn = () => new Promise((resolve) => setImmediate(resolve));

function fixture() {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  let observations = 0;
  let claims = 0;
  const port = new PiSessionPort({}, {
    isIdle: () => true,
    hasPendingMessages: () => false,
  }, {
    claimOne() { claims++; return undefined; },
    holdAll() { throw new Error('Unexpected scheduling failure'); },
  });
  port.observe = async () => {
    observations++;
    if (observations === 1) await barrier;
  };
  return { port, release, observations: () => observations, claims: () => claims };
}

it('[L08 G25] a settled/entry notification during an asynchronous observation is coalesced, not lost', async () => {
  const f = fixture();
  try {
    f.port.schedule();
    await turn();
    expect(f.observations()).toBe(1);
    // Simulate message_end and agent_settled arriving while a file read is pending.
    for (let n = 0; n < 10; n++) f.port.schedule();
    await turn();
    expect(f.observations()).toBe(1);
    f.release();
    await turn();
    await turn();
    expect(f.observations()).toBe(2);
    expect(f.claims()).toBe(2);
    await turn();
    expect(f.observations()).toBe(2); // no idle polling/busy loop
  } finally {
    f.release();
    f.port.dispose();
  }
});

it('[L07 L18] disposal cancels a queued observation drain before any new claim', async () => {
  const f = fixture();
  f.port.schedule();
  await turn();
  f.port.schedule();
  f.port.dispose();
  f.release();
  await turn();
  await turn();
  expect(f.observations()).toBe(1);
  expect(f.claims()).toBe(0);
});

it('[incident-2026-09-23 / F5] settled flag gates eligibility.idle and recovers after compaction', async () => {
  let claims = 0;
  const port = new PiSessionPort({}, {
    isIdle: () => true,
    hasPendingMessages: () => false,
  }, {
    claimOne() { claims++; return undefined; },
    holdAll() {},
  }, false, undefined, 0); // disable safetyTimer for pure settled test

  try {
    expect(port.settled).toBe(true);
    expect(port.eligibility().idle).toBe(true);

    // Simulate session_before_compact
    port.settled = false;
    expect(port.eligibility().idle).toBe(false);

    // Simulate session_compact restoring settled without agent_settled
    port.settled = true;
    expect(port.eligibility().idle).toBe(true);
  } finally {
    port.dispose();
  }
});

it('[incident-2026-09-23 / F6] safetyTimer triggers claim during quiet idle periods without pi events', async () => {
  let claims = 0;
  let observations = 0;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const port = new PiSessionPort({}, {
    isIdle: () => true,
    hasPendingMessages: () => false,
  }, {
    claimOne() { claims++; return undefined; },
    holdAll() {},
  }, false, undefined, 40); // 40ms safety tick

  port.observe = async () => {
    observations++;
  };

  try {
    expect(claims).toBe(0);
    // Quiet idle without calling schedule(): within ~100ms (<= 2-3 ticks), safety net fires
    await sleep(90);
    expect(observations).toBeGreaterThanOrEqual(1);
    expect(claims).toBeGreaterThanOrEqual(1);
  } finally {
    port.dispose();
  }
});

it('[incident-2026-09-23 / F6] safetyTimer pass with 0 claims does not chain setImmediate spin', async () => {
  let observations = 0;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const port = new PiSessionPort({}, {
    isIdle: () => true,
    hasPendingMessages: () => false,
  }, {
    claimOne() { return undefined; }, // 0 claims
    holdAll() {},
  }, false, undefined, 40); // 40ms safety tick

  port.observe = async () => {
    observations++;
  };

  try {
    // Over 100ms with a 40ms interval, exactly 2 ticks should fire; not a runaway busy loop
    await sleep(100);
    expect(observations).toBeGreaterThanOrEqual(1);
    expect(observations).toBeLessThanOrEqual(4);
  } finally {
    port.dispose();
  }
});
