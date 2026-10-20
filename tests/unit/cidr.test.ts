import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RangeSet, ipToBigInt, mergeRanges, parseCidr, parseRangeFile } from '../../src/core/cidr.js';
import { loadRangeIndex } from '../../src/core/ranges.js';

const RANGES_DIR = join(process.cwd(), 'data', 'ranges');

describe('parseCidr / ipToBigInt', () => {
  it('49. maps 10.0.0.0/24 and 2a01:b740::/32 to the right start/end bigints; /0 and /32 edges', () => {
    const v4 = parseCidr('10.0.0.0/24');
    expect(v4).not.toBeNull();
    expect(v4?.v6).toBe(false);
    expect(v4?.start).toBe(ipToBigInt('10.0.0.0')?.value);
    expect(v4?.end).toBe(ipToBigInt('10.0.0.255')?.value);

    const v6 = parseCidr('2a01:b740::/32');
    expect(v6).not.toBeNull();
    expect(v6?.v6).toBe(true);
    expect(v6?.start).toBe(ipToBigInt('2a01:b740::')?.value);
    expect(v6?.end).toBe(ipToBigInt('2a01:b740:ffff:ffff:ffff:ffff:ffff:ffff')?.value);

    const slashZero = parseCidr('0.0.0.0/0');
    expect(slashZero?.start).toBe(0n);
    expect(slashZero?.end).toBe((1n << 32n) - 1n);

    const slash32 = parseCidr('192.168.1.1/32');
    expect(slash32?.start).toBe(slash32?.end);
  });

  it('50. contains is inclusive at both boundaries and false one address outside, v4 and v6', () => {
    const set = new RangeSet('t', [parseCidr('10.0.0.0/24') as never, parseCidr('2a01:b740::/32') as never], 'x');
    expect(set.contains('10.0.0.0')).toBe(true);
    expect(set.contains('10.0.0.255')).toBe(true);
    expect(set.contains('10.0.1.0')).toBe(false);
    expect(set.contains('9.255.255.255')).toBe(false);
    expect(set.contains('2a01:b740::')).toBe(true);
    expect(set.contains('2a01:b740:ffff:ffff:ffff:ffff:ffff:ffff')).toBe(true);
    expect(set.contains('2a01:b741::')).toBe(false);
  });

  it('51. comments, header lines, blank lines and malformed entries are skipped without throwing', () => {
    const text = [
      '# openpost-range-list: 1',
      '# name: t',
      '',
      '10.0.0.0/24',
      'not-a-cidr',
      '999.0.0.0/8',
      '',
      '192.168.0.0/16',
    ].join('\n');
    const set = parseRangeFile('t', text);
    expect(set.size).toBe(2);
    expect(set.contains('10.0.0.1')).toBe(true);
    expect(set.contains('192.168.5.5')).toBe(true);
  });

  it('52. loadRangeIndex on a missing directory returns empty sets and does not throw', () => {
    expect(() => loadRangeIndex('/no/such/directory/at/all')).not.toThrow();
    const index = loadRangeIndex('/no/such/directory/at/all');
    expect(index.apple.size).toBe(0);
    expect(index.googleProxy.size).toBe(0);
    expect(index.datacenter.size).toBe(0);
  });

  it('53. shipped apple-relay.cidr contains 17.1.2.3 and not 8.8.8.8; google-proxy.cidr contains a real Gmail image-proxy prefix, not general GCP', () => {
    const index = loadRangeIndex(RANGES_DIR);
    expect(index.apple.contains('17.1.2.3')).toBe(true);
    expect(index.apple.contains('8.8.8.8')).toBe(false);
    // Real Gmail image-proxy egress (finding #3): still in google-proxy.cidr.
    expect(index.googleProxy.contains('66.249.64.1')).toBe(true);
    expect(index.googleProxy.contains('8.8.4.4')).toBe(false);
    // General GCP address space pulled from goog.json moved to datacenter.cidr, not
    // google-proxy.cidr, so it no longer earns the R3 "Gmail proxy" credit on IP alone.
    expect(index.googleProxy.contains('35.190.1.1')).toBe(false);
    expect(index.datacenter.contains('35.190.1.1')).toBe(true);
    expect(index.datacenter.contains('34.64.0.1')).toBe(true);
    expect(index.datacenter.size).toBeGreaterThan(0);
  });

  it('54. mergeRanges coalesces overlapping/adjacent ranges and leaves the list sorted', () => {
    const a = parseCidr('10.0.0.0/24') as never;
    const b = parseCidr('10.0.1.0/24') as never; // adjacent to a
    const c = parseCidr('192.168.0.0/24') as never; // disjoint
    const merged = mergeRanges([c, b, a]);
    expect(merged).toHaveLength(2);
    expect(merged[0]?.start < merged[1]!.start).toBe(true);
    expect(merged[0]?.end).toBe(ipToBigInt('10.0.1.255')?.value);
  });

  it('55. parseRangeFile records sha256, entries and generated_at from the header; a # name mismatch yields an empty set plus a warning', () => {
    const raw = readFileSync(join(RANGES_DIR, 'apple-relay.cidr'), 'utf8');
    const set = parseRangeFile('apple_relay', raw);
    expect(set.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(set.size).toBe(4);
    expect(set.generatedAt).not.toBeNull();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mismatched = parseRangeFile('google_proxy', raw); // real header says "apple_relay"
    expect(mismatched.size).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('ipToBigInt: IPv4-mapped shorthand vs. a genuine v6 literal with a dotted-quad tail (finding #4)', () => {
  it('only the exact ::ffff:a.b.c.d / bare ::a.b.c.d shorthand collapses to plain IPv4', () => {
    expect(ipToBigInt('::ffff:203.0.113.5')).toEqual({ value: ipToBigInt('203.0.113.5')?.value, v6: false });
    expect(ipToBigInt('::203.0.113.5')).toEqual({ value: ipToBigInt('203.0.113.5')?.value, v6: false });
  });

  it('dead:beef::17.1.1.1 is a distinct 128-bit v6 value, never equal to a v4-only 17.1.1.1', () => {
    const mixed = ipToBigInt('dead:beef::17.1.1.1');
    expect(mixed).not.toBeNull();
    expect(mixed?.v6).toBe(true);
    expect(mixed?.value).not.toBe(ipToBigInt('17.1.1.1')?.value);
    // Verified regression from finding #4: this must NOT fall inside apple-relay's 17.0.0.0/8 the
    // way it did when the parser took "everything after the last colon" as the whole address.
    const index = loadRangeIndex(RANGES_DIR);
    expect(index.apple.contains('dead:beef::17.1.1.1')).toBe(false);
  });

  it('a fully-expanded v4-mapped address (no "::") also keeps its real v6 value, not the bare v4 shortcut', () => {
    const full = ipToBigInt('0:0:0:0:0:ffff:192.0.2.1');
    expect(full).not.toBeNull();
    expect(full?.v6).toBe(true);
  });

  it('::34.64.0.1 (bare shorthand) is plain IPv4 and does NOT fall in the shipped google-proxy set', () => {
    // Regression for the reviewer-verified exploit ("::34.64.0.1 -> R3 human"): once 34.64.0.0/10
    // moved to datacenter.cidr (finding #3), the bare-shorthand v4 value 34.64.0.1 is datacentre,
    // not google-proxy, on top of R3 now requiring the actual UA regardless.
    const index = loadRangeIndex(RANGES_DIR);
    expect(ipToBigInt('::34.64.0.1')).toEqual({ value: ipToBigInt('34.64.0.1')?.value, v6: false });
    expect(index.googleProxy.contains('::34.64.0.1')).toBe(false);
    expect(index.datacenter.contains('::34.64.0.1')).toBe(true);
  });
});

describe('parseIPv6ToBigInt strictness (finding #20)', () => {
  it('rejects "::" used on an already-full 8-group address', () => {
    expect(ipToBigInt('1:2:3:4:5:6:7::8')).toBeNull();
  });

  it('rejects a leading-zero IPv4 octet (avoids an octal-vs-decimal parser mismatch)', () => {
    expect(ipToBigInt('010.0.0.1')).toBeNull();
    expect(ipToBigInt('0.0.0.0')).not.toBeNull(); // a bare "0" octet is still valid
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
