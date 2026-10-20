import { describe, expect, it } from 'vitest';
import { shouldRunSelfCopy } from '../../src/cli/commands/send.js';

const BASE = {
  hasFirstSuccess: true,
  selfOpenStrategy: 'insert' as const,
  transportName: 'smtp' as const,
  track: true,
  recipientCount: 1,
};

describe('shouldRunSelfCopy (finding #11)', () => {
  it('runs for SELF_OPEN_STRATEGY=insert over smtp with tracking on and at least one recipient', () => {
    expect(shouldRunSelfCopy(BASE)).toBe(true);
  });

  it('never runs when the effective transport for this send is gmail, regardless of config.selfOpenStrategy', () => {
    // Regression: `send --transport gmail` used to bypass this check entirely (it was validated
    // only against MAIL_TRANSPORT at config-load time), producing two Sent copies - one from the
    // Gmail API send itself, one from the "untracked" self-copy insert on top of it.
    expect(shouldRunSelfCopy({ ...BASE, transportName: 'gmail' })).toBe(false);
    expect(shouldRunSelfCopy({ ...BASE, transportName: 'gmail', selfOpenStrategy: 'imap-append' })).toBe(false);
  });

  it('never runs for the default window strategy, without a successful send, without tracking, or with no recipients', () => {
    expect(shouldRunSelfCopy({ ...BASE, selfOpenStrategy: 'window' })).toBe(false);
    expect(shouldRunSelfCopy({ ...BASE, hasFirstSuccess: false })).toBe(false);
    expect(shouldRunSelfCopy({ ...BASE, track: false })).toBe(false);
    expect(shouldRunSelfCopy({ ...BASE, recipientCount: 0 })).toBe(false);
  });
});
