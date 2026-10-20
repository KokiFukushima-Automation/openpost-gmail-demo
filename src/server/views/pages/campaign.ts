import type { CampaignRow, CampaignRowRow } from '../../../db/campaigns.js';
import type { CampaignReport } from '../../../db/campaign-stats.js';
import { attr, html, join, type SafeHtml } from '../html.js';
import { fmtPercent, fmtTime } from '../format.js';
import { progressBar, statTile } from '../charts.js';

export interface CampaignPageModel {
  campaign: CampaignRow;
  report: CampaignReport;
  rows: CampaignRowRow[];
  rowsStatusFilter: string;
  csrf: string;
  nowMs: number;
}

function actionForm(campaignId: string, action: 'pause' | 'resume' | 'cancel', label: string, csrf: string): SafeHtml {
  return html`<form method="post" action="/dashboard/actions/campaign" class="inline-form">
    <input type="hidden" name="id" value="${attr(campaignId)}">
    <input type="hidden" name="action" value="${action}">
    <input type="hidden" name="_csrf" value="${attr(csrf)}">
    <button type="submit">${label}</button>
  </form>`;
}

export function campaignPage(model: CampaignPageModel): SafeHtml {
  const { campaign, report } = model;
  const pending = report.pending + report.claimed;

  const actions: SafeHtml[] = [];
  if (campaign.status === 'running') {
    actions.push(actionForm(campaign.id, 'pause', 'Pause', model.csrf));
  }
  if (campaign.status === 'paused' || campaign.status === 'draft') {
    actions.push(actionForm(campaign.id, 'resume', campaign.status === 'draft' ? 'Start' : 'Resume', model.csrf));
  }
  if (campaign.status !== 'cancelled' && campaign.status !== 'completed') {
    actions.push(actionForm(campaign.id, 'cancel', 'Cancel', model.csrf));
  }

  return html`<h1>${campaign.name}</h1>
<p><a href="/dashboard/campaigns">&larr; Campaigns</a></p>
<p class="campaign-actions">${join(actions, ' ')}</p>
<div id="campaign-progress" hx-get="/dashboard/fragments/campaign/${campaign.id}" hx-trigger="every 5s" hx-swap="innerHTML">
  ${progressBar('Send progress', { sent: report.sent, skipped: report.skipped, failed: report.failed, pending })}
</div>
<div class="stat-tiles">
  ${statTile('Sent', String(report.sent))}
  ${statTile('Opened', String(report.opened), fmtPercent(report.openRate))}
  ${statTile('Clicked', String(report.clicked), fmtPercent(report.clickRate))}
  ${statTile('Replied', String(report.replied))}
  ${statTile('Skipped', String(report.skipped))}
  ${statTile('Failed', String(report.failed))}
</div>
${
  report.variants.length > 1
    ? html`<h2>Variants</h2>
<div class="table-wrap">
<table>
  <caption class="visually-hidden">Variant stats</caption>
  <thead><tr><th scope="col">Variant</th><th scope="col">Sent</th><th scope="col">Opened</th><th scope="col">Open rate</th><th scope="col">Clicked</th><th scope="col">Click rate</th></tr></thead>
  <tbody>${join(
    report.variants.map(
      (v) =>
        html`<tr><td data-label="Variant">${v.variant}</td><td data-label="Sent">${String(v.sent)}</td><td data-label="Opened">${String(v.opened)}</td><td data-label="Open rate">${fmtPercent(v.openRate)}</td><td data-label="Clicked">${String(v.clicked)}</td><td data-label="Click rate">${fmtPercent(v.clickRate)}</td></tr>`,
    ),
  )}</tbody>
</table>
</div>
${
  report.significance
    ? html`<p class="note">z = ${report.significance.z.toFixed(3)} (${report.significance.variantA} vs ${report.significance.variantB}) - ${report.significance.caveat}</p>`
    : ''
}`
    : ''
}
<h2>Rows</h2>
<p>
  <a href="/dashboard/campaigns/${campaign.id}?status=all">All</a> ·
  <a href="/dashboard/campaigns/${campaign.id}?status=sent">Sent</a> ·
  <a href="/dashboard/campaigns/${campaign.id}?status=skipped">Skipped</a> ·
  <a href="/dashboard/campaigns/${campaign.id}?status=failed">Failed</a> ·
  <a href="/dashboard/campaigns/${campaign.id}?status=pending">Pending</a> ·
  <a href="/dashboard/campaigns/${campaign.id}/rows.csv?status=${model.rowsStatusFilter}">Export CSV</a>
</p>
<div class="table-wrap">
<table id="campaign-rows">
  <caption class="visually-hidden">Campaign rows</caption>
  <thead><tr><th scope="col">#</th><th scope="col">Email</th><th scope="col">Variant</th><th scope="col">Status</th><th scope="col">Sent</th><th scope="col">Detail</th></tr></thead>
  <tbody>${join(
    model.rows.map(
      (r) => html`<tr>
        <td data-label="#">${String(r.row_index)}</td>
        <td data-label="Email">${r.email}</td>
        <td data-label="Variant">${r.variant}</td>
        <td data-label="Status"><span class="badge badge-${r.status}">${r.status}</span></td>
        <td data-label="Sent">${r.sent_at ? fmtTime(r.sent_at) : '-'}</td>
        <td data-label="Detail">${r.skip_reason ?? r.last_error ?? '-'}</td>
      </tr>`,
    ),
  )}</tbody>
</table>
</div>
${model.rows.length === 0 ? html`<p class="note">No rows match this filter.</p>` : ''}`;
}

export interface CampaignProgressFragmentModel {
  campaign: CampaignRow;
  report: CampaignReport;
}

/** The `hx-trigger="every 5s"` replacement target - valid standalone HTML on its own (test:
 *  "reflects a status change without a reload"). */
export function campaignProgressFragment(model: CampaignProgressFragmentModel): SafeHtml {
  const pending = model.report.pending + model.report.claimed;
  return html`${progressBar('Send progress', { sent: model.report.sent, skipped: model.report.skipped, failed: model.report.failed, pending })}
<p class="note">Status: ${model.campaign.status} · ${String(model.report.sent)} sent, ${String(model.report.opened)} opened</p>`;
}
