/**
 * docs/09_phase5_spec.md §2.3: `runSend` is the actual send pipeline, extracted verbatim from
 * `src/cli/commands/send.ts`'s commander action (its full per-recipient/single-mode semantics,
 * suppression handling and self-copy back-fill) so `POST /dashboard/compose/send` gets the real
 * pipeline instead of a reduced mobile mode. `src/cli/commands/send.ts` keeps its option parsing,
 * file reads and `--json`/human printing, and calls this. Golden-file/CLI-driving integration tests
 * (`tests/integration/send-dryrun.test.ts`, `recipient-semantics.test.ts`) assert this extraction
 * did not change behaviour - if it had, those tests would fail, not a new one.
 */
import type { AppConfig } from '../config/env.js';
import { htmlToText, injectPixel, rewriteLinks, collectLinks } from '../core/html.js';
import { newId } from '../core/ids.js';
import { clickUrl, newCacheBuster, optOutUrl, pixelUrl, signToken } from '../core/token.js';
import type { DB } from '../db/index.js';
import {
  addClickToken,
  addLink,
  addRecipient,
  audit,
  createMessage,
  ensureAccount,
  isSuppressed,
  markMessageDryrun,
  markMessageFailed,
  markMessageSent,
  markRecipientSent,
  setMute,
} from '../db/repo.js';
import { buildMime, type MimeAddress } from './mime.js';
import { connectImap } from './imap.js';
import type { DryRunTransport } from './dryrun.js';
import { resolveRefreshToken } from './oauth.js';
import { buildSendPlan, resolveRecipientMode, type AddressInput, type RecipientMode } from './recipients.js';
import { appendSentCopy, buildUntrackedMime, insertSentCopy } from './selfcopy.js';
import { resolveTransport } from './transport.js';
import { resolveAccount, resolveTransportForAccount } from './accounts.js';
import type { RecipientModeOption, TransportName } from '../types.js';

/**
 * Finding #11: `SELF_OPEN_STRATEGY=insert`'s config-time validation (env.ts) checks
 * `MAIL_TRANSPORT`, but `send --transport <name>` overrides the transport actually used for *this*
 * send without re-validating against it. `transportName` is that runtime transport - gmail's
 * `users.messages.send` always writes its own tracked Sent copy, so running `insert`/`imap-append`
 * on top of it would add a second, untracked one. Exported so this decision is unit-testable
 * without spinning up a real send.
 *
 * docs/07_recipient_semantics.md §6.2: dryrun is excluded too - it has no real Sent mailbox to
 * insert/append into, so `runSend` renders `${messageId}.sent.eml` directly via
 * `DryRunTransport.writeSentCopy` instead of calling this at all.
 */
export function shouldRunSelfCopy(args: {
  hasFirstSuccess: boolean;
  selfOpenStrategy: AppConfig['selfOpenStrategy'];
  transportName: TransportName;
  track: boolean;
  recipientCount: number;
}): boolean {
  return (
    args.hasFirstSuccess &&
    args.selfOpenStrategy !== 'window' &&
    args.transportName !== 'gmail' &&
    args.transportName !== 'dryrun' &&
    args.track &&
    args.recipientCount > 0
  );
}

export interface RecipientResult {
  email: string;
  kind: 'to' | 'cc' | 'bcc';
  suppressed: boolean;
  sent: boolean;
  /** docs/07_recipient_semantics.md §4.5: 'recipient' in per-recipient mode - this row's own open/
   *  click state is meaningful. 'message' in single mode - opens/clicks are only ever known at the
   *  message level, via the aggregate row. */
  attribution: 'recipient' | 'message';
  /** True for the single synthetic "(all recipients)" row single mode adds on top of every real
   *  addressee (§4.2). */
  isAggregate?: boolean;
  token?: string | undefined;
  pixelUrl?: string | undefined;
  pixelInjected?: boolean | undefined;
  optOutUrl?: string | undefined;
  clickUrls?: { url: string; clickUrl: string }[] | undefined;
  providerMessageId?: string | null | undefined;
  artifacts?: { htmlPath: string; emlPath: string } | undefined;
  error?: string | undefined;
}

