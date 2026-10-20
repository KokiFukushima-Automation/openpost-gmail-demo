import * as cheerio from 'cheerio';

export interface PixelInjectionResult {
  html: string;
  injected: boolean;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// The tracking pixel always lives at the fixed `/o/<token>.gif` path (doc 02 §1.1). Detecting a
// previously-injected pixel by *path shape* rather than by origin means an unrelated same-origin
// image (a logo served from the tracking domain, say) never blocks injection, and detecting it
// without regard to the specific token means re-injecting with a *different* token still correctly
// recognises "there is already a pixel here" (finding #7).
const EXISTING_PIXEL_RE = /<img[^>]+src=["'][^"']*\/o\/[^"']*\.gif[^"']*["']/i;

/**
 * Inserts a 1x1 tracking <img> immediately before </body> (case-insensitive). If no </body> is
 * present, appends to the end. If a pixel already exists at the `/o/...gif` tracking path, does
 * nothing (regardless of a coincidental same-origin, non-tracking image elsewhere in the markup).
 */
export function injectPixel(html: string, pixelSrc: string): PixelInjectionResult {
  if (EXISTING_PIXEL_RE.test(html)) {
    return { html, injected: false };
  }

  const imgTag = `<img src="${escapeAttr(pixelSrc)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;outline:none;" />`;
  const bodyClose = /<\/body\s*>/i.exec(html);
  if (bodyClose && bodyClose.index !== undefined) {
    const idx = bodyClose.index;
    return { html: html.slice(0, idx) + imgTag + html.slice(idx), injected: true };
  }
  return { html: html + imgTag, injected: true };
}

export interface RewriteLinkTarget {
  url: string;
  label: string | null;
  position: number;
}

type CheerioRoot = ReturnType<typeof cheerio.load>;

export interface LinkFilterOptions {
  /** Hostnames (case-insensitive) whose links are never rewritten - our own tracking domain, so
   *  the pixel/click/opt-out URLs we generate are never treated as trackable content links, and a
   *  message that already went through rewriteLinks once (e.g. a resend) is not rewritten again
   *  (finding #14). */
  skipHosts?: Iterable<string>;
}

function isTrackableAnchor(
  $: CheerioRoot,
  el: Parameters<CheerioRoot>[0],
  skipHosts: Set<string>,
): boolean {
  const $el = $(el);
  if ($el.closest('style, script').length > 0) return false;
  if ($el.closest('[data-no-track]').length > 0) return false;
  const href = $el.attr('href');
  if (href === undefined) return false;
  const trimmed = href.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  if (skipHosts.size > 0) {
    try {
      const host = new URL(trimmed).host.toLowerCase();
      if (skipHosts.has(host)) return false;
    } catch {
      // unparseable href: fall through and treat as trackable, matching the pre-existing
      // (pre-skipHosts) behaviour rather than silently dropping the link.
    }
  }
  return true;
}

function anchorLabel($: CheerioRoot, el: Parameters<CheerioRoot>[0]): string | null {
  const text = $(el).text().trim();
  if (text.length === 0) return null;
  return text.length > 120 ? text.slice(0, 120) : text;
}

function normalizeSkipHosts(opts: LinkFilterOptions): Set<string> {
  return new Set([...(opts.skipHosts ?? [])].map((h) => h.toLowerCase()));
}

/**
 * Loads `html` in fragment mode (`isDocument = false`) so a partial document is never rewrapped
 * into a full `<html><head></head><body>...</body></html>` document - the parser only introduces
 * those elements when asked to treat the input as a full document (finding #14).
 */
function loadFragment(html: string): CheerioRoot {
  return cheerio.load(html, null, false);
}

/** Finds trackable http(s) anchors in document order (skips mailto/tel/#/data:, data-no-track). */
export function collectLinks(html: string, opts: LinkFilterOptions = {}): RewriteLinkTarget[] {
  const skipHosts = normalizeSkipHosts(opts);
  const $ = loadFragment(html);
  const targets: RewriteLinkTarget[] = [];
  let position = 0;
  $('a[href]').each((_, el) => {
    if (!isTrackableAnchor($, el, skipHosts)) return;
    const href = ($(el).attr('href') as string).trim();
    targets.push({ url: href, label: anchorLabel($, el), position });
    position += 1;
  });
  return targets;
}

/**
 * Rewrites trackable anchor hrefs. `map` returns the replacement href, or null to leave the link
 * untouched (byte-identical). Non-http(s) links, [data-no-track], anchors inside <style>/<script>,
 * and links whose host is in `opts.skipHosts` are never passed to `map`.
 */
export function rewriteLinks(
  html: string,
  map: (t: RewriteLinkTarget) => string | null,
  opts: LinkFilterOptions = {},
): string {
  const skipHosts = normalizeSkipHosts(opts);
  const $ = loadFragment(html);
  let position = 0;
  $('a[href]').each((_, el) => {
    if (!isTrackableAnchor($, el, skipHosts)) return;
    const href = ($(el).attr('href') as string).trim();
    const target: RewriteLinkTarget = { url: href, label: anchorLabel($, el), position };
    position += 1;
    const replacement = map(target);
    if (replacement !== null) {
      $(el).attr('href', replacement);
    }
  });
  return $.html();
}

const SAFE_HREF_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'cid:']);

