import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashIp, hashNet, netOf, redactForMode } from '../../src/core/privacy.js';

const SALT = 'test-salt-value';
const DAY1 = Date.parse('2026-01-01T12:00:00Z');
const DAY2 = Date.parse('2026-01-02T12:00:00Z');

describe('privacy', () => {
  it('25. hashIp is stable within a UTC day and differs across days', () => {
    const a1 = hashIp('203.0.113.5', SALT, DAY1);
    const a2 = hashIp('203.0.113.5', SALT, DAY1 + 60_000);
    const b = hashIp('203.0.113.5', SALT, DAY2);
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it('26. hashIp(null) is null; IPv6 nets are /48-shaped, IPv4 nets are /24', () => {
    expect(hashIp(null, SALT, DAY1)).toBeNull();
    expect(netOf('203.0.113.5')).toBe('203.0.113.0/24');
    expect(netOf('2001:db8:1234:5678::1')).toBe('2001:db8:1234::/48');
    expect(netOf('2001:db8:1234:aaaa::1')).not.toBe(netOf('2001:db8:9999:aaaa::1'));
  });

  it('netOf treats an IPv4-mapped IPv6 address as its IPv4 /24', () => {
    expect(netOf('::ffff:203.0.113.5')).toBe(netOf('203.0.113.5'));
    expect(netOf('not-an-ip')).toBeNull();
  });

  it('hashNet groups the same /24 together and separates different ones', () => {
    const n1 = hashNet('203.0.113.5', SALT, DAY1);
    const n2 = hashNet('203.0.113.200', SALT, DAY1);
    const n3 = hashNet('203.0.114.5', SALT, DAY1);
    expect(n1).toBe(n2);
    expect(n1).not.toBe(n3);
    expect(hashNet(null, SALT, DAY1)).toBeNull();
  });

  it('27. redactForMode("strict") nulls all identifying fields', () => {
    const rec = {
      ip_hash: 'h',
      ip_net_hash: 'n',
      ua: 'Mozilla/5.0',
      ua_family: 'Chrome',
      device_type: 'desktop',
      os: 'Windows',
      country: 'US',
      region: 'CA',
      city: 'SF',
    };
    const redacted = redactForMode(rec, 'strict');
    for (const key of Object.keys(rec) as (keyof typeof rec)[]) {
      expect(redacted[key]).toBeNull();
    }
  });

  it('28. redactForMode("balanced") keeps ua_family/device_type, nulls raw ua and city', () => {
    const rec = {
      ip_hash: 'h',
      ip_net_hash: 'n',
      ua: 'Mozilla/5.0',
      ua_family: 'Chrome',
      device_type: 'desktop',
      os: 'Windows',
      country: 'US',
      region: 'CA',
      city: 'SF',
    };
    const redacted = redactForMode(rec, 'balanced');
    expect(redacted.ua).toBeNull();
    expect(redacted.city).toBeNull();
    expect(redacted.ua_family).toBe('Chrome');
    expect(redacted.device_type).toBe('desktop');
    expect(redacted.ip_hash).toBe('h');
  });

  it('redactForMode("off") passes everything through unchanged', () => {
    const rec = { ip_hash: 'h', ua: 'Mozilla/5.0', city: 'SF' };
    expect(redactForMode(rec, 'off')).toEqual(rec);
  });

  it("finding #13: hashIp is a real HMAC, not sha256(salt concatenated with ip)", () => {
    const ip = '203.0.113.5';
    // The naive, pre-fix construction the review flagged.
    const dateStr = new Date(DAY1).toISOString().slice(0, 10);
    const naive = createHash('sha256')
      .update(`${SALT}:${dateStr}`)
      .update(ip)
      .digest('hex')
      .slice(0, 16);
    expect(hashIp(ip, SALT, DAY1)).not.toBe(naive);
  });

  it('finding #13: hashIp output changes when only the salt changes (salt is real key material)', () => {
    const ip = '203.0.113.5';
    const a = hashIp(ip, 'salt-one', DAY1);
    const b = hashIp(ip, 'salt-two', DAY1);
    expect(a).not.toBe(b);
  });
});
