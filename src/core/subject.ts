/**
 * Subject normalisation for thread lookup (docs/08_phase4_spec.md §6.2b). Pure, no I/O. Strips a
 * leading run of reply/forward prefixes (including a few non-English/CJK ones), unwraps a leading
 * `[list]` tag, collapses whitespace, NFKC-normalises and truncates to 200 chars.
 */

// Matches ONE leading prefix token, case-insensitively, optionally followed by "[n]"-style reply
// counters some clients add (kept simple: we only strip the label itself). Applied repeatedly so
// "Re: Fwd: RE: hello" collapses fully.
const PREFIX_RE = /^\s*(re|aw|rif|fwd|fw)\s*:\s*/i;
// CJK reply/forward prefixes seen in the wild (回复 = "reply", 转发 = "forward", full-width colon).
const CJK_PREFIX_RE = /^\s*(回复|转发|回覆|轉發)[:：]\s*/;
const LIST_TAG_RE = /^\s*\[[^\]\r\n]{1,40}\]\s*/;

export function normalizeSubject(subject: string): string {
  let s = subject.normalize('NFKC');
  // Strip stacked prefixes and list tags in any order until neither matches.
  for (let i = 0; i < 10; i++) {
    const before = s;
    s = s.replace(PREFIX_RE, '').replace(CJK_PREFIX_RE, '').replace(LIST_TAG_RE, '');
    if (s === before) break;
  }
  s = s.replace(/\s+/g, ' ').trim().toLowerCase();
  if (s.length > 200) s = s.slice(0, 200);
  return s;
}
