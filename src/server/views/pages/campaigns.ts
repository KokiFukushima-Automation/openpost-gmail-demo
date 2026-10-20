import type { CampaignRow } from '../../../db/campaigns.js';
import { attr, html, join, type SafeHtml } from '../html.js';
import { fmtPercent, fmtRelative } from '../format.js';
import { progressBar } from '../charts.js';

export interface CampaignListModel {
  campaigns: Array<{ row: CampaignRow; sent: number; opened: number; skipped: number; failed: number; pending: number; claimed: number }>;
  nowMs: number;
}

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

export function campaignsPage(model: CampaignListModel): SafeHtml {
  return html`<h1>Campaigns</h1>
<p><a href="/dashboard/messages">&larr; Messages</a></p>
<div class="table-wrap">
<table id="campaigns-list">
  <caption class="visually-hidden">Campaigns</caption>
  <thead><tr>
    <th scope="col">Name</th><th scope="col">Status</th><th scope="col">Progress</th>
    <th scope="col">Sent / Total</th><th scope="col">Open rate</th><th scope="col">Created</th>
  </tr></thead>
  <tbody>${join(
    model.campaigns.map((c) => {
      const total = c.row.total_rows;
      const openRate = c.sent > 0 ? c.opened / c.sent : 0;
      return html`<tr data-campaign-id="${attr(c.row.id)}">
        <td data-label="Name"><a href="/dashboard/campaigns/${c.row.id}">${c.row.name}</a></td>
        <td data-label="Status"><span class="badge badge-${c.row.status}">${STATUS_LABEL[c.row.status] ?? c.row.status}</span></td>
        <td data-label="Progress">${progressBar(`${c.row.name} progress`, { sent: c.sent, skipped: c.skipped, failed: c.failed, pending: c.pending + c.claimed })}</td>
        <td data-label="Sent / Total">${String(c.sent)} / ${String(total)}</td>
        <td data-label="Open rate">${fmtPercent(openRate)}</td>
        <td data-label="Created">${fmtRelative(c.row.created_at, model.nowMs)}</td>
      </tr>`;
    }),
  )}</tbody>
</table>
</div>
${model.campaigns.length === 0 ? html`<p class="note">No campaigns yet - create one with <code>openpost campaign create</code>.</p>` : ''}`;
}
