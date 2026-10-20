import { describe, expect, it } from 'vitest';
import { parseStatsWindow, QueryValidationError } from '../../src/server/query.js';

const NOW = 1_800_000_000_000;
const DAY_MS = 86_400_000;

describe('server/query parseStatsWindow (M6)', () => {
  it('defaults to the last defaultWindowDays days, not all-time, when since/until are omitted', () => {
    const w = parseStatsWindow({}, { nowMs: NOW, defaultWindowDays: 90, maxWindowDays: 366 });
    expect(w.untilMs).toBe(NOW);
    expect(w.sinceMs).toBe(NOW - 90 * DAY_MS);
  });

  it('honours an explicit since/until within the max window', () => {
    const w = parseStatsWindow(
      { since: String(NOW - 30 * DAY_MS), until: String(NOW - 1 * DAY_MS) },
      { nowMs: NOW, defaultWindowDays: 90, maxWindowDays: 366 },
    );
    expect(w.sinceMs).toBe(NOW - 30 * DAY_MS);
    expect(w.untilMs).toBe(NOW - 1 * DAY_MS);
  });

  it('caps the span at maxWindowDays even when an explicit since asks for more', () => {
    const w = parseStatsWindow({ since: '0' }, { nowMs: NOW, defaultWindowDays: 90, maxWindowDays: 366 });
    expect(w.untilMs).toBe(NOW);
    expect(w.sinceMs).toBe(NOW - 366 * DAY_MS);
    expect(w.sinceMs).toBeGreaterThan(0);
  });

  it('caps the span even when both since and until are explicit', () => {
    const w = parseStatsWindow(
      { since: '0', until: String(NOW) },
      { nowMs: NOW, defaultWindowDays: 90, maxWindowDays: 30 },
    );
    expect(w.untilMs).toBe(NOW);
    expect(w.sinceMs).toBe(NOW - 30 * DAY_MS);
  });

  it('accepts a duration string for since/until (e.g. "7d")', () => {
    const w = parseStatsWindow({ since: '7d' }, { nowMs: NOW, defaultWindowDays: 90, maxWindowDays: 366 });
    expect(w.sinceMs).toBe(NOW - 7 * DAY_MS);
  });

  it('a since after until collapses to a zero-width window rather than a negative span', () => {
    const w = parseStatsWindow(
      { since: String(NOW), until: String(NOW - 10 * DAY_MS) },
      { nowMs: NOW, defaultWindowDays: 90, maxWindowDays: 366 },
    );
    expect(w.sinceMs).toBe(w.untilMs);
  });

  it('throws QueryValidationError on an unparseable since/until', () => {
    expect(() => parseStatsWindow({ since: 'not-a-date' }, { nowMs: NOW, defaultWindowDays: 90, maxWindowDays: 366 })).toThrow(
      QueryValidationError,
    );
  });
});
