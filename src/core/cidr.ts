import { createHash } from 'node:crypto';

export interface RangeEntry {
  start: bigint;
  end: bigint;
  v6: boolean;
}

// Finding #20: a leading zero on an IPv4 octet (e.g. "010") is rejected outright rather than
// parsed as decimal - some C-library parsers (inet_aton et al.) instead read a leading-zero octet
// as octal, so the same textual address can silently mean two different IPs depending on which
// parser reads it; refusing the ambiguous form entirely closes that canonicalisation mismatch.
function parseIPv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

/** Parses a (possibly `::`-abbreviated) IPv6 address into a 128-bit bigint, or null if malformed. */
function parseIPv6ToBigInt(ip: string): bigint | null {
  if (ip === '') return null;
  const doubleColonCount = (ip.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return null;

  let head: string[];
  let tail: string[];
  const hasDoubleColon = ip.includes('::');
  if (hasDoubleColon) {
    const [h, t] = ip.split('::');
    head = h === '' || h === undefined ? [] : h.split(':');
    tail = t === '' || t === undefined ? [] : t.split(':');
  } else {
    head = ip.split(':');
    tail = [];
  }
  const missing = 8 - (head.length + tail.length);
  // Finding #20: "::" must elide at least one group - an already-full 8-group address spelled with
  // a "::" in it (e.g. "1:2:3:4:5:6:7::8") is not valid IPv6, even though the total group count
  // still comes out to 8; only reject on `missing < 0` let that malformed form through silently.
  if (missing < 0 || (hasDoubleColon && missing < 1)) return null;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  if (groups.length !== 8) return null;

  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return value;
}

// Finding #4: only this exact shorthand collapses to a plain IPv4 value - `^(::ffff:)?a.b.c.d$`.
// Any other IPv6 literal that merely *ends* in a dotted quad (`dead:beef::17.1.1.1`, or a
// fully-expanded v4-mapped address like `0:0:0:0:0:ffff:192.0.2.1`) keeps its real 128-bit value
// below, rather than being reduced to the bare v4 octets - taking "everything after the last colon"
// let a crafted IPv6 literal borrow an IPv4 CIDR match (or a v4-keyed dedupe/fanout bucket) that a
// plain `curl <ipv6>` request was never actually inside.
const V4_MAPPED_RE = /^::(ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

/** Rewrites an IPv6 literal's trailing dotted-quad tail (`...:a.b.c.d`) into its two equivalent hex
 *  groups, so the whole thing can be parsed by `parseIPv6ToBigInt` as ordinary hextets. Returns null
 *  if the tail isn't a valid IPv4 literal. */
function rewriteEmbeddedV4Tail(ip: string): string | null {
  const idx = ip.lastIndexOf(':');
  const v4Tail = ip.slice(idx + 1);
  const v4Value = parseIPv4ToBigInt(v4Tail);
  if (v4Value === null) return null;
  const hi = (v4Value >> 16n) & 0xffffn;
  const lo = v4Value & 0xffffn;
  return `${ip.slice(0, idx)}:${hi.toString(16)}:${lo.toString(16)}`;
}

/** Parses an IP address (v4, v6, or an IPv4-mapped v6 literal like `::ffff:1.2.3.4`) into a bigint
 *  plus a family flag. Only the exact `::ffff:a.b.c.d` / bare `::a.b.c.d` shorthand is treated as
 *  plain IPv4 (matching `netOf` in `privacy.ts`), since that is the address space CIDR data is
 *  actually published for; every other IPv6 literal - even one that merely ends in a dotted quad -
 *  is parsed as a genuine 128-bit v6 value (finding #4). */
export function ipToBigInt(ip: string): { value: bigint; v6: boolean } | null {
  if (typeof ip !== 'string' || ip.trim() === '') return null;
  const trimmed = ip.trim();

  if (trimmed.includes(':')) {
    const withoutZone = (trimmed.split('%')[0] as string).trim();
    if (withoutZone.includes('.')) {
      const shorthand = V4_MAPPED_RE.exec(withoutZone);
      if (shorthand) {
        const v4 = parseIPv4ToBigInt(shorthand[2] as string);
        return v4 === null ? null : { value: v4, v6: false };
      }
      const rewritten = rewriteEmbeddedV4Tail(withoutZone);
      if (rewritten === null) return null;
      const v6 = parseIPv6ToBigInt(rewritten);
      return v6 === null ? null : { value: v6, v6: true };
    }
    const v6 = parseIPv6ToBigInt(withoutZone);
    return v6 === null ? null : { value: v6, v6: true };
  }

  const v4 = parseIPv4ToBigInt(trimmed);
  return v4 === null ? null : { value: v4, v6: false };
}

/** Parses one `a.b.c.d/n` or `xxxx::/n` CIDR line into its inclusive [start, end] bigint range.
 *  Returns null for anything malformed rather than throwing. */
export function parseCidr(cidr: string): RangeEntry | null {
  const trimmed = cidr.trim();
  const slash = trimmed.lastIndexOf('/');
  if (slash === -1) return null;
  const base = trimmed.slice(0, slash);
  const prefixStr = trimmed.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixStr)) return null;
  const prefix = Number(prefixStr);

  const parsed = ipToBigInt(base);
  if (parsed === null) return null;
  const bits = parsed.v6 ? 128 : 32;
  if (prefix < 0 || prefix > bits) return null;

  const hostBits = BigInt(bits - prefix);
  const blockSize = hostBits === 0n ? 1n : 1n << hostBits;
  const mask = ~(blockSize - 1n) & ((1n << BigInt(bits)) - 1n);
  const start = parsed.value & mask;
  const end = start + blockSize - 1n;
  return { start, end, v6: parsed.v6 };
}

