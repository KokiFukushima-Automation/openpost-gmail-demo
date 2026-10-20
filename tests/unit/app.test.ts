import { describe, expect, it } from 'vitest';
import { buildLoggerOptions, resolveTrustProxy } from '../../src/server/app.js';
import { makeConfig } from '../helpers/setup.js';

describe('resolveTrustProxy', () => {
  it('finding #5: false stays false (no proxy trusted)', () => {
    expect(resolveTrustProxy(false)).toBe(false);
  });

  it('finding #5: a CIDR/IP list is passed straight through', () => {
    const list = ['10.0.0.0/8', '192.168.1.1'];
    expect(resolveTrustProxy(list)).toBe(list);
  });

  it('finding #5: a numeric hop count compiles to a function trusting exactly that many hops', () => {
    const trust1 = resolveTrustProxy(1);
    expect(typeof trust1).toBe('function');
    const fn1 = trust1 as (address: string, hop: number) => boolean;
    expect(fn1('1.2.3.4', 0)).toBe(true); // hop 0: the single trusted proxy
    expect(fn1('5.6.7.8', 1)).toBe(false); // hop 1: one hop beyond what's trusted

    const trust2 = resolveTrustProxy(2) as (address: string, hop: number) => boolean;
    expect(trust2('a', 0)).toBe(true);
    expect(trust2('a', 1)).toBe(true);
    expect(trust2('a', 2)).toBe(false);
  });
});

describe('buildLoggerOptions', () => {
  it('finding #12: honours config.logLevel', () => {
    const opts = buildLoggerOptions(makeConfig({ logLevel: 'debug' }));
    expect(opts.level).toBe('debug');
  });

  it('finding #12: the req serializer never includes remoteAddress/remotePort', () => {
    const opts = buildLoggerOptions(makeConfig({ logLevel: 'info' }));
    const serializers = opts.serializers as { req: (req: { method: string; url: string }) => Record<string, unknown> };
    const serialized = serializers.req({ method: 'GET', url: '/o/abc.gif' });
    expect(serialized).not.toHaveProperty('remoteAddress');
    expect(serialized).not.toHaveProperty('remotePort');
    expect(serialized).toEqual({ method: 'GET', url: '/o/abc.gif' });
  });
});
