import type {
  ClassifyContext,
  ClickClassification,
  OpenClassification,
  OpenClassificationKind,
  OpenSignal,
  RecipientCounters,
  RecipientState,
} from '../types.js';

const BOT_UA_PATTERN =
  /\b(curl|wget|python-requests|Go-http-client|HeadlessChrome|bot|crawler|spider|preview|Slackbot|Proofpoint|Mimecast|Barracuda)\b/i;

// Operator-supplied SELF_UA_PATTERNS regexes run on every pixel/click hit. Capping the UA text
// they see bounds the work any single (possibly pathological) pattern can do per request, closing
// the ReDoS surface described in finding #8 - a crafted UA of unbounded length is the attacker's
// lever, not the pattern itself, so truncating removes the lever regardless of pattern content.
const SELF_UA_MAX_LEN = 512;

// Phase 1.1 amendment (finding #17): a missing/empty Accept header is common for real mail and
// image-loading clients (many never send one for an <img> fetch) and is deliberately NOT treated
// as "lacks an image type" - only an Accept header that is present but names no image type trips
// this branch of R6. See docs/04_phase1_spec.md "Phase 1.1 amendments".
function hasImageAccept(accept: string | null): boolean {
  if (accept === null || accept.trim() === '') return true;
  return /image\/\*|image\/(gif|png|jpeg|webp)|\*\/\*/i.test(accept);
}

function priorHadRuleMatch(ctx: ClassifyContext): boolean {
  return ctx.priorEvents.some((e) => e.classification !== 'human');
}

/**
 * Implements rules R0-R9 of doc 02 §5, in order, first terminal match wins. Pure, no I/O, no
 * Date.now() - all time comes from signal.occurredAt / ctx.sentAt.
 *
 * Phase 2 adds R6b (classifyClick, datacentre-IP click scanning) and R10 ("a counted click implies
 * a human open" - see docs/05_phase2_spec.md §4.3); R10 is not a branch here, it is applied by
 * `src/server/services/record.ts`'s click->open back-fill, which inserts a synthetic open event
 * with `reason: 'R10,implied_by_click'` rather than reclassifying anything this function returns.
 */
