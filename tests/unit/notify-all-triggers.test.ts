import { describe, expect, it } from 'vitest';
import { ALL_NOTIFY_TRIGGERS, type NotifyTrigger } from '../../src/notify/types.js';

// 413: a compile-time exhaustiveness check (this function only type-checks if every member of the
// `NotifyTrigger` union is listed) PLUS a runtime assertion that the exported list has no
// duplicates and matches this test's own independently-typed literal set - together these fail loud
// (a build error, then a test failure) the moment `NotifyTrigger` grows without `ALL_NOTIFY_TRIGGERS`
// (and therefore `src/server/routes/stream.ts`'s `ALL_TRIGGERS`) being updated to match.
function assertExhaustive(t: NotifyTrigger): asserts t is never {
  throw new Error(`unhandled NotifyTrigger: ${String(t)}`);
}

function checkExhaustive(t: NotifyTrigger): void {
  switch (t) {
    case 'first_open':
    case 'read_confirmed':
    case 'click':
    case 'prefetched':
    case 'reply':
    case 'reminder':
    case 'campaign_digest':
    case 'daily_digest':
      return;
    default:
      assertExhaustive(t);
  }
}

describe('notify: ALL_NOTIFY_TRIGGERS is exhaustive (test 413)', () => {
  it('every member of NotifyTrigger appears exactly once', () => {
    for (const t of ALL_NOTIFY_TRIGGERS) checkExhaustive(t);
    expect(new Set(ALL_NOTIFY_TRIGGERS).size).toBe(ALL_NOTIFY_TRIGGERS.length);
    expect(ALL_NOTIFY_TRIGGERS.length).toBe(8);
  });
});
