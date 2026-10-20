// Minimal ambient surface for the optional `mmdb-lib` dependency (docs/08_phase4_spec.md §5.4).
// `mmdb-lib` is declared as an `optionalDependency` and imported only via a dynamic
// `import('mmdb-lib')` inside `src/core/geo.ts`'s `createMmdbLookup`, which only a real
// `GEOIP_DB_PATH` configuration exercises - tests inject a fake `GeoLookup` directly. This ambient
// declaration means `tsc` can type-check that dynamic import even when `mmdb-lib` was not actually
// installed - real installed types, if present in node_modules, take precedence over this one.
declare module 'mmdb-lib' {
  export interface CityRecord {
    country?: { iso_code?: string };
    subdivisions?: Array<{ iso_code?: string }>;
    city?: { names?: Record<string, string> };
  }

  export class Reader<T = CityRecord> {
    constructor(buffer: Buffer);
    readonly metadata: { buildEpoch?: number | bigint };
    get(ip: string): T | null;
  }
}