export interface RunSendInput {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  text?: string | undefined;
  from?: string | undefined;
  /** Phase 5 addition: resolves sender identity (and, when set, transport/secrets) via
   *  `resolveAccount`/`resolveTransportForAccount` (`src/mail/accounts.ts`) instead of `--from`/
   *  `FROM_EMAIL`. Omitted by the CLI (which never had multi-account sender selection at the point
   *  this was extracted) and by the compose page when the operator has only one account. */
  fromAccountRef?: string | undefined;
  track: boolean;
  /** `undefined` = config default (`TRACK_CLICKS_DEFAULT`). */
  trackClicks: boolean | undefined;
  optOutLink: boolean;
  mute: boolean;
  /** `undefined` = config default (`MAIL_TRANSPORT`). */
  transport?: TransportName | undefined;
  /** `undefined` = config default (`RECIPIENT_MODE`). */
  recipientMode?: RecipientModeOption | undefined;
  outDir?: string | undefined;
  /** docs/09_phase5_spec.md §7.1: message provenance - defaults to 'cli' so every pre-Phase-5
   *  caller is unaffected. The compose route passes 'dashboard'. */
  source?: 'cli' | 'dashboard' | undefined;
}

export interface RunSendResult {
  messageId: string;
  mode: RecipientMode;
  transport: TransportName;
  recipients: RecipientResult[];
  errors: string[];
  singleSuppressedReason: string | null;
  selfCopy: { ok: boolean; strategy: string; error?: string } | null;
}

export interface RunSendDeps {
  db: DB;
  config: AppConfig;
  clock?: () => number;
}

function appendOptOutFooter(html: string, url: string): string {
  const footer = `<p style="font-size:11px;color:#888;"><a href="${url}">Unsubscribe from tracking</a></p>`;
  const bodyClose = /<\/body\s*>/i.exec(html);
  if (bodyClose && bodyClose.index !== undefined) {
    return html.slice(0, bodyClose.index) + footer + html.slice(bodyClose.index);
  }
  return html + footer;
}

interface RunSelfCopyArgs {
  config: AppConfig;
  fromEmail: string;
  sentCopy: { headerTo: MimeAddress[]; headerCc: MimeAddress[]; headerBcc: MimeAddress[] };
  subject: string;
  html: string;
  text: string;
  threadRootMessageId: string;
  date: Date;
}

async function runSelfCopy(args: RunSelfCopyArgs): Promise<{ ok: boolean; strategy: string; error?: string }> {
  const { config } = args;
  try {
    const untracked = await buildUntrackedMime({
      from: { email: args.fromEmail, name: config.fromName },
      to: args.sentCopy.headerTo,
      cc: args.sentCopy.headerCc,
      bcc: args.sentCopy.headerBcc,
      subject: args.subject,
      html: args.html,
      text: args.text,
      rfc822MessageId: args.threadRootMessageId,
      date: args.date,
    });

    if (config.selfOpenStrategy === 'insert') {
      const resolved = resolveRefreshToken(config, process.env);
      if (!resolved) {
        return { ok: false, strategy: 'insert', error: 'no Gmail refresh token available (run `openpost auth gmail`)' };
      }
      // Finding #30: dynamic import - this path only runs for SELF_OPEN_STRATEGY=insert, so a plain
      // send (or any other command) never pays for loading `googleapis` at all.
      const { google } = await import('googleapis');
      const auth = new google.auth.OAuth2(config.googleClientId, config.googleClientSecret);
      auth.setCredentials({ refresh_token: resolved.token });
      const client = google.gmail({ version: 'v1', auth });
      const result = await insertSentCopy(client, { untracked, sentAt: args.date.getTime() });
      return result.error !== undefined
        ? { ok: false, strategy: 'insert', error: result.error }
        : { ok: true, strategy: 'insert' };
    }

    // imap-append
    if (config.imapUser === undefined || config.imapPass === undefined) {
      return { ok: false, strategy: 'imap-append', error: 'IMAP_USER/IMAP_PASS not configured' };
    }
    const client = await connectImap({
      host: config.imapHost,
      port: config.imapPort,
      user: config.imapUser,
      pass: config.imapPass,
    });
    try {
      const result = await appendSentCopy(client, { untracked, sentAt: args.date.getTime() }, config.imapSentMailbox);
      return result.error !== undefined
        ? { ok: false, strategy: 'imap-append', error: result.error }
        : { ok: true, strategy: 'imap-append' };
    } finally {
      await client.logout().catch(() => undefined);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, strategy: config.selfOpenStrategy, error: message };
  }
}

