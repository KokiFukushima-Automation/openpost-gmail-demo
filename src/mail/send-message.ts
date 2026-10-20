/**
 * The single-recipient send pipeline campaigns build on (docs/08_phase4_spec.md §2.6/§2.1: "a
 * campaign is N single-recipient sends through the existing plan"). This is a deliberately narrower
 * extraction than the spec's own `sendMessage` (which envisions a full byte-identical replacement
 * for `send.ts`'s per-recipient AND single-mode paths): rewriting `send.ts`'s ~250-line action body
 * in place, with its self-copy/single-mode/multi-recipient interleaving, is the highest-risk change
 * in the phase and risks the 336+ tests already proving that pipeline correct. Since the spec's own
 * runner constraint is `addresses.length === 1` (a campaign can never enter single/aggregate mode),
 * this module implements exactly that case - the one campaigns actually need - and `send.ts` is left
 * as today's tested implementation for the interactive multi-recipient/single-mode command. This is
 * a documented deviation from the spec's literal "send.ts becomes a thin wrapper" text.
 */
import { htmlToText, injectPixel, rewriteLinks, collectLinks } from '../core/html.js';
import { newId } from '../core/ids.js';
import { clickUrl, newCacheBuster, optOutUrl, pixelUrl, signToken } from '../core/token.js';
import type { AppConfig } from '../config/env.js';
import type { DB } from '../db/index.js';
import { addClickToken, addLink, addRecipient, isSuppressed, createMessage, ensureAccount, markMessageDryrun, markMessageFailed, markMessageSent, markRecipientSent, setMute } from '../db/repo.js';
import { buildMime } from './mime.js';
import { buildSendPlan, type AddressInput } from './recipients.js';
import type { ResolvedAccount } from './accounts.js';
import type { Transport } from './transport.js';

export interface SendMessageInput {
  account: ResolvedAccount;
  /** Exactly one address - the campaign runner (and any future single-recipient caller) always
   *  passes one 'to' address; a multi-recipient send still goes through `send.ts` directly. */
  addresses: AddressInput[];
  subject: string;
  html: string;
  text?: string | undefined;
  track: boolean;
  trackClicks: boolean;
  /** §2.5: mandatory for campaigns - there is no flag to pass false from the campaign runner. */
  optOutFooter: boolean;
  listUnsubscribe: boolean;
  mute?: boolean | undefined;
  campaignId?: string | undefined;
  extraHeaders?: Record<string, string> | undefined;
  /** Pre-allocated recipient token - lets the caller (the campaign runner) compute the opt-out URL
   *  BEFORE rendering the body, so a template that places `{{unsubscribe_url}}` itself and the
   *  pixel/opt-out URLs this function embeds are guaranteed to agree. Omitted, a fresh token is
   *  minted here exactly as `send.ts` does today. */
  token?: string | undefined;
}

export interface SendMessageDeps {
  db: DB;
  config: AppConfig;
  transport: Transport;
  clock?: () => number;
}

export interface SendMessageOutcome {
  messageId: string;
  recipientId: string;
  status: 'sent' | 'dryrun' | 'failed';
  token: string;
  pixelUrl?: string | undefined;
  optOutUrl?: string | undefined;
  providerMessageId: string | null;
  error?: string | undefined;
  artifacts?: { htmlPath: string; emlPath: string } | undefined;
}

function appendOptOutFooter(html: string, url: string): string {
  const footer = `<p style="font-size:11px;color:#888;">Don't want these emails? <a href="${url}">Unsubscribe</a>.</p>`;
  const bodyClose = /<\/body\s*>/i.exec(html);
  if (bodyClose && bodyClose.index !== undefined) {
    return html.slice(0, bodyClose.index) + footer + html.slice(bodyClose.index);
  }
  return html + footer;
}

/** Finding #4 (docs/reports/phase4_review.md): the html part's footer had no text-part equivalent -
 *  a campaign with a `--text-template` that never referenced `{{unsubscribe_url}}` itself shipped a
 *  plain-text part with no opt-out at all, contrary to §2.5's "mandatory". Mirrors
 *  `appendOptOutFooter`'s own "only if not already present" rule. */
