/**
 * Deliberately tiny mail-merge templating (docs/08_phase4_spec.md §2.3). `{{key}}` and `{{{key}}}`
 * only - no conditionals, loops, filters or partials. Every failure mode (unknown key, unterminated
 * tag, bad key charset, raw output without opt-in) throws `TemplateError` rather than silently
 * rendering something wrong - a mail merge's real risk is header injection and XSS-by-CSV-cell, not
 * a missing feature.
 */

export type TemplateMode = 'html' | 'text' | 'subject';

export class TemplateError extends Error {
  readonly key: string | null;
  readonly offset: number;
  constructor(message: string, opts: { key?: string | null; offset?: number } = {}) {
    super(message);
    this.name = 'TemplateError';
    this.key = opts.key ?? null;
    this.offset = opts.offset ?? -1;
  }
}

const KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Strips CR/LF/NUL, collapses whitespace runs, truncates to 900 bytes (below RFC 5322's 998-byte
 *  line limit, leaving room for "Subject: " and folding). The header-injection defence: a CSV cell
 *  containing `Hi\r\nBcc: attacker@evil.com` must never reach a header intact. */
export function sanitizeHeaderValue(v: string): string {
  const cleaned = v.replace(/[\r\n\0]+/g, ' ').replace(/\s+/g, ' ').trim();
  const buf = Buffer.from(cleaned, 'utf8');
  if (buf.byteLength <= 900) return cleaned;
  // Truncate on a byte boundary without splitting a multi-byte UTF-8 sequence.
  let end = 900;
  while (end > 0 && (buf[end] as number) >= 0x80 && (buf[end] as number) < 0xc0) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

interface Tag {
  raw: boolean;
  key: string;
  start: number;
  end: number;
}

/** Scans `src` for `{{key}}` / `{{{key}}}` tags, single pass. Throws on an unterminated `{{` (with
 *  its byte offset) or an invalid key charset. Never re-scans a substituted value (a value
 *  containing literal `{{other}}` stays inert). */
function scanTags(src: string): Tag[] {
  const tags: Tag[] = [];
  let i = 0;
  const len = src.length;
  while (i < len) {
    const open = src.indexOf('{{', i);
    if (open === -1) break;
    const raw = src[open + 2] === '{';
    const keyStart = open + (raw ? 3 : 2);
    const closer = raw ? '}}}' : '}}';
    // For a non-raw tag, don't let a stray third `{` be swallowed into the key.
    const closeIdx = src.indexOf(closer, keyStart);
    if (closeIdx === -1) {
      throw new TemplateError(`unterminated "{{" at byte offset ${open}`, { offset: open });
    }
    const rawKey = src.slice(keyStart, closeIdx).trim();
    if (!KEY_RE.test(rawKey)) {
      throw new TemplateError(`invalid template key "${rawKey}"`, { key: rawKey, offset: keyStart });
    }
    tags.push({ raw, key: rawKey, start: open, end: closeIdx + closer.length });
    i = closeIdx + closer.length;
  }
  return tags;
}

/** Sorted, unique variable keys referenced anywhere in `src` (both `{{k}}` and `{{{k}}}`). */
export function collectVars(src: string): string[] {
  const keys = new Set(scanTags(src).map((t) => t.key));
  return [...keys].sort();
}

export interface RenderTemplateOptions {
  mode: TemplateMode;
  /** Required to render a `{{{raw}}}` tag at all; without it, any raw tag is a create-time error. */
  allowRaw?: boolean;
}

/** Renders `src` against `vars`, single pass (a substituted value is never re-scanned for tags).
 *  Unknown keys always throw - there is no silent empty substitution in any mode. */
export function renderTemplate(src: string, vars: Record<string, string>, opts: RenderTemplateOptions): string {
  const tags = scanTags(src);
  let out = '';
  let cursor = 0;
  for (const tag of tags) {
    out += src.slice(cursor, tag.start);
    if (tag.raw && !opts.allowRaw) {
      throw new TemplateError(`raw output "{{{${tag.key}}}}" requires --allow-raw`, { key: tag.key });
    }
    const value = vars[tag.key];
    if (value === undefined) {
      throw new TemplateError(`unknown template key "${tag.key}"`, { key: tag.key });
    }
    if (tag.raw) {
      out += value;
    } else if (opts.mode === 'html') {
      out += escapeHtml(value);
    } else if (opts.mode === 'subject') {
      out += sanitizeHeaderValue(value);
    } else {
      out += value;
    }
    cursor = tag.end;
  }
  out += src.slice(cursor);
  return out;
}
