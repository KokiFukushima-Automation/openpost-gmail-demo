import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RangeSet, parseRangeFile } from './cidr.js';

export interface RangeIndex {
  apple: RangeSet;
  googleProxy: RangeSet;
  datacenter: RangeSet;
  loadedAt: number;
}

const EMPTY_APPLE = new RangeSet('apple_relay', [], '');
const EMPTY_GOOGLE = new RangeSet('google_proxy', [], '');
const EMPTY_DATACENTER = new RangeSet('datacenter', [], '');

export const EMPTY_RANGE_INDEX: RangeIndex = {
  apple: EMPTY_APPLE,
  googleProxy: EMPTY_GOOGLE,
  datacenter: EMPTY_DATACENTER,
  loadedAt: 0,
};

const FILES: Array<{ file: string; name: 'apple_relay' | 'google_proxy' | 'datacenter' }> = [
  { file: 'apple-relay.cidr', name: 'apple_relay' },
  { file: 'google-proxy.cidr', name: 'google_proxy' },
  { file: 'datacenter.cidr', name: 'datacenter' },
];

/** Loads the three shipped range files from `dir`. A missing or unreadable file yields an empty
 *  `RangeSet` and a logged warning - never a startup failure (§4.1). `read` is injectable so tests
 *  can exercise this without touching the real filesystem. */
export function loadRangeIndex(
  dir: string,
  read: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): RangeIndex {
  const sets = new Map<string, RangeSet>();
  for (const { file, name } of FILES) {
    const path = join(dir, file);
    try {
      const text = read(path);
      sets.set(name, parseRangeFile(name, text));
    } catch {
      console.warn(`openpost: could not load range file ${path} - treating "${name}" as empty`);
      sets.set(name, new RangeSet(name, [], ''));
    }
  }
  return {
    apple: sets.get('apple_relay') ?? EMPTY_APPLE,
    googleProxy: sets.get('google_proxy') ?? EMPTY_GOOGLE,
    datacenter: sets.get('datacenter') ?? EMPTY_DATACENTER,
    loadedAt: Date.now(),
  };
}