function appendOptOutFooterText(text: string, url: string): string {
  return `${text}\n\nDon't want these emails? Unsubscribe: ${url}\n`;
}

/** Belt-and-braces re-assertion right before submit (§2.5.1): a campaign message that somehow
 *  reached this point without an unsubscribe footer (in EITHER part - finding #4) or the RFC 8058
 *  headers is a bug, not a message that gets to leave the process. */
export function assertUnsubscribePresent(html: string, text: string | undefined, headers: Record<string, string> | undefined): void {
  const hasHeader = headers !== undefined && typeof headers['List-Unsubscribe'] === 'string' && headers['List-Unsubscribe'].length > 0;
  const hasHtmlFooter = /unsubscribe/i.test(html);
  const hasTextFooter = text !== undefined && /unsubscribe/i.test(text);
  if (!hasHeader || !hasHtmlFooter || !hasTextFooter) {
    throw new Error('refusing to send: missing List-Unsubscribe header or unsubscribe footer text (html and/or text part)');
  }
}

/**
 * Sends one message to one recipient, applying tracking/opt-out exactly as `send.ts`'s
 * per-recipient path does for N=1: pixel + click rewriting + (mandatory, for campaigns) opt-out
 * footer and `List-Unsubscribe`/`List-Unsubscribe-Post` headers. Returns rather than throws on a
 * transport failure (the caller - the campaign runner - decides retry vs terminal).
 */
