/** A ~45-line tagged template, not a template engine (§2.5): escapes by construction, and the
 *  unsafe path must be spelled `raw()`. `tsc` type-checks every view; there is no file-loading path
 *  and no second syntax to review for XSS. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** The ONLY way to inject unescaped markup - reserved for composing sub-templates and the inline
 *  SVG built by `views/charts.ts`. A page module must never call this on anything derived from the
 *  database (enforced by review and by the views test suite). */
export function raw(s: string): SafeHtml {
  return new SafeHtml(s);
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\//g, '&#47;');
}

/** `escapeHtml`, always emitted inside a `"…"` attribute value. */
export function attr(v: string): string {
  return escapeHtml(v);
}

function interpolate(value: unknown): string {
  if (value instanceof SafeHtml) return value.value;
  if (value === null || value === undefined || value === false) return '';
  if (Array.isArray(value)) return value.map(interpolate).join('');
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) {
    out += interpolate(values[i]);
    out += strings[i + 1] ?? '';
  }
  return new SafeHtml(out);
}

export function join(parts: unknown[], sep = ''): SafeHtml {
  return new SafeHtml(parts.map(interpolate).join(sep));
}

export function classNames(map: Record<string, boolean>): string {
  return Object.entries(map)
    .filter(([, on]) => on)
    .map(([name]) => name)
    .join(' ');
}

export function render(doc: SafeHtml): string {
  return doc.value;
}

/** Builds a query string with `URLSearchParams` so no caller hand-concatenates `?`/`&` (§2.5). */
export function href(path: string, params: Record<string, string | number | boolean | undefined | null> = {}): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    qs.set(k, String(v));
  }
  const s = qs.toString();
  return s.length > 0 ? `${path}?${s}` : path;
}
