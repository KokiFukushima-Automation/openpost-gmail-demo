import type { RecipientState } from '../../types.js';
import { attr, html, href, join, type SafeHtml } from './html.js';
import { confidenceBar, fmtRelative, fmtTime, RULE_DOC, stateBadge } from './format.js';
import { messageLevelPhrase } from '../../notify/channels/util.js';

export interface FlashMessage {
  kind: 'info' | 'error';
  text: string;
}

export function flash(model: FlashMessage | null | undefined): SafeHtml {
  if (!model) return html``;
  // Phase 3.1 (L2): plain interpolation (auto-escaped) rather than `raw()` - see stateBadge()'s
  // identical fix in format.ts for the rationale.
  return html`<p class="flash flash-${model.kind}" role="status">${model.text}</p>`;
}

export interface MessageRowModel {
  id: string;
  sentAt: number | null;
  subject: string;
  toEmails: string[];
  worstState: RecipientState;
  countedOpens: number;
  totalOpens: number;
  machineOpens: number;
  clicks: number;
  repliedCount: number;
  recipientCount: number;
  pendingReminder: boolean;
  nowMs: number;
  /** docs/09_phase5_spec.md §6.5: the message's own `status` - only ever rendered when
   *  'abandoned' (a Gmail add-on draft never confirmed sent); every other status is implied by the
   *  existing sent-at/state columns and is not repeated here. */
  status?: string;
}

/** One `<tr>` for the message list, and the live-replacement target for
 *  `/dashboard/fragments/message-row/:id` - carries `data-message-id` for `app.js`. */
export function messageRow(m: MessageRowModel): SafeHtml {
  const toLabel = m.toEmails.length > 1 ? `${m.toEmails[0]} +${m.toEmails.length - 1}` : (m.toEmails[0] ?? '(no recipients)');
  return html`<tr data-message-id="${attr(m.id)}">
  <td data-label="Sent"><span title="${fmtTime(m.sentAt)}">${fmtRelative(m.sentAt, m.nowMs)}</span></td>
  <td data-label="Subject"><a href="/dashboard/messages/${m.id}">${m.subject}</a></td>
  <td data-label="To">${toLabel}</td>
  <td data-label="State">${stateBadge(m.worstState)} ${m.status === 'abandoned' ? html`<span class="badge" title="drafted in Gmail, never confirmed sent">abandoned</span>` : ''}</td>
  <td data-label="Opens"><span title="${String(m.machineOpens)} machine opens">${String(m.countedOpens)} / ${String(m.totalOpens)}</span></td>
  <td data-label="Clicks">${String(m.clicks)}</td>
  <td data-label="Replied">${String(m.repliedCount)} / ${String(m.recipientCount)}</td>
  <td data-label="Reminder">${m.pendingReminder ? html`<span aria-hidden="true">⏰</span> pending` : ''}</td>
</tr>`;
}

export interface RecipientRowModel {
  id: string;
  messageId: string;
  email: string;
  kind: string;
  state: RecipientState;
  openCount: number;
  machineOpenCount: number;
  clickCount: number;
  repliedAt: number | null;
  pendingReminder: boolean;
  nowMs: number;
  /** docs/07_recipient_semantics.md §4.5: true for the single-mode aggregate row. */
  isAggregate?: boolean;
  /** True for every row (aggregate included) of a single-mode message - a real addressee row in
   *  single mode carries no individual tracking state at all. */
  isSingleMode?: boolean;
  /** Real addressee count for this message - only used (and only ever passed) when `isAggregate`. */
  recipientCount?: number | undefined;
}

/** One `<tr>` for a message's recipient summary table, and the live-replacement target for
 *  `/dashboard/fragments/recipient/:id`. The single-mode aggregate row renders as a distinct
 *  "message-level tracking" line rather than as if `email` were a real address (§4.5); a
 *  single-mode addressee row shows `state: -` / `tracking: message-level` instead of its own
 *  (always-zero) counters. */
export function recipientRow(r: RecipientRowModel): SafeHtml {
  if (r.isAggregate) {
    return html`<tr data-recipient-id="${attr(r.id)}" data-message-id="${attr(r.messageId)}" class="recipient-row-aggregate">
  <td data-label="Email">(message-level)</td>
  <td data-label="Kind">${r.kind}</td>
  <td data-label="State">${stateBadge(r.state)} <span class="note">${messageLevelPhrase(r.recipientCount ?? null)}</span></td>
  <td data-label="Opens"><span title="${String(r.machineOpenCount)} machine opens">${String(r.openCount)}</span></td>
  <td data-label="Clicks">${String(r.clickCount)}</td>
  <td data-label="Replied">-</td>
  <td data-label="Reminder">-</td>
</tr>`;
  }
  if (r.isSingleMode) {
    return html`<tr data-recipient-id="${attr(r.id)}" data-message-id="${attr(r.messageId)}">
  <td data-label="Email">${r.email}</td>
  <td data-label="Kind">${r.kind}</td>
  <td data-label="State">- <span class="note">tracking: message-level</span></td>
  <td data-label="Opens">-</td>
  <td data-label="Clicks">-</td>
  <td data-label="Replied">${r.repliedAt !== null ? fmtRelative(r.repliedAt, r.nowMs) : '-'}</td>
  <td data-label="Reminder">${r.pendingReminder ? html`<span aria-hidden="true">⏰</span> pending` : '-'}</td>
</tr>`;
  }
  return html`<tr data-recipient-id="${attr(r.id)}" data-message-id="${attr(r.messageId)}">
  <td data-label="Email">${r.email}</td>
  <td data-label="Kind">${r.kind}</td>
  <td data-label="State">${stateBadge(r.state)}</td>
  <td data-label="Opens"><span title="${String(r.machineOpenCount)} machine opens">${String(r.openCount)}</span></td>
  <td data-label="Clicks">${String(r.clickCount)}</td>
  <td data-label="Replied">${r.repliedAt !== null ? fmtRelative(r.repliedAt, r.nowMs) : '-'}</td>
  <td data-label="Reminder">${r.pendingReminder ? html`<span aria-hidden="true">⏰</span> pending` : '-'}</td>
</tr>`;
}