export function classifyOpen(signal: OpenSignal, ctx: ClassifyContext): OpenClassification {
  const cfg = ctx.config;

  // R0: opted out, or DNT/GPC when respected.
  if (ctx.optedOut) {
    return { classification: 'opt_out', confidence: 1, counted: false, reasons: ['R0'] };
  }
  if (cfg.respectDnt && signal.dnt) {
    return { classification: 'dnt', confidence: 1, counted: false, reasons: ['R0'] };
  }

  const sinceSentMs = ctx.sentAt === null ? null : signal.occurredAt - ctx.sentAt;

  // R1: within the send-window suppression period.
  if (sinceSentMs !== null && sinceSentMs < cfg.openIgnoreSeconds * 1000) {
    const classification = ctx.uaInfo.isGoogleProxy ? 'google_proxy_prefetch' : 'self_open';
    return { classification, confidence: 0.8, counted: false, reasons: ['R1'] };
  }

  // R2: Gmail proxy within the (longer) prefetch window. Phase 2 (§4.1): a shipped Google-proxy
  // CIDR hit is equally good evidence as the UA string, for the (rare) case a proxy fetch arrives
  // with a UA that doesn't match the GoogleImageProxy pattern.
  const googleProxySignal = ctx.uaInfo.isGoogleProxy || ctx.isGoogleProxyIp;
  if (googleProxySignal && sinceSentMs !== null && sinceSentMs < cfg.proxyPrefetchSeconds * 1000) {
    return {
      classification: 'google_proxy_prefetch',
      confidence: 0.7,
      counted: false,
      reasons: ['R2'],
    };
  }

  // R3: Gmail proxy fetch outside the prefetch window - the message was actually rendered.
  // Phase 2.1 amendment (finding #3): counted evidence requires the actual GoogleImageProxy UA, not
  // merely an IP that falls in a shipped Google-owned range. The IP-only signal above is real (it
  // suppresses a same-window prefetch at R2), but ranges like former goog.json GCP blocks host
  // arbitrary customer traffic - crediting *any* hit from one as a counted human open let an
  // attacker (or a misbehaving scanner sitting on GCP) mint counted opens with a bot-shaped UA that
  // never even reaches R6, since R3 used to fire first. See docs/05_phase2_spec.md's Phase 2.1
  // amendments.
  if (ctx.uaInfo.isGoogleProxy) {
    return { classification: 'human', confidence: 0.75, counted: true, reasons: ['R3'] };
  }

  // R4: Apple Mail Privacy Protection. Reason id stays 'R4'; when the IP branch fired (rather than
  // the Apple-Mail-UA branch), the marker 'apple_ip' is pushed alongside it so reports can
  // distinguish IP evidence from UA evidence (§4.1).
  const withinMppWindow =
    sinceSentMs !== null && sinceSentMs < cfg.mppWindowSeconds * 1000;
  const isFirstEvent = ctx.priorEvents.length === 0;
  if (ctx.isAppleRelayIp || (ctx.uaInfo.isAppleMail && isFirstEvent && withinMppWindow)) {
    const reasons = ctx.isAppleRelayIp ? ['R4', 'apple_ip'] : ['R4'];
    return { classification: 'apple_mpp', confidence: 0.9, counted: false, reasons };
  }

  // R5: sender fingerprint suppression.
  const truncatedUa = signal.ua !== null ? signal.ua.slice(0, SELF_UA_MAX_LEN) : null;
  const uaMatchesSelf =
    truncatedUa !== null && ctx.selfUaPatterns.some((re) => re.test(truncatedUa));
  if ((ctx.ipHash !== null && ctx.selfIpHashes.has(ctx.ipHash)) || uaMatchesSelf) {
    return { classification: 'self_open', confidence: 0.95, counted: false, reasons: ['R5'] };
  }

  // R6: bot/scanner UA, HEAD method, or an Accept header lacking any image type.
  if (
    (signal.ua !== null && BOT_UA_PATTERN.test(signal.ua)) ||
    ctx.uaInfo.isBot ||
    signal.method === 'HEAD' ||
    !hasImageAccept(signal.accept)
  ) {
    return { classification: 'bot', confidence: 0.9, counted: false, reasons: ['R6'] };
  }

  // R7: fanout from a single net across many distinct recipients - scanner infrastructure.
  if (ctx.fanoutCount > cfg.scannerFanout) {
    return { classification: 'bot', confidence: 0.8, counted: false, reasons: ['R7'] };
  }

  // R8: duplicate of a very recent event from the same (recipient, net, ua family).
  const dedupeWindowMs = cfg.dedupeSeconds * 1000;
  const isDuplicate = ctx.priorEvents.some(
    (e) =>
      e.ipNetHash === ctx.ipNetHash &&
      e.uaFamily === ctx.uaInfo.family &&
      signal.occurredAt - e.occurredAt < dedupeWindowMs &&
      signal.occurredAt - e.occurredAt >= 0,
  );
  if (isDuplicate) {
    return { classification: 'duplicate', confidence: 0.99, counted: false, reasons: ['R8'] };
  }

  // R9: otherwise, a genuine human open.
  const confidence = !isFirstEvent && !priorHadRuleMatch(ctx) ? 0.85 : 0.6;
  return { classification: 'human', confidence, counted: true, reasons: ['R9'] };
}

