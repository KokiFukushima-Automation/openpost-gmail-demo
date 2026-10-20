import type { ReminderRow } from '../../../db/reminders.js';
import { attr, html, join, type SafeHtml } from '../html.js';
import { fmtRelative, fmtTime } from '../format.js';

export interface RemindersPageModel {
  rows: Array<ReminderRow & { messageSubject: string; recipientEmail: string | null }>;
  csrf: string;
  nowMs: number;
}

export function remindersPage(model: RemindersPageModel): SafeHtml {
  return html`<h1>Reminders</h1>
<div class="table-wrap">
<table id="reminders-list">
  <caption class="visually-hidden">Reminders</caption>
  <thead><tr>
    <th scope="col">Message</th><th scope="col">Recipient</th><th scope="col">Condition</th>
    <th scope="col">Due</th><th scope="col">Status</th><th scope="col">Draft</th><th scope="col">Action</th>
  </tr></thead>
  <tbody>${join(
    model.rows.map(
      (r) => html`<tr data-reminder-id="${attr(r.id)}">
        <td data-label="Message"><a href="/dashboard/messages/${r.message_id}">${r.messageSubject}</a></td>
        <td data-label="Recipient">${r.recipientEmail ?? '-'}</td>
        <td data-label="Condition">${r.condition}</td>
        <td data-label="Due" title="${fmtTime(r.due_at)}">${fmtRelative(r.due_at, model.nowMs)}</td>
        <td data-label="Status">${r.status}</td>
        <td data-label="Draft">${r.draft === 1 ? (r.draft_status ?? 'pending') : '-'}</td>
        <td data-label="Action">${
          r.status === 'pending'
            ? html`<form method="post" action="/dashboard/actions/reminder-cancel" class="inline-form">
                <input type="hidden" name="id" value="${attr(r.id)}">
                <input type="hidden" name="_csrf" value="${attr(model.csrf)}">
                <button type="submit">Cancel</button>
              </form>`
            : '-'
        }</td>
      </tr>`,
    ),
  )}</tbody>
</table>
</div>
${model.rows.length === 0 ? html`<p class="note">No reminders yet - create one with <code>openpost remind</code>.</p>` : ''}`;
}