export interface EventItemModel {
  kind: 'open' | 'click';
  id: string;
  occurredAt: number;
  classification: string;
  confidence: number;
  counted: boolean;
  reasons: string[];
  uaFamily: string | null;
  deviceType: string | null;
  linkUrl: string | null;
  overridden: boolean;
  originalClassification: string | null;
  validClassifications: readonly string[];
  csrf: string;
  nowMs: number;
}

/** The override disclosure: **click 1** opens it (`<details>`), **click 2** is the classification
 *  button that POSTs `/dashboard/actions/reclassify` (DoD 2, two clicks). */
export function overrideForm(m: EventItemModel): SafeHtml {
  const options = m.validClassifications
    .filter((c) => c !== m.classification)
    .map((c) => html`<button type="submit" name="classification" value="${attr(c)}" class="btn btn-override">Override to ${c}</button>`);
  return html`<details class="override">
  <summary>Override classification</summary>
  <form method="post" action="/dashboard/actions/reclassify" class="override-form" hx-post="/dashboard/actions/reclassify" hx-target="closest li" hx-swap="outerHTML">
    <input type="hidden" name="kind" value="${attr(m.kind)}">
    <input type="hidden" name="eventId" value="${attr(m.id)}">
    <input type="hidden" name="_csrf" value="${attr(m.csrf)}">
    <label for="note-${attr(m.id)}">Note (optional)</label>
    <input id="note-${attr(m.id)}" type="text" name="note" maxlength="500">
    <div class="override-actions">${join(options)}</div>
  </form>
</details>`;
}

/** One event `<li>` in a recipient's timeline - also the post-override swap target
 *  (`/dashboard/fragments/event/:kind/:id`, `hx-swap="outerHTML"`). */
export function eventItem(m: EventItemModel): SafeHtml {
  const ruleChips = m.reasons.map((r) => html`<code class="rule-chip" title="${attr(RULE_DOC[r] ?? r)}">${r}</code>`);
  return html`<li id="event-${attr(m.kind)}-${attr(m.id)}" data-event-id="${attr(m.id)}" data-event-kind="${attr(m.kind)}">
  <a href="/dashboard/events/${m.kind}/${m.id}"><time datetime="${new Date(m.occurredAt).toISOString()}">${fmtTime(m.occurredAt)}</time></a>
  <span class="event-kind">${m.kind}</span>
  <span class="event-classification">${m.classification}${m.counted ? '' : ' (not counted)'}</span>
  ${confidenceBar(m.confidence)}
  <span class="rule-chips">${join(ruleChips, ' ')}</span>
  ${m.uaFamily ? html`<span class="ua-family">${m.uaFamily}</span>` : ''}
  ${m.deviceType ? html`<span class="device-type">${m.deviceType}</span>` : ''}
  ${m.linkUrl ? html`<span class="link-url">${m.linkUrl}</span>` : ''}
  ${m.overridden ? html`<span class="overridden-marker">overridden (was ${m.originalClassification ?? 'unknown'})</span>` : ''}
  ${overrideForm(m)}
</li>`;
}

export interface PagerModel {
  offset: number;
  limit: number;
  total: number;
  baseHref: string;
  extraParams: Record<string, string | number | boolean | undefined | null>;
}

/** `« Prev / page N of M / Next »`, preserving every other filter in the query string. */
export function pager(m: PagerModel): SafeHtml {
  const page = Math.floor(m.offset / m.limit) + 1;
  const pageCount = Math.max(1, Math.ceil(m.total / m.limit));
  const prevOffset = Math.max(0, m.offset - m.limit);
  const nextOffset = m.offset + m.limit;
  const hasPrev = m.offset > 0;
  const hasNext = nextOffset < m.total;
  return html`<nav class="pager" aria-label="Pagination">
  ${
    hasPrev
      ? html`<a href="${href(m.baseHref, { ...m.extraParams, limit: m.limit, offset: prevOffset })}">« Prev</a>`
      : html`<span aria-hidden="true">« Prev</span>`
  }
  <span>page ${String(page)} of ${String(pageCount)} (${String(m.total)} total)</span>
  ${
    hasNext
      ? html`<a href="${href(m.baseHref, { ...m.extraParams, limit: m.limit, offset: nextOffset })}">Next »</a>`
      : html`<span aria-hidden="true">Next »</span>`
  }
</nav>`;
}