/**
 * docs/08_phase4_spec.md §2.3: after rendering a campaign body, every `href`/`src` must be one of
 * http:/https:/mailto:/cid: - a `javascript:`/`data:` URL smuggled in via a CSV cell is a hard
 * failure for that row, not a sent message. Relative/protocol-relative and unparseable URLs are
 * accepted (they can't carry a script scheme) but a bare `//host/x` is resolved against a dummy
 * base first so `javascript:` disguised as `//javascript:alert(1)` is still caught.
 */
export function assertSafeHrefs(html: string): void {
  const $ = loadFragment(html);
  const offenders: string[] = [];
  $('[href], [src]').each((_, el) => {
    const $el = $(el);
    for (const attr of ['href', 'src'] as const) {
      const value = $el.attr(attr);
      if (value === undefined) continue;
      const trimmed = value.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
      let scheme: string | null = null;
      try {
        scheme = new URL(trimmed, 'http://openpost.invalid/').protocol;
      } catch {
        scheme = null;
      }
      if (scheme !== null && !SAFE_HREF_SCHEMES.has(scheme)) {
        offenders.push(`${attr}="${trimmed.slice(0, 80)}"`);
      }
    }
  });
  if (offenders.length > 0) {
    throw new Error(`unsafe href/src scheme in rendered body: ${offenders.join(', ')}`);
  }
}

const BLOCK_SELECTOR =
  'p, div, li, tr, h1, h2, h3, h4, h5, h6, blockquote, section, article, header, footer, table, ul, ol, hr';

/**
 * Renders HTML as plain text: block-level elements and <br> become newlines, links render as
 * "label <original-url>", entities are decoded, whitespace is collapsed, and the result ends with
 * a single trailing newline.
 */
export function htmlToText(html: string): string {
  const $ = loadFragment(html);
  $('script, style').remove();
  $('br').replaceWith('\n');

  $('a[href]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href');
    if (href === undefined) return;
    const label = $el.text().trim();
    const rendered = label.length > 0 ? `${label} <${href}>` : `<${href}>`;
    $el.text(rendered);
  });

  $(BLOCK_SELECTOR).each((_, el) => {
    $(el).before('\n').after('\n');
  });

  const raw = $.root().text();
  const lines = raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim());

  let text = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  text = text.replace(/^\n+/, '').replace(/\n+$/, '');
  return `${text}\n`;
}

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// docs/09_phase5_spec.md §2.4: only http(s) schemes; trailing sentence punctuation and an unmatched
// closing paren are excluded from the URL itself (so "see https://x.example/y." links to
// https://x.example/y, not .../y.").
const BARE_URL_RE = /https?:\/\/[^\s<>"']+/gi;
const TRAILING_PUNCT_RE = /[.,;:!?)]+$/;

function trimTrailingPunctuation(url: string): string {
  let out = url;
  for (;;) {
    const match = TRAILING_PUNCT_RE.exec(out);
    if (!match) return out;
    const candidate = out.slice(0, match.index);
    // A closing paren with no matching opener in the URL is treated as trailing prose punctuation
    // ("(see https://example.com/x)") rather than part of the URL; a balanced paren is kept.
    if (out.endsWith(')') && (candidate.match(/\(/g)?.length ?? 0) >= (candidate.match(/\)/g)?.length ?? 0) + 1) {
      return out;
    }
    out = candidate;
    if (out.length === 0) return out;
  }
}

/**
 * Turns bare `http(s)://` URLs in already-escaped plain text into `<a href>` elements. The input
 * MUST already be HTML-escaped (this function never escapes anything itself) so a body containing
 * literal `<a href=x>` text is inert - it is escaped first, then this only ever matches inside the
 * resulting text, never re-parses markup back into a live tag (§2.4, tested cases 372-373).
 */
export function linkifyText(escapedText: string): string {
  return escapedText.replace(BARE_URL_RE, (match) => {
    const url = trimTrailingPunctuation(match);
    if (url.length === 0) return match;
    const trailer = match.slice(url.length);
    // The URL text itself is already escaped (it came from escaped input, and a raw URL contains no
    // HTML-significant characters worth re-escaping); the href attribute value needs its own
    // quote-escaping independent of that.
    const hrefValue = url.replace(/"/g, '&quot;');
    return `<a href="${hrefValue}">${url}</a>${trailer}`;
  });
}

/**
 * Plain text -> a minimal HTML document: escape, linkify bare URLs, then wrap each blank-line-
 * separated paragraph in `<p>` (single newlines inside a paragraph become `<br>`). This is the
 * `html` argument `runSend` receives from the mobile compose form (§2.4) - deterministic, no
 * WYSIWYG/contenteditable sanitiser, and real `<a href>` elements so click tracking (`collectLinks`/
 * `rewriteLinks`) applies exactly as it does to any other HTML body.
 */
export function textToHtml(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized.length === 0) {
    return '<html><body></body></html>';
  }
  const paragraphs = normalized.split(/\n{2,}/).map((para) => {
    const escaped = escapeHtmlText(para);
    const linked = linkifyText(escaped);
    return `<p>${linked.replace(/\n/g, '<br>')}</p>`;
  });
  return `<html><body>${paragraphs.join('\n')}</body></html>`;
}