/** classifyClick reuses R0, R6 and R8; everything else defaults to a counted human click. */
export function classifyClick(signal: OpenSignal, ctx: ClassifyContext): ClickClassification {
  const cfg = ctx.config;

  if (ctx.optedOut) {
    return { classification: 'opt_out', confidence: 1, counted: false, reasons: ['R0'] };
  }
  if (cfg.respectDnt && signal.dnt) {
    return { classification: 'dnt', confidence: 1, counted: false, reasons: ['R0'] };
  }

  if (
    (signal.ua !== null && BOT_UA_PATTERN.test(signal.ua)) ||
    ctx.uaInfo.isBot ||
    signal.method === 'HEAD'
  ) {
    return { classification: 'scanner', confidence: 0.9, counted: false, reasons: ['R6'] };
  }

  // R6b (doc 02 §2.6): a click from a known datacentre egress range, with no counted open yet for
  // this recipient, is link-scanner infrastructure rather than a human click. Once a counted open
  // exists, the datacentre IP is no longer taken as scanner evidence on its own (a human can browse
  // from a VPN/cloud desktop after already having opened for real).
  if (ctx.isDatacenterIp && !ctx.hasCountedOpen) {
    return { classification: 'scanner', confidence: 0.85, counted: false, reasons: ['R6b'] };
  }

  const dedupeWindowMs = cfg.dedupeSeconds * 1000;
  const isDuplicate = ctx.priorEvents.some(
    (e) =>
      e.ipNetHash === ctx.ipNetHash &&
      e.uaFamily === ctx.uaInfo.family &&
      signal.occurredAt - e.occurredAt < dedupeWindowMs &&
      signal.occurredAt - e.occurredAt >= 0,
  );
  if (isDuplicate) {
    return { classification: 'duplicate', confidence: 0.99, counted: false, reasons: ['R8'] };
  }

  return { classification: 'human', confidence: 0.6, counted: true, reasons: ['R9'] };
}

/** Classification kinds that represent a machine having fetched the pixel (finding #15): proxy
 *  prefetch, MPP prefetch, a scanner/bot, or the sender's own fingerprint. `dnt`/`opt_out`/
 *  `duplicate` are neither a human open nor new machine activity worth surfacing, so they are
 *  deliberately excluded here. */
export const MACHINE_OPEN_KINDS: ReadonlySet<OpenClassificationKind> = new Set([
  'google_proxy_prefetch',
  'apple_mpp',
  'bot',
  'self_open',
]);

/** Every rule id this module (plus the click->open back-fill in `services/record.ts` and manual
 *  overrides) can emit - used by `views/format.ts`'s `RULE_DOC` and its own coverage test (Phase 3
 *  test 126) so a new rule can never ship without documentation. */
export const CLASSIFY_RULE_IDS: readonly string[] = [
  'R0',
  'R1',
  'R2',
  'R3',
  'R4',
  'apple_ip',
  'R5',
  'R6',
  'R6b',
  'R7',
  'R8',
  'R9',
  'R10',
  'implied_by_click',
  'manual',
];

export function deriveRecipientState(
  r: RecipientCounters,
  opts?: { repliedAt?: number | null },
): RecipientState {
  // Phase 3 (§4.4): a detected reply wins over every other signal - once a human has replied, no
  // later open/click/override may silently erase that fact by recomputing an "earlier" state. The
  // parameter is optional (and defaults to no reply) so every existing call site and test keeps
  // compiling and passing unchanged.
  if (opts?.repliedAt != null) {
    return 'replied';
  }
  // Finding #8: a counted click is, on its own, sufficient evidence of a human read (§4.3's R10) -
  // this must hold even when `openCount` is 0, which is possible after a manual reclassification
  // demotes the click that originally back-filled its implied open (deleteImpliedOpenForRecipient
  // removes that row once no other counted click remains to justify it - see db/repo.ts). Without
  // this check first, such a recipient fell all the way through to `not_opened` despite a counted
  // click still on record.
  if (r.clickCount > 0) {
    return 'read_confirmed';
  }
  if (r.openCount <= 0 && r.machineOpenCount <= 0) {
    return 'not_opened';
  }
  if (r.openCount <= 0) {
    return 'prefetched';
  }
  const spreadMs =
    r.firstOpenAt !== null && r.lastOpenAt !== null ? r.lastOpenAt - r.firstOpenAt : 0;
  const readConfirmed = r.openCount >= 2 && spreadMs > 60_000;
  return readConfirmed ? 'read_confirmed' : 'opened';
}