/**
 * The real send pipeline - moved verbatim from `src/cli/commands/send.ts`'s commander action
 * (§2.3). Every recipient-mode, tracking, self-copy and suppression rule from docs/07's spec applies
 * exactly as it did before this extraction; only the option-parsing/printing shell around it moved.
 */
export async function runSend(deps: RunSendDeps, input: RunSendInput): Promise<RunSendResult> {
  const { db, config } = deps;

  let fromEmail: string;
  let fromName: string | undefined = config.fromName;
  let accountTransportOverride: TransportName | undefined;
  if (input.fromAccountRef !== undefined) {
    const account = resolveAccount(db, config, input.fromAccountRef);
    fromEmail = account.email;
    fromName = account.fromName ?? config.fromName;
    accountTransportOverride = account.transport;
    // Finding #15 (phase5.1): when BOTH `input.transport` and `input.fromAccountRef` are set, the
    // recorded/returned `transportName` used to be the input override while the actual `Transport`
    // object always came from `resolveTransportForAccount`, which forces `account.transport` - a
    // latent trap for any caller (e.g. compose, once finding #1 is fixed) that passes both. Make
    // them agree, or throw, in this one place rather than silently letting the two diverge.
    if (input.transport !== undefined && input.transport !== accountTransportOverride) {
      throw new Error(
        `transport "${input.transport}" does not match account "${input.fromAccountRef}"'s configured ` +
          `transport "${accountTransportOverride}" - pass only one, or make them agree`,
      );
    }
  } else {
    fromEmail = input.from ?? config.fromEmail ?? '';
  }
  if (!fromEmail) {
    throw new Error('no sender: pass --from or set FROM_EMAIL');
  }

  const htmlTemplate = input.html;
  // §4.3: the plain-text alternative always comes from the ORIGINAL template, never from the
  // click-rewritten HTML, so it keeps the original URLs.
  const finalTextTemplate = input.text ?? htmlToText(htmlTemplate);

  const transportName: TransportName = input.transport ?? accountTransportOverride ?? config.mailTransport;
  const effectiveConfig = { ...config, mailTransport: transportName, outDir: input.outDir ?? config.outDir, fromName };
  const transport =
    input.fromAccountRef !== undefined
      ? resolveTransportForAccount(resolveAccount(db, config, input.fromAccountRef), effectiveConfig)
      : resolveTransport(effectiveConfig);

  // §4.3: click tracking is on by default; --no-track-clicks is the only way to turn it off.
  const trackClicksEffective = input.trackClicks === false ? false : config.trackClicksDefault;

  const recipientInputs: AddressInput[] = [
    ...input.to.map((email) => ({ email, kind: 'to' as const })),
    ...input.cc.map((email) => ({ email, kind: 'cc' as const })),
    ...input.bcc.map((email) => ({ email, kind: 'bcc' as const })),
  ];
  if (recipientInputs.length === 0) {
    throw new Error('at least one recipient is required');
  }

  // docs/07_recipient_semantics.md §3.3: resolved once, up front - throws loudly (naming both
  // remedies) rather than silently downgrading or fanning out.
  const recipientModeOption: RecipientModeOption = input.recipientMode ?? config.recipientMode;
  const mode: RecipientMode = resolveRecipientMode(recipientModeOption, transportName, recipientInputs.length);
  if (recipientModeOption === 'auto' && mode === 'single' && transportName === 'gmail') {
    process.stderr.write(
      'note: RECIPIENT_MODE=auto resolved to single - MAIL_TRANSPORT=gmail has no per-recipient ' +
        'envelope override (users.messages.send derives delivery entirely from the submitted headers). ' +
        'Use --transport gmail-smtp for per-recipient CC-correct delivery.\n',
    );
  }

  // §3.4: single mode's all-or-nothing suppression check, computed over every addressee
  // BEFORE any token/row is created - if any one of them is suppressed or opted out, the
  // whole message goes out untracked rather than partially tracked.
  let singleSuppressedReason: string | null = null;
  if (mode === 'single') {
    const suppressedAddrs = recipientInputs.filter((r) => isSuppressed(db, r.email)).map((r) => r.email);
    if (suppressedAddrs.length > 0) {
      singleSuppressedReason = `${suppressedAddrs.length} of ${recipientInputs.length} addressee(s) suppressed/opted out (${suppressedAddrs.join(', ')})`;
    }
  }
  const effectiveTrackingEnabled = mode === 'single' && singleSuppressedReason !== null ? false : input.track;

  const account = ensureAccount(db, { email: fromEmail, displayName: fromName, transport: transportName });
  const sendDate = new Date();
  const message = createMessage(db, {
    accountId: account.id,
    subject: input.subject,
    bodyHtml: htmlTemplate,
    bodyText: finalTextTemplate,
    status: 'draft',
    trackingEnabled: effectiveTrackingEnabled,
    clickTrackingEnabled: trackClicksEffective,
    recipientMode: mode,
    source: input.source ?? 'cli',
  });
  if (input.mute) {
    setMute(db, { messageId: message.id, muted: true });
  }

  // §2.1/§6.1: HC-5 - Date computed once for the whole send, and the synthetic thread root
  // shared by every copy's References (and by the untracked Sent copy's own Message-ID).
  const plan = buildSendPlan({
    addresses: recipientInputs,
    mode,
    transport: transportName,
    messageId: message.id,
    fromEmail,
    now: sendDate.getTime(),
  });

  const secret = config.trackingSecret as string;
  const results: RecipientResult[] = [];
  let firstSuccess: { providerMessageId: string | null; threadId: string | null; rfc822MessageId: string; sentAt: number } | null = null;
  const errors: string[] = [];

  const trackingHost = new URL(config.trackingBaseUrl).host;

  if (mode === 'per-recipient') {
    for (const copy of plan.copies) {
      const email = copy.address as string;
      const kind = copy.kind as 'to' | 'cc' | 'bcc';
      const suppressed = isSuppressed(db, email);
      const rid = newId();
      const canTrack = input.track && !suppressed;
      // finding #16: generate the cache-buster once and persist it, so the pixel URL embedded
      // in the sent HTML and the one later reported by `show`/`/api` are the same URL.
      const cacheBuster = newCacheBuster();
      const pxUrl = pixelUrl(config.trackingBaseUrl, signToken('o', rid, secret), cacheBuster);
      let pixelInjected = false;

      // Recipient row created once, before either tracking branch (§7.2).
      const recipientRow = addRecipient(db, {
        messageId: message.id,
        email,
        kind,
        token: rid,
        cacheBuster,
        envelopeTo: copy.envelopeTo[0] ?? email,
      });

      let html = htmlTemplate;
      const clickUrls: { url: string; clickUrl: string }[] = [];

      if (trackClicksEffective && canTrack) {
        const targets = collectLinks(html, { skipHosts: [trackingHost] });
        for (const target of targets) {
          const link = addLink(db, {
            messageId: message.id,
            url: target.url,
            label: target.label,
            position: target.position,
          });
          const clickToken = addClickToken(db, { linkId: link.id, recipientId: recipientRow.id });
          const signedClick = signToken('c', clickToken.id, secret);
          const href = clickUrl(config.trackingBaseUrl, signedClick);
          clickUrls.push({ url: target.url, clickUrl: href });
        }
        html = rewriteLinks(
          html,
          (target) => {
            const match = clickUrls.find((c) => c.url === target.url);
            return match ? match.clickUrl : null;
          },
          { skipHosts: [trackingHost] },
        );
      }

      if (canTrack) {
        const injection = injectPixel(html, pxUrl);
        html = injection.html;
        pixelInjected = injection.injected;
        if (input.optOutLink) {
          html = appendOptOutFooter(html, optOutUrl(config.trackingBaseUrl, signToken('u', rid, secret)));
        }
      }

      const text = finalTextTemplate;

      try {
        // HC-1/HC-2: full To/Cc lists on every copy - identical across the whole send, never
        // Bcc (HC-3). Each copy gets its own auto Message-ID; every copy shares the same
        // References root (§2.1).
        const mime = await buildMime({
          from: { email: fromEmail, name: fromName },
          to: copy.headerTo,
          cc: copy.headerCc,
          subject: input.subject,
          html,
          text,
          date: plan.date,
          references: [plan.threadRootMessageId],
        });
        const sendResult = await transport.send(mime, {
          to: [email],
          subject: input.subject,
          html,
          messageId: message.id,
          recipientId: rid,
          envelopeFrom: fromEmail,
          envelopeTo: copy.envelopeTo,
          recipientMode: mode,
          recipientKind: kind,
          isAggregate: false,
        });
        firstSuccess ??= sendResult;
        markRecipientSent(db, recipientRow.id, {
          providerMsgId: sendResult.providerMessageId,
          threadId: sendResult.threadId,
          rfc822MsgId: sendResult.rfc822MessageId,
          sentAt: sendResult.sentAt,
        });

        results.push({
          email,
          kind,
          suppressed,
          sent: true,
          attribution: 'recipient',
          token: rid,
          // finding #7: only report a pixel URL when one was actually embedded - a message
          // whose body already contained an openpost-shaped pixel (e.g. a resend) is not
          // silently re-tracked with a second, uninjected URL presented as if it were live.
          pixelUrl: canTrack && pixelInjected ? pxUrl : undefined,
          pixelInjected: canTrack ? pixelInjected : undefined,
          optOutUrl: canTrack ? optOutUrl(config.trackingBaseUrl, signToken('u', rid, secret)) : undefined,
          clickUrls: clickUrls.length > 0 ? clickUrls : undefined,
          providerMessageId: sendResult.providerMessageId,
          artifacts: sendResult.artifacts,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${email}: ${msg}`);
        results.push({ email, kind, suppressed, sent: false, attribution: 'recipient', error: msg });
      }
    }
  } else {
    // single mode (§4.2): one row per addressee (own token, never embedded) plus exactly one
    // aggregate row carrying the pixel that actually goes in the body.
    const canTrackAggregate = input.track && singleSuppressedReason === null;
    const addresseeRows = recipientInputs.map((addr) => {
      const rid = newId();
      const cacheBuster = newCacheBuster();
      const row = addRecipient(db, {
        messageId: message.id,
        email: addr.email,
        kind: addr.kind,
        token: rid,
        cacheBuster,
        isAggregate: false,
      });
      return { input: addr, row, rid, suppressed: isSuppressed(db, addr.email) };
    });

    const aggRid = newId();
    const aggCacheBuster = newCacheBuster();
    const aggregateRow = addRecipient(db, {
      messageId: message.id,
      email: '(all recipients)',
      name: `${recipientInputs.length} recipients`,
      kind: 'to',
      token: aggRid,
      cacheBuster: aggCacheBuster,
      isAggregate: true,
    });

    const pxUrl = pixelUrl(config.trackingBaseUrl, signToken('o', aggRid, secret), aggCacheBuster);
    let html = htmlTemplate;
    const clickUrls: { url: string; clickUrl: string }[] = [];

    if (trackClicksEffective && canTrackAggregate) {
      const targets = collectLinks(html, { skipHosts: [trackingHost] });
      for (const target of targets) {
        const link = addLink(db, {
          messageId: message.id,
          url: target.url,
          label: target.label,
          position: target.position,
        });
        // Single mode's click tokens bind (link_id, aggregate_recipient_id) - §3.4.
        const clickToken = addClickToken(db, { linkId: link.id, recipientId: aggregateRow.id });
        const signedClick = signToken('c', clickToken.id, secret);
        const href = clickUrl(config.trackingBaseUrl, signedClick);
        clickUrls.push({ url: target.url, clickUrl: href });
      }
      html = rewriteLinks(
        html,
        (target) => {
          const match = clickUrls.find((c) => c.url === target.url);
          return match ? match.clickUrl : null;
        },
        { skipHosts: [trackingHost] },
      );
    }

    let pixelInjected = false;
    if (canTrackAggregate) {
      const injection = injectPixel(html, pxUrl);
      html = injection.html;
      pixelInjected = injection.injected;
      if (input.optOutLink) {
        html = appendOptOutFooter(html, optOutUrl(config.trackingBaseUrl, signToken('u', aggRid, secret)));
      }
    }

    const text = finalTextTemplate;
    const copy = plan.copies[0]!;

    try {
      const mime = await buildMime({
        from: { email: fromEmail, name: fromName },
        to: copy.headerTo,
        cc: copy.headerCc,
        // §3.2/§5.3: only ever non-empty for the documented gmail-API single-mode exception.
        bcc: copy.headerBcc,
        subject: input.subject,
        html,
        text,
        date: plan.date,
        references: [plan.threadRootMessageId],
      });
      const sendResult = await transport.send(mime, {
        to: recipientInputs.map((r) => r.email),
        subject: input.subject,
        html,
        messageId: message.id,
        recipientId: aggRid,
        envelopeFrom: fromEmail,
        envelopeTo: copy.envelopeTo,
        recipientMode: mode,
        isAggregate: true,
      });
      firstSuccess = sendResult;

      // §4.3: single mode stamps the SAME provider/thread/rfc822 ids on every row, aggregate
      // included - there is only ever one real submitted copy.
      const stampArgs = {
        providerMsgId: sendResult.providerMessageId,
        threadId: sendResult.threadId,
        rfc822MsgId: sendResult.rfc822MessageId,
        sentAt: sendResult.sentAt,
      };
      markRecipientSent(db, aggregateRow.id, stampArgs);
      for (const a of addresseeRows) {
        markRecipientSent(db, a.row.id, stampArgs);
      }

      for (const a of addresseeRows) {
        results.push({
          email: a.input.email,
          kind: a.input.kind,
          suppressed: a.suppressed,
          sent: true,
          attribution: 'message',
          token: a.rid,
        });
      }
      results.push({
        email: aggregateRow.email,
        kind: 'to',
        suppressed: singleSuppressedReason !== null,
        sent: true,
        attribution: 'message',
        isAggregate: true,
        token: aggRid,
        pixelUrl: canTrackAggregate && pixelInjected ? pxUrl : undefined,
        pixelInjected: canTrackAggregate ? pixelInjected : undefined,
        optOutUrl: canTrackAggregate ? optOutUrl(config.trackingBaseUrl, signToken('u', aggRid, secret)) : undefined,
        clickUrls: clickUrls.length > 0 ? clickUrls : undefined,
        providerMessageId: sendResult.providerMessageId,
        artifacts: sendResult.artifacts,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(msg);
      for (const a of addresseeRows) {
        results.push({ email: a.input.email, kind: a.input.kind, suppressed: a.suppressed, sent: false, attribution: 'message', error: msg });
      }
      results.push({
        email: aggregateRow.email,
        kind: 'to',
        suppressed: false,
        sent: false,
        attribution: 'message',
        isAggregate: true,
        error: msg,
      });
    }
  }

  if (firstSuccess) {
    // §4.3: for a per-recipient send with N>1, `messages.rfc822_msg_id` is the synthetic
    // thread root (also the Sent copy's own Message-ID) and provider/thread ids are NULL -
    // there is no single "the" provider id across N distinct copies. N=1 and single mode both
    // keep the one real copy's actual ids, exactly as before this change.
    const isMultiPerRecipient = mode === 'per-recipient' && recipientInputs.length > 1;
    const rfc822MsgId = isMultiPerRecipient ? plan.threadRootMessageId : firstSuccess.rfc822MessageId;
    const providerMsgId = isMultiPerRecipient ? null : firstSuccess.providerMessageId;
    const threadIdVal = isMultiPerRecipient ? null : firstSuccess.threadId;
    if (transportName === 'dryrun') {
      markMessageDryrun(db, message.id, { rfc822MsgId, sentAt: firstSuccess.sentAt });
    } else {
      markMessageSent(db, message.id, {
        providerMsgId,
        threadId: threadIdVal,
        rfc822MsgId,
        sentAt: firstSuccess.sentAt,
      });
    }
  } else {
    markMessageFailed(db, message.id, errors.join('; ') || 'unknown error');
  }

  // §4.2/§6.4: structural self-open elimination, once per message, after every copy has been
  // sent - never fails the send. dryrun has no real Sent mailbox, so it renders
  // `${messageId}.sent.eml` directly instead of going through insert/imap-append.
  let selfCopy: { ok: boolean; strategy: string; error?: string } | undefined;
  if (firstSuccess && transportName === 'dryrun' && config.selfOpenStrategy !== 'window' && input.track) {
    try {
      const untracked = await buildUntrackedMime({
        from: { email: fromEmail, name: fromName },
        to: plan.sentCopy.headerTo,
        cc: plan.sentCopy.headerCc,
        bcc: plan.sentCopy.headerBcc,
        subject: input.subject,
        html: htmlTemplate,
        text: finalTextTemplate,
        rfc822MessageId: plan.threadRootMessageId,
        date: plan.date,
      });
      const written = await (transport as DryRunTransport).writeSentCopy(untracked, message.id);
      selfCopy = { ok: true, strategy: 'dryrun-render' };
      audit(db, {
        actor: 'server',
        action: 'selfcopy.insert',
        subjectType: 'message',
        subjectId: message.id,
        detail: { strategy: 'dryrun-render', ok: true, path: written.path },
      });
    } catch (err) {
      const message_ = err instanceof Error ? err.message : String(err);
      selfCopy = { ok: false, strategy: 'dryrun-render', error: message_ };
      audit(db, {
        actor: 'server',
        action: 'selfcopy.failed',
        subjectType: 'message',
        subjectId: message.id,
        detail: { strategy: 'dryrun-render', ok: false, error: message_ },
      });
    }
  } else if (
    firstSuccess &&
    shouldRunSelfCopy({
      hasFirstSuccess: true,
      selfOpenStrategy: config.selfOpenStrategy,
      transportName,
      track: input.track,
      recipientCount: recipientInputs.length,
    })
  ) {
    selfCopy = await runSelfCopy({
      config,
      fromEmail,
      sentCopy: plan.sentCopy,
      subject: input.subject,
      html: htmlTemplate,
      text: finalTextTemplate,
      threadRootMessageId: plan.threadRootMessageId,
      date: plan.date,
    });
    audit(db, {
      actor: 'server',
      action: selfCopy.ok ? 'selfcopy.insert' : 'selfcopy.failed',
      subjectType: 'message',
      subjectId: message.id,
      detail: { strategy: selfCopy.strategy, ok: selfCopy.ok, error: selfCopy.error },
    });
  } else if (firstSuccess && config.selfOpenStrategy !== 'window' && transportName === 'gmail') {
    audit(db, {
      actor: 'server',
      action: 'selfcopy.skipped',
      subjectType: 'message',
      subjectId: message.id,
      detail: {
        strategy: config.selfOpenStrategy,
        reason: 'transport gmail already writes its own tracked Sent copy',
      },
    });
  }

  return {
    messageId: message.id,
    mode,
    transport: transportName,
    recipients: results,
    errors,
    singleSuppressedReason,
    selfCopy: selfCopy ?? null,
  };
}
