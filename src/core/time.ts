export type Clock = () => number;

export function systemClock(): number {
  return Date.now();
}

const DURATION_UNITS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

const DURATION_RE = /^(\d+)(s|m|h|d|w)$/;

/** Parses `'45s' '90m' '4h' '3d' '2w'` into milliseconds. Rejects empty strings, missing/unknown
 *  units, negative or fractional values, a bare number with no unit, and anything that overflows a
 *  safe integer once converted - returns `null` rather than throwing (Phase 3 §3.1). Zero (`'0s'`)
 *  parses to `0` here - it is a syntactically valid duration; `parseWhen` is what rejects a
 *  non-positive `--in` (L13), since "zero" only actually matters as a due time. */
export function parseDuration(s: string): number | null {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim();
  const m = DURATION_RE.exec(trimmed);
  if (!m) return null;
  const amount = Number(m[1]);
  const unit = m[2] as string;
  if (!Number.isSafeInteger(amount)) return null;
  const ms = amount * (DURATION_UNITS[unit] as number);
  return Number.isSafeInteger(ms) ? ms : null;
}

// Phase 3.1 (L13): `Date.parse` alone is far too lenient (it also accepts "March 3, 2024",
// "3/3/24", and other non-ISO formats RFC/§3.1 never meant to allow through `--at`) - require an
// actual ISO-8601-shaped string first, then let `Date.parse` validate the calendar values
// themselves (e.g. still correctly rejects "2024-13-45").
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export interface ParseWhenOpts {
  in?: string | undefined;
  at?: string | undefined;
}

export type ParseWhenResult = { atMs: number } | { error: string };

const MAX_HORIZON_DAYS_DEFAULT = 365;

/** Resolves `--in <dur>` / `--at <iso>` (mutually exclusive, exactly one required) into an absolute
 *  epoch-ms due time (Phase 3 §3.1). `maxHorizonDays` defaults to `REMINDER_MAX_HORIZON_DAYS`'s own
 *  default so callers that don't care about the config value still get a sane bound. */
export function parseWhen(
  opts: ParseWhenOpts,
  nowMs: number,
  maxHorizonDays = MAX_HORIZON_DAYS_DEFAULT,
): ParseWhenResult {
  const hasIn = opts.in !== undefined && opts.in.trim() !== '';
  const hasAt = opts.at !== undefined && opts.at.trim() !== '';
  if (hasIn === hasAt) {
    return { error: 'exactly one of --in or --at is required' };
  }
  const maxHorizonMs = maxHorizonDays * 86_400_000;

  if (hasIn) {
    const ms = parseDuration((opts.in as string).trim());
    if (ms === null) {
      return { error: `invalid --in duration: "${opts.in}" (expected e.g. 45s, 90m, 4h, 3d, 2w)` };
    }
    // L13: "0s" (or any zero-amount duration) parses fine as a *duration*, but a reminder due
    // "right now" (or, with a fractional/rounding path, in the past) is never meaningful - --at
    // already requires a strictly future time below, so --in is held to the same standard.
    if (ms <= 0) {
      return { error: `--in must be a positive duration (got "${opts.in}")` };
    }
    if (ms > maxHorizonMs) {
      return { error: `--in exceeds the maximum horizon of ${maxHorizonDays} days` };
    }
    return { atMs: nowMs + ms };
  }

  const raw = (opts.at as string).trim();
  if (!ISO_8601_RE.test(raw)) {
    return { error: `invalid --at timestamp: "${opts.at}" (expected ISO-8601, e.g. 2025-01-31T12:00:00Z)` };
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    return { error: `invalid --at timestamp: "${opts.at}" (expected ISO-8601)` };
  }
  if (parsed <= nowMs) {
    return { error: '--at must be in the future' };
  }
  if (parsed - nowMs > maxHorizonMs) {
    return { error: `--at exceeds the maximum horizon of ${maxHorizonDays} days` };
  }
  return { atMs: parsed };
}

/** `Intl`-based, DST-correct hour-of-day (0-23) for `ms` in `timeZone` (Phase 3 §3.1/§5). */
export function hourInZone(ms: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(new Date(ms));
  const hourPart = parts.find((p) => p.type === 'hour');
  return hourPart ? Number(hourPart.value) % 24 : new Date(ms).getUTCHours();
}

/** `Intl`-based `'YYYY-MM-DD'` day key for `ms` in `timeZone`. */
export function dayKeyInZone(ms: number, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date(ms));
}

/** `true` iff `Intl` recognises `tz` as a valid IANA time zone identifier. */
export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