/** Sorts by (family, start) and coalesces overlapping or directly adjacent ranges within the same
 *  family, leaving the result sorted and non-overlapping. */
export function mergeRanges(entries: RangeEntry[]): RangeEntry[] {
  const sorted = [...entries].sort((a, b) => {
    if (a.v6 !== b.v6) return a.v6 ? 1 : -1;
    if (a.start < b.start) return -1;
    if (a.start > b.start) return 1;
    return 0;
  });
  const merged: RangeEntry[] = [];
  for (const entry of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.v6 === entry.v6 && entry.start <= last.end + 1n) {
      if (entry.end > last.end) last.end = entry.end;
    } else {
      merged.push({ ...entry });
    }
  }
  return merged;
}

function binarySearchContains(arr: RangeEntry[], value: bigint): boolean {
  let lo = 0;
  let hi = arr.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const entry = arr[mid] as RangeEntry;
    if (entry.start <= value) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (candidate === -1) return false;
  return value <= (arr[candidate] as RangeEntry).end;
}

export class RangeSet {
  readonly name: string;
  readonly entries: RangeEntry[];
  readonly sha256: string;
  readonly sourceUrl: string | null;
  readonly generatedAt: number | null;
  private readonly v4Entries: RangeEntry[];
  private readonly v6Entries: RangeEntry[];

  constructor(
    name: string,
    entries: RangeEntry[],
    sha256: string,
    sourceUrl: string | null = null,
    generatedAt: number | null = null,
  ) {
    this.name = name;
    this.entries = mergeRanges(entries);
    this.sha256 = sha256;
    this.sourceUrl = sourceUrl;
    this.generatedAt = generatedAt;
    this.v4Entries = this.entries.filter((e) => !e.v6);
    this.v6Entries = this.entries.filter((e) => e.v6);
  }

  contains(ip: string | null): boolean {
    if (ip === null) return false;
    const parsed = ipToBigInt(ip);
    if (parsed === null) return false;
    return binarySearchContains(parsed.v6 ? this.v6Entries : this.v4Entries, parsed.value);
  }

  get size(): number {
    return this.entries.length;
  }
}

export interface RangeFileHeader {
  [key: string]: string;
}

function parseHeader(lines: string[]): RangeFileHeader {
  const header: RangeFileHeader = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('#')) continue;
    const body = trimmed.slice(1).trim();
    const colon = body.indexOf(':');
    if (colon === -1) continue;
    const key = body.slice(0, colon).trim();
    const value = body.slice(colon + 1).trim();
    if (key.length > 0) header[key] = value;
  }
  return header;
}

/** Parses a shipped `.cidr` file (§4.1 header format) into a `RangeSet`. Never throws: a `# name`
 *  mismatch or unparseable body yields an empty set (with a console warning) rather than an
 *  exception, so a corrupt data file never prevents the server from starting. */
export function parseRangeFile(name: string, text: string): RangeSet {
  const sha256 = createHash('sha256').update(text).digest('hex');
  const lines = text.split(/\r?\n/);
  const header = parseHeader(lines);

  if (header.name !== undefined && header.name !== name) {
    console.warn(
      `openpost: range file for "${name}" declares "# name: ${header.name}" - rejecting as empty`,
    );
    return new RangeSet(name, [], sha256, null, null);
  }

  const entries: RangeEntry[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const parsed = parseCidr(line);
    if (parsed === null) {
      console.warn(`openpost: range file for "${name}" skips malformed entry: ${line}`);
      continue;
    }
    entries.push(parsed);
  }

  const sourceUrl = header.source ?? null;
  const generatedAtStr = header.generated_at;
  const generatedAtMs =
    generatedAtStr !== undefined && !Number.isNaN(Date.parse(generatedAtStr))
      ? Date.parse(generatedAtStr)
      : null;

  return new RangeSet(name, entries, sha256, sourceUrl, generatedAtMs);
}
