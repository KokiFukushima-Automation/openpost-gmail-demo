import type { AuditFilter } from '../../../db/repo.js';
import { attr, html, join, raw, type SafeHtml } from '../html.js';
import { fmtTime } from '../format.js';
import { pager } from '../fragments.js';

export interface AuditRowModel {
  id: string;
  at: number;
  actor: string;
  action: string;
  subjectType: string | null;
  subjectId: string | null;
  detail: unknown;
  reclassifyDiff: { before: string; after: string } | null;
}

export interface AuditPageModel {
  rows: AuditRowModel[];
  total: number;
  filter: AuditFilter;
  limit: number;
  offset: number;
  distinctActions: string[];
}

function detailBlock(row: AuditRowModel): SafeHtml {
  if (row.reclassifyDiff) {
    return html`<p class="reclassify-diff"><code>${row.reclassifyDiff.before}</code> → <code>${row.reclassifyDiff.after}</code></p>`;
  }
  if (row.detail === undefined || row.detail === null) return html``;
  return html`<details><summary>Detail</summary><pre>${JSON.stringify(row.detail, null, 2)}</pre></details>`;
}

export function auditPage(model: AuditPageModel): SafeHtml {
  const filterActive = (model.filter.action ?? '') !== '' || (model.filter.subject ?? '') !== '' || model.filter.sinceMs !== undefined;
  return html`<h1>Audit log</h1>
<p class="note">Audit rows never contain raw email addresses, IP addresses or tokens.</p>
<details class="filter-form" ${raw(filterActive ? 'open' : '')}>
<summary>Filters</summary>
<form method="get" action="/dashboard/audit">
  <fieldset>
    <legend>Filter audit log</legend>
    <div class="field"><label for="a-action">Action</label>
      <input id="a-action" name="action" list="audit-actions" value="${attr(model.filter.action ?? '')}">
      <datalist id="audit-actions">${join(model.distinctActions.map((a) => html`<option value="${attr(a)}">`))}</datalist></div>
    <div class="field"><label for="a-subject">Subject id</label>
      <input id="a-subject" name="subject" value="${attr(model.filter.subject ?? '')}"></div>
    <div class="field"><label for="a-since">Since</label>
      <input id="a-since" name="since" placeholder="7d or epoch ms" value="${attr(model.filter.sinceMs !== undefined ? String(model.filter.sinceMs) : '')}"></div>
    <button type="submit">Apply filters</button>
  </fieldset>
</form>
</details>
<div class="table-wrap">
<table id="audit-log">
  <caption class="visually-hidden">Audit log</caption>
  <thead><tr><th scope="col">Time</th><th scope="col">Actor</th><th scope="col">Action</th><th scope="col">Subject</th><th scope="col">Detail</th></tr></thead>
  <tbody>${join(
    model.rows.map(
      (r) => html`<tr>
        <td data-label="Time">${fmtTime(r.at)}</td>
        <td data-label="Actor">${r.actor}</td>
        <td data-label="Action">${r.action}</td>
        <td data-label="Subject">${r.subjectType ?? '-'} ${r.subjectId ?? ''}</td>
        <td data-label="Detail">${detailBlock(r)}</td>
      </tr>`,
    ),
  )}</tbody>
</table>
</div>
${pager({ offset: model.offset, limit: model.limit, total: model.total, baseHref: '/dashboard/audit', extraParams: { action: model.filter.action, subject: model.filter.subject, since: model.filter.sinceMs } })}`;
}
