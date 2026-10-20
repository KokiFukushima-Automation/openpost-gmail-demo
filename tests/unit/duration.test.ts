import { describe, expect, it } from 'vitest';
import { dayKeyInZone, hourInZone, isValidTimeZone, parseDuration, parseWhen } from '../../src/core/time.js';
import { ConfigError, loadConfig } from '../../src/config/env.js';

describe('core/time duration/timezone helpers', () => {
  it('160a. parseDuration accepts 45s 90m 4h 3d 2w; rejects garbage', () => {
    expect(parseDuration('45s')).toBe(45_000);
    expect(parseDuration('90m')).toBe(90 * 60_000);
    expect(parseDuration('4h')).toBe(4 * 3_600_000);
    expect(parseDuration('3d')).toBe(3 * 86_400_000);
    expect(parseDuration('2w')).toBe(2 * 604_800_000);

    for (const bad of ['', '3', 'd3', '-1d', '1.5d']) {
      expect(parseDuration(bad)).toBeNull();
    }
    // overflow: an absurdly large amount must not silently wrap or return a bogus number.
    expect(parseDuration('99999999999999999999d')).toBeNull();
  });

  it('160b. parseWhen rejects both-or-neither of --in/--at, a past --at, and beyond-horizon values', () => {
    const now = 1_700_000_000_000;
    expect(parseWhen({}, now)).toEqual({ error: expect.any(String) });
    expect(parseWhen({ in: '1d', at: new Date(now + 86_400_000).toISOString() }, now)).toEqual({
      error: expect.any(String),
    });
    expect(parseWhen({ at: new Date(now - 1000).toISOString() }, now)).toEqual({ error: expect.any(String) });
    expect(parseWhen({ in: '400d' }, now, 365)).toEqual({ error: expect.any(String) });

    const ok = parseWhen({ in: '3d' }, now);
    expect('atMs' in ok && ok.atMs).toBe(now + 3 * 86_400_000);
    const okAt = parseWhen({ at: new Date(now + 3_600_000).toISOString() }, now);
    expect('atMs' in okAt && okAt.atMs).toBe(now + 3_600_000);
  });

  it('L13a. parseWhen rejects a non-positive --in ("0s" parses as a duration but is not a valid due time)', () => {
    const now = 1_700_000_000_000;
    expect(parseWhen({ in: '0s' }, now)).toEqual({ error: expect.any(String) });
    expect(parseDuration('0s')).toBe(0); // parseDuration itself still accepts it (L13's own note)
  });

  it('L13b. parseWhen rejects a non-ISO-8601 --at that Date.parse would otherwise leniently accept', () => {
    const now = 1_700_000_000_000;
    for (const bad of ['March 3, 2030', '3/3/2030', 'next tuesday', '2030', '2030-03-03 not a time']) {
      expect(parseWhen({ at: bad }, now)).toEqual({ error: expect.any(String) });
    }
    // A well-formed ISO-8601 string with an out-of-range calendar value is still caught by
    // Date.parse itself, after the format check passes.
    expect(parseWhen({ at: '2030-13-45T00:00:00Z' }, now)).toEqual({ error: expect.any(String) });
    // A bare date (no time) is valid ISO-8601 and must still be accepted (well within the default
    // horizon and after `now`, which is 2023-11-14).
    const bareDate = parseWhen({ at: '2023-11-20' }, now);
    expect('atMs' in bareDate).toBe(true);
  });

  it('161. hourInZone/dayKeyInZone agree with Intl for UTC, Asia/Tokyo and a US DST transition', () => {
    const ms = Date.UTC(2024, 0, 15, 23, 30); // 2024-01-15T23:30Z
    expect(hourInZone(ms, 'UTC')).toBe(23);
    expect(hourInZone(ms, 'Asia/Tokyo')).toBe(8); // UTC+9, next day
    expect(dayKeyInZone(ms, 'UTC')).toBe('2024-01-15');
    expect(dayKeyInZone(ms, 'Asia/Tokyo')).toBe('2024-01-16');

    // US DST spring-forward: 2024-03-10 02:00 America/New_York does not exist; just before and
    // just after should land in different (correct) UTC-offset hours.
    const beforeDst = Date.UTC(2024, 2, 10, 6, 30); // 01:30 EST (UTC-5)
    const afterDst = Date.UTC(2024, 2, 10, 8, 30); // 04:30 EDT (UTC-4)
    expect(hourInZone(beforeDst, 'America/New_York')).toBe(1);
    expect(hourInZone(afterDst, 'America/New_York')).toBe(4);
  });

  it('162. isValidTimeZone accepts UTC/Europe/Berlin, rejects Mars/Phobos, and loadConfig raises ConfigError for a bad REPORT_TIMEZONE', () => {
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('Mars/Phobos')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);

    expect(() =>
      loadConfig({
        TRACKING_SECRET: 'x'.repeat(40),
        REPORT_TIMEZONE: 'Mars/Phobos',
      }),
    ).toThrow(ConfigError);
  });
});