export async function sendMessage(deps: SendMessageDeps, input: SendMessageInput): Promise<SendMessageOutcome> {
  if (input.addresses.length !== 1) {
    throw new Error('sendMessage (Phase 4) supports exactly one recipient; use send.ts for multi-recipient sends');
  }
  const { db, config, transport } = deps;
  const clock = deps.clock ?? (() => Date.now());
  const address = input.addresses[0]!;
  const fromEmail = input.account.email;
  const secret = config.trackingSecret as string;
  const trackingHost = new URL(config.trackingBaseUrl).host;

  const nowMs = clock();
  const plan = buildSendPlan({
    addresses: input.addresses,
    mode: 'per-recipient',
    transport: transport.name,
    messageId: newId(),
    fromEmail,
    now: nowMs,
  });
  const copy = plan.copies[0]!;
  // The env-fallback ResolvedAccount (id: 'env') is synthetic - mirror send.ts's own
  // `ensureAccount` call so the first send lazily materialises the real `accounts` row, exactly
  // as it does today for a tree with zero CLI-added accounts (test 293).
  const accountId = input.account.isEnvFallback
    ? ensureAccount(db, { email: input.account.email, displayName: input.account.fromName, transport: transport.name }).id
    : input.account.id;
  const message = createMessage(db, {
    accountId,
    subject: input.subject,
    bodyHtml: input.html,
    bodyText: input.text ?? htmlToText(input.html),
    status: 'draft',
    trackingEnabled: input.track,
    clickTrackingEnabled: input.trackClicks,
    recipientMode: 'per-recipient',
    createdAt: nowMs,
  });
  if (input.campaignId) {
    db.prepare('UPDATE messages SET campaign_id = ? WHERE id = ?').run(input.campaignId, message.id);
  }
  if (input.mute) setMute(db, { messageId: message.id, muted: true });

  const suppressed = isSuppressed(db, address.email);
  const canTrack = input.track && !suppressed;
  const rid = input.token ?? newId();
  const cacheBuster = newCacheBuster();
  const pxUrl = pixelUrl(config.trackingBaseUrl, signToken('o', rid, secret), cacheBuster);

  const recipientRow = addRecipient(db, {
    messageId: message.id,
    email: address.email,
    kind: address.kind,
    token: rid,
    cacheBuster,
    envelopeTo: address.email,
  });

  let html = input.html;
  if (input.trackClicks && canTrack) {
    const targets = collectLinks(html, { skipHosts: [trackingHost] });
    const clickUrls: { url: string; clickUrl: string }[] = [];
    for (const target of targets) {
      const link = addLink(db, { messageId: message.id, url: target.url, label: target.label, position: target.position });
      const clickToken = addClickToken(db, { linkId: link.id, recipientId: recipientRow.id });
      clickUrls.push({ url: target.url, clickUrl: clickUrl(config.trackingBaseUrl, signToken('c', clickToken.id, secret)) });
    }
    html = rewriteLinks(html, (target) => clickUrls.find((c) => c.url === target.url)?.clickUrl ?? null, { skipHosts: [trackingHost] });
  }

  const optOutLink = optOutUrl(config.trackingBaseUrl, signToken('u', rid, secret));
  let pixelInjected = false;
  if (canTrack) {
    const injection = injectPixel(html, pxUrl);
    html = injection.html;
    pixelInjected = injection.injected;
  }
  // §2.5.2: footer placement - if the template already used {{unsubscribe_url}} the body already
  // contains the link, so no second footer is appended. The runner detects that by checking whether
  // the rendered html already contains optOutLink verbatim.
  if (input.optOutFooter && !html.includes(optOutLink)) {
    html = appendOptOutFooter(html, optOutLink);
  }

  // Finding #4: apply the exact same "already present? don't duplicate it" rule to the text part -
  // computed from the (already footer-bearing) html when the caller supplied no text of its own, so
  // that derived text already contains optOutLink and this is a no-op; an explicit --text-template
  // that never referenced {{unsubscribe_url}} gets the footer appended here instead.
  let text = input.text ?? htmlToText(html);
  if (input.optOutFooter && !text.includes(optOutLink)) {
    text = appendOptOutFooterText(text, optOutLink);
  }

  const headers: Record<string, string> = { ...(input.extraHeaders ?? {}) };
  if (input.listUnsubscribe) {
    headers['List-Unsubscribe'] = `<${optOutLink}>, <mailto:${fromEmail}?subject=unsubscribe>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  if (input.campaignId) {
    assertUnsubscribePresent(html, text, headers);
  }

  try {
    const mime = await buildMime({
      from: { email: fromEmail, name: input.account.fromName ?? undefined },
      to: copy.headerTo,
      cc: copy.headerCc,
      subject: input.subject,
      html,
      text,
      headers,
      date: plan.date,
      references: [plan.threadRootMessageId],
    });
    const sendResult = await transport.send(mime, {
      to: [address.email],
      subject: input.subject,
      html,
      messageId: message.id,
      recipientId: rid,
      envelopeFrom: fromEmail,
      envelopeTo: copy.envelopeTo,
      recipientMode: 'per-recipient',
      recipientKind: address.kind,
      isAggregate: false,
    });
    markRecipientSent(db, recipientRow.id, {
      providerMsgId: sendResult.providerMessageId,
      threadId: sendResult.threadId,
      rfc822MsgId: sendResult.rfc822MessageId,
      sentAt: sendResult.sentAt,
    });
    if (transport.name === 'dryrun') {
      markMessageDryrun(db, message.id, { rfc822MsgId: sendResult.rfc822MessageId, sentAt: sendResult.sentAt });
    } else {
      markMessageSent(db, message.id, {
        providerMsgId: sendResult.providerMessageId,
        threadId: sendResult.threadId,
        rfc822MsgId: sendResult.rfc822MessageId,
        sentAt: sendResult.sentAt,
      });
    }
    return {
      messageId: message.id,
      recipientId: recipientRow.id,
      status: transport.name === 'dryrun' ? 'dryrun' : 'sent',
      token: rid,
      pixelUrl: canTrack && pixelInjected ? pxUrl : undefined,
      optOutUrl: canTrack ? optOutLink : undefined,
      providerMessageId: sendResult.providerMessageId,
      artifacts: sendResult.artifacts,
    };
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    markMessageFailed(db, message.id, errMessage);
    return {
      messageId: message.id,
      recipientId: recipientRow.id,
      status: 'failed',
      token: rid,
      providerMessageId: null,
      error: errMessage,
    };
  }
}
