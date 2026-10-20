import type { RecipientState } from '../../types.js';
import { CLASSIFY_RULE_IDS } from '../../core/classify.js';
import { html, type SafeHtml } from './html.js';

export function fmtTime(ms: number | null): string {
  if (ms === null) return '-';
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

export function fmtRelative(ms: number | null, nowMs: number = Date.now()): string {
  if (ms === null) return '-';
  const deltaMs = nowMs - ms;
  const future = deltaMs < 0;
  const abs = Math.abs(deltaMs);
  const units: Array<[string, number]> = [
    ['y', 365 * 86_400_000],
    ['mo', 30 * 86_400_000],
    ['d', 86_400_000],
    ['h', 3_600_000],
    ['m', 60_000],
    ['s', 1000],
  ];
  for (const [suffix, unitMs] of units) {
    if (abs >= unitMs) {
      const n = Math.floor(abs / unitMs);
      return future ? `in ${n}${suffix}` : `${n}${suffix} ago`;
    }
  }
  return future ? 'in a moment' : 'just now';
}

export function fmtPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

const STATE_LABEL: Record<RecipientState, string> = {
  not_opened: 'Not opened',
  prefetched: 'Prefetched',
  opened: 'Opened',
  read_confirmed: 'Read confirmed',
  replied: 'Replied',
};

const STATE_ICON: Record<RecipientState, string> = {
  not_opened: '○',
  prefetched: '◐',
  opened: '●',
  read_confirmed: '✓',
  replied: '↩',
};

/** State is conveyed by text + shape, never colour alone (§2.7). Phase 3.1 (L2): plain
 *  interpolation (auto-escaped by `html`) rather than `raw()` - `state` is a typed enum today, but
 *  a page module should never need the unescaped-injection path for a value like this. */
export function stateBadge(state: RecipientState): SafeHtml {
  return html`<span class="badge badge-${state}"><span aria-hidden="true">${STATE_ICON[state]}</span> ${STATE_LABEL[state]}</span>`;
}

/** A `<meter>`-styled confidence bar with a numeric label alongside (never colour alone). */
export function confidenceBar(confidence: number): SafeHtml {
  const pct = Math.round(confidence * 100);
  return html`<span class="confidence"><meter min="0" max="1" value="${String(confidence)}" aria-label="confidence ${String(pct)}%"></meter> ${String(pct)}%</span>`;
}

/** One-line human explanations for every rule id the classifier (and the click->open back-fill,
 *  and a manual override) can emit - test 126 asserts this covers `CLASSIFY_RULE_IDS` exactly. */
export const RULE_DOC: Record<string, string> = {
  R0: 'Recipient opted out, or sent Do Not Track / Global Privacy Control and the server honours it.',
  R1: 'Inside the send-window suppression period - almost certainly an automated fetch, not a human.',
  R2: 'A Gmail image-proxy prefetch inside the (longer) prefetch window - Gmail fetched the image before the user opened the message.',
  R3: 'A Gmail image-proxy fetch outside the prefetch window - the message was actually rendered to a human.',
  R4: 'Apple Mail Privacy Protection pre-fetched the image - not evidence anyone read the message.',
  apple_ip: 'The request came from a shipped Apple private-relay IP range (evidence alongside or instead of the Apple Mail user-agent).',
  R5: 'Matched an operator-configured self-open fingerprint (IP hash or UA pattern) - almost certainly the sender re-opening their own message.',
  R6: 'Bot/scanner user-agent, a HEAD request, or an Accept header naming no image type.',
  R6b: 'A click from a known datacentre egress range with no prior counted open - link-scanner infrastructure, not a human.',
  R7: 'Fanout: many distinct recipients were seen from the same network in a short window - scanner infrastructure.',
  R8: 'A duplicate of a very recent event from the same recipient/network/user-agent family.',
  R9: 'No suppressing rule matched - treated as a genuine human open or click.',
  R10: 'A counted click implied a human read even though no pixel fetch was recorded (image blocking) - a synthetic open was back-filled.',
  implied_by_click: 'This open event was synthesised by the click->open back-fill (see R10), not fetched directly.',
  manual: 'An operator manually overrode the automatic classification.',
};

// Coverage self-check (fails fast, at import time, if RULE_DOC ever drifts from the classifier).
for (const id of CLASSIFY_RULE_IDS) {
  if (!(id in RULE_DOC)) {
    throw new Error(`views/format.ts: RULE_DOC is missing an entry for rule id "${id}"`);
  }
}
