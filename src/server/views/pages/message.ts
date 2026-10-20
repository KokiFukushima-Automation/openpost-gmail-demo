import { attr, html, join, type SafeHtml } from '../html.js';
import { eventItem, recipientRow, type EventItemModel, type RecipientRowModel } from '../fragments.js';
import { fmtRelative, fmtTime, stateBadge } from '../format.js';

export interface RecipientDetailModel {
  row: RecipientRowModel;
  sentAt: number | null;
  timeToOpenMs: number | null;
  threadId: string | null;
  rfc822MsgId: string | null;
  timeline: EventItemModel[];
  replyAt: number | null;
  replyMsgId: string | null;
  reminders: Array<{ id: string; condition: string; dueAt: number; status: string }>;
}

export interface MessagePageModel {
  id: string;
  subject: string;
  status: string;
  sentAt: number | null;
  createdAt: number;
  transport: string;
  selfCopyStrategy: string | null;
  muted: boolean;
  trackingEnabled: boolean;
  clickTrackingEnabled: boolean;
  recipients: RecipientDetailModel[];
  csrf: string;
  nowMs: number;
  /** docs/07_recipient_semantics.md §4.5: 'per-recipient' | 'single'. */
  recipientMode: string;
}

function timelineEntry(rd: RecipientDetailModel): SafeHtml {
  const extra: SafeHtml[] = [];
  if (rd.replyAt !== null) {
    extra.push(
      html`<li class="timeline-reply"><time datetime="${new Date(rd.replyAt).toISOString()}">${fmtTime(rd.replyAt)}</time> <span class="event-kind">reply</span> detected${rd.replyMsgId ? '' : ''}</li>`,
    );
  }
  for (const r of rd.reminders) {
    extra.push(
      html`<li class="timeline-reminder"><time datetime="${new Date(r.dueAt).toISOString()}">${fmtTime(r.dueAt)}</time> <span class="event-kind">reminder</span> ${r.condition} - <a href="/dashboard/reminders">${r.status}</a></li>`,
    );
  }
  const items = [...rd.timeline.map((e) => eventItem(e)), ...extra];
  if (items.length === 0) {
    return html`<p class="note">No events yet for this recipient.</p>`;
  }
  return html`<ol class="timeline">${join(items)}</ol>`;
}

function recipientSection(rd: RecipientDetailModel): SafeHtml {
  return html`<section class="recipient-detail" aria-labelledby="recip-${attr(rd.row.id)}-h">
  <h3 id="recip-${attr(rd.row.id)}-h">${rd.row.email}</h3>
  <p>${stateBadge(rd.row.state)} · sent ${fmtRelative(rd.sentAt, rd.row.nowMs)} (${fmtTime(rd.sentAt)})
     ${rd.timeToOpenMs !== null ? html` · time to first open: ${String(Math.round(rd.timeToOpenMs / 1000))}s` : ''}
     ${rd.replyAt !== null ? html` · replied ${fmtRelative(rd.replyAt, rd.row.nowMs)}` : ''}
     ${rd.threadId ? html` · thread <code>${rd.threadId}</code>` : ''}
  </p>
  ${timelineEntry(rd)}
</section>`;
}

export function messagePage(model: MessagePageModel): SafeHtml {
  return html`<h1>${model.subject}</h1>
<p class="message-meta">
  status: <strong>${model.status}</strong> ·
  sent: ${fmtTime(model.sentAt)} ·
  transport: ${model.transport}
  ${model.selfCopyStrategy ? html` · self-copy: ${model.selfCopyStrategy}` : ''}
  ${model.muted ? html` · <strong>muted</strong>` : ''}
</p>
${model.recipientMode === 'single'
  ? html`<p class="banner banner-info">Single-mode message: tracking is message-level. Every open/click below is attributed
  to the whole thread, never to one recipient - see the "(message-level)" row.</p>`
  : ''}
<form method="post" action="/dashboard/actions/mute" class="mute-form">
  <input type="hidden" name="messageId" value="${attr(model.id)}">
  <input type="hidden" name="_csrf" value="${attr(model.csrf)}">
  <input type="hidden" name="muted" value="${model.muted ? '0' : '1'}">
  <button type="submit">${model.muted ? 'Unmute this message' : 'Mute this message'}</button>
</form>
<div id="message-live-detail" data-live-message-id="${attr(model.id)}">
<div class="table-wrap">
<table id="recipient-summary">
  <caption class="visually-hidden">Recipients of ${model.subject}</caption>
  <thead><tr>
    <th scope="col">Email</th><th scope="col">Kind</th><th scope="col">State</th>
    <th scope="col">Opens</th><th scope="col">Clicks</th><th scope="col">Replied</th><th scope="col">Reminder</th>
  </tr></thead>
  <tbody>${join(model.recipients.map((r) => recipientRow(r.row)))}</tbody>
</table>
</div>
${join(model.recipients.map((r) => recipientSection(r)))}</div>`;
}
