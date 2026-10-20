import { createHmac } from 'node:crypto';
import type { PrivacyMode } from '../types.js';

function utcDateString(atMs: number): string {
  const d = new Date(atMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function dailySalt(ipSalt: string, atMs: number): string {
  return `${ipSalt}:${utcDateString(atMs)}`;
}

/**
 * Derives a daily-rotating HMAC key from `ipSalt`. Using HMAC (rather than concatenating the
 * salt and the date into a hash message) means the salt is only ever used as HMAC *key* material,
 * never mixed into a hashed message the way a naive `sha256(salt + date)` would (finding #13).
 */
function dailyKey(ipSalt: string, atMs: number): Buffer {
  return createHmac('sha256', ipSalt).update(utcDateString(atMs)).digest();
}

export function hashIp(ip: string | null, ipSalt: string, atMs: number): string | null {
  if (ip === null || ip === '') return null;
  const key = dailyKey(ipSalt, atMs);
  return createHmac('sha256', key).update(ip).digest('hex').slice(0, 16);
}

/** /24 for IPv4, /48 for IPv6. Returns null for unparseable input. */
export function netOf(ip: string): string | null {
  if (ip.includes(':')) {
    // IPv6: keep the first 3 hextets (48 bits) - a best-effort textual /48 prefix, sufficient for
    // stable, deterministic grouping without a full address-expansion implementation.
    const withoutZone = (ip.split('%')[0] as string).trim();
    if (withoutZone.includes('.')) {
      // Finding #4 (same class of bug as core/cidr.ts's ipToBigInt): only the exact `::ffff:a.b.c.d`
      // / bare `::a.b.c.d` shorthand nets as IPv4 - taking "everything after the last colon" would
      // let `dead:beef::17.1.1.1` (a genuine, distinct v6 address) collide into the same fanout/
      // dedupe bucket as plain `17.1.1.1`.
      const shorthand = /^::(ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(withoutZone);
      if (shorthand) {
        return netOf(shorthand[2] as string);
      }
    }
    const groups = withoutZone.split(':').filter((g) => g.length > 0);
    if (groups.length === 0) return null;
    const firstThree = groups.slice(0, 3);
    return `${firstThree.join(':')}::/48`;
  }
  const octets = ip.split('.');
  if (octets.length !== 4) return null;
  for (const o of octets) {
    const n = Number(o);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  }
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
}

export function hashNet(ip: string | null, ipSalt: string, atMs: number): string | null {
  if (ip === null || ip === '') return null;
  const net = netOf(ip);
  if (net === null) return null;
  const key = dailyKey(ipSalt, atMs);
  return createHmac('sha256', key).update(net).digest('hex').slice(0, 16);
}

export interface EventRecordDraft {
  ip_hash?: string | null;
  ip_net_hash?: string | null;
  ua?: string | null;
  ua_family?: string | null;
  device_type?: string | null;
  os?: string | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
  [key: string]: unknown;
}

export function redactForMode<T extends EventRecordDraft>(rec: T, mode: PrivacyMode): T {
  if (mode === 'off') return rec;
  if (mode === 'balanced') {
    return { ...rec, ua: null, city: null };
  }
  // strict
  return {
    ...rec,
    ip_hash: null,
    ip_net_hash: null,
    ua: null,
    ua_family: null,
    device_type: null,
    os: null,
    country: null,
    region: null,
    city: null,
  };
}
