import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION } from '../../version.js';

export interface DashboardAsset {
  body: Buffer;
  type: string;
  etag: string;
  /** Phase 5 (§2.6): per-asset cache policy. Hashed-content assets (everything except the two
   *  entry points a client must always re-check) are cached for a year; `sw.js` and the manifest are
   *  `no-cache` so an upgrade is picked up immediately, and `?v=` on layout-emitted links handles the
   *  rest. */
  cacheControl: string;
}

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.html': 'text/html; charset=utf-8',
};

const NO_CACHE_ASSETS = new Set(['sw.js', 'manifest.webmanifest']);
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const NO_CACHE_CONTROL = 'no-cache, max-age=0, must-revalidate';

const ASSET_NAMES = [
  'app.css',
  'app.js',
  'htmx.min.js',
  'favicon.svg',
  // Phase 5 (docs/09_phase5_spec.md §2.5)
  'sw.js',
  'compose.js',
  'manifest.webmanifest',
  'offline.html',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon-180.png',
];

/** htmx 2.0.4 (see `assets/htmx.min.js`'s own header comment for the upstream URL) - `openpost
 *  doctor` asserts the vendored file still matches this hash so a silently swapped asset is
 *  caught. */
export const HTMX_EXPECTED_SHA256 = 'babaa442c251838ca4fd815d9ae49db916b368b817edfab2bffdab4bf2b6152e';

/** Phase 5 (§2.5): recorded sha256 of the four generated PWA icons, the same pattern
 *  `HTMX_EXPECTED_SHA256` already uses - `openpost doctor`'s `pwa.assets` check (§7.5) fails when a
 *  committed icon's hash no longer matches what `scripts/gen-icons.mjs` deterministically produces.
 *  Regenerate both the files and these constants together with `node scripts/gen-icons.mjs`. */
export const PWA_ICON_EXPECTED_SHA256: Record<string, string> = {
  'icon-192.png': '8a6f4ab95218aa61be898652c046dd72fac19cd5ab83cc5f29789b2ac12397c1',
  'icon-512.png': 'bf1a7ba10e49dec2b19a270ac557ec25045a3531eb3a57e3cb06f426d9320ba1',
  'icon-maskable-512.png': '2fe35627e114b411470a1d5a3b917c37cf3dbaf7112ab4d0f93af5b1834c955b',
  'apple-touch-icon-180.png': 'e2ce8051c4a0ba6a628847f9aa4ba673a18b4c29aa19b6d2f8d50380d16acad3',
};

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot);
}

/** Builds a frozen `Map<name, DashboardAsset>` once at startup by reading `dist/server/assets/*`
 *  (§2.2). Unknown names are simply absent from the map - the asset route serves a 404 with no
 *  filesystem access and no path join of user input anywhere. */
export function loadDashboardAssets(dir: string): ReadonlyMap<string, DashboardAsset> {
  const map = new Map<string, DashboardAsset>();
  for (const name of ASSET_NAMES) {
    let body = readFileSync(join(dir, name));
    // Finding #11 (phase5.1): a lightweight, build-step-free "build-time" substitution done once at
    // asset-load time - `sw.js`'s own `CACHE_VERSION` is derived from the real release version so an
    // upgrade evicts every previous release's cache (`activate` only ever deletes a cache whose NAME
    // differs; see `sw.js`'s header comment).
    if (name === 'sw.js') {
      body = Buffer.from(body.toString('utf8').replaceAll('__OPENPOST_VERSION__', VERSION), 'utf8');
    }
    const ext = extOf(name);
    const type = CONTENT_TYPES[ext] ?? 'application/octet-stream';
    const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`;
    const cacheControl = NO_CACHE_ASSETS.has(name) ? NO_CACHE_CONTROL : IMMUTABLE_CACHE_CONTROL;
    map.set(name, { body, type, etag, cacheControl });
  }
  return map;
}
