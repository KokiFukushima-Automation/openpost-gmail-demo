/**
 * Optional local geo (docs/08_phase4_spec.md §5). Geo must never erode openpost's "proxied opens
 * never show a location" property: `geoForEvent` is a pure, total decision function suppressing the
 * lookup for every machine/proxy classification and IP-range flag, and capping granularity by
 * `PRIVACY_MODE` - `strict` never even calls the lookup.
 */
import { readFileSync } from 'node:fs';
import type { PrivacyMode } from '../types.js';

export interface GeoResult {
  country: string | null;
  region: string | null;
  city: string | null;
}

export const NULL_GEO: GeoResult = { country: null, region: null, city: null };

export interface GeoLookup {
  lookup(ip: string): GeoResult | null;
  readonly buildEpoch: number | null;
}

export type GeoGranularity = 'country' | 'region' | 'city';

const SUPPRESSED_CLASSIFICATIONS = new Set([
  'google_proxy_prefetch',
  'apple_mpp',
  'self_open',
  'bot',
  'scanner',
  'duplicate',
]);

/** Total over all `privacyMode` x `requested` combinations (§5.1). */
export function effectiveGranularity(requested: GeoGranularity, privacyMode: PrivacyMode): GeoGranularity | 'none' {
  if (privacyMode === 'strict') return 'none';
  if (privacyMode === 'balanced') return 'country';
  return requested;
}

function capResult(result: GeoResult, granularity: GeoGranularity | 'none'): GeoResult {
  if (granularity === 'none') return NULL_GEO;
  if (granularity === 'country') return { country: result.country, region: null, city: null };
  if (granularity === 'region') return { country: result.country, region: result.region, city: null };
  return result;
}

export interface GeoForEventArgs {
  ip: string | null;
  classification: string;
  privacyMode: PrivacyMode;
  granularity: GeoGranularity;
  flags: { isAppleRelay: boolean; isGoogleProxy: boolean; isDatacenter: boolean };
  lookup: GeoLookup | null;
}

/** The single decision point every open/click event's geo passes through, in-memory only, before
 *  the raw IP is hashed away. Never throws into the pixel/click path - a lookup failure yields
 *  `NULL_GEO` (test 330). */
export function geoForEvent(args: GeoForEventArgs): GeoResult {
  if (args.privacyMode === 'strict') return NULL_GEO;
  if (SUPPRESSED_CLASSIFICATIONS.has(args.classification)) return NULL_GEO;
  if (args.flags.isAppleRelay || args.flags.isGoogleProxy || args.flags.isDatacenter) return NULL_GEO;
  if (args.ip === null || args.lookup === null) return NULL_GEO;

  const granularity = effectiveGranularity(args.granularity, args.privacyMode);
  if (granularity === 'none') return NULL_GEO;

  try {
    const result = args.lookup.lookup(args.ip);
    if (result === null) return NULL_GEO;
    return capResult(result, granularity);
  } catch {
    return NULL_GEO;
  }
}

/**
 * Loads a MaxMind mmdb file via the optional `mmdb-lib` dependency (dynamic import, mirroring
 * `imapflow`'s precedent - src/mail/imap.ts). Any failure (module absent, file unreadable,
 * unparseable) resolves to `null` rather than throwing, so geo degrades to "disabled" instead of
 * crashing `doctor` or the server.
 */
export async function createMmdbLookup(path: string): Promise<GeoLookup | null> {
  try {
    const buf = readFileSync(path);
    const { Reader } = await import('mmdb-lib');
    const reader = new Reader(buf);
    const rawEpoch = reader.metadata?.buildEpoch;
    const buildEpoch: number | null = typeof rawEpoch === 'number' ? rawEpoch : typeof rawEpoch === 'bigint' ? Number(rawEpoch) : null;
    return {
      buildEpoch,
      lookup(ip: string): GeoResult | null {
        try {
          const rec = reader.get(ip);
          if (!rec) return null;
          const country: string | null = rec.country?.iso_code ?? null;
          const region: string | null = rec.subdivisions?.[0]?.iso_code ?? null;
          const city: string | null = rec.city?.names?.en ?? null;
          if (country === null && region === null && city === null) return null;
          return { country, region, city };
        } catch {
          return null;
        }
      },
    };
  } catch {
    return null;
  }
}
