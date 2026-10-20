import type { MessageFilter, MessageSort } from '../../../db/repo.js';
import { RECIPIENT_STATES } from '../../../types.js';
import { attr, href, html, join, raw, type SafeHtml } from '../html.js';
import { messageRow, pager, type MessageRowModel } from '../fragments.js';

export interface MessagesPageModel {
  rows: MessageRowModel[];
  total: number;
  filter: MessageFilter;
  limit: number;
  offset: number;
  sort: MessageSort;
  nowMs: number;
}

const STATUS_OPTIONS = ['draft', 'sent', 'dryrun', 'failed', 'abandoned'];
const HAS_OPTIONS = ['opens', 'clicks', 'replies', 'none'];
const SORT_OPTIONS: Array<[MessageSort, string]> = [
  ['sent_desc', 'Sent (newest first)'],
  ['sent_asc', 'Sent (oldest first)'],
  ['opens_desc', 'Opens (most first)'],
];

function opt(value: string, selected: boolean, label = value): SafeHtml {
  return html`<option value="${attr(value)}" ${raw(selected ? 'selected' : '')}>${label}</option>`;
}

export function messagesPage(model: MessagesPageModel): SafeHtml {
  const qs = {
    q: model.filter.q,
    status: model.filter.status,
    state: model.filter.state,
    has: model.filter.has,
    since: model.filter.sinceMs,
    until: model.filter.untilMs,
    limit: model.limit,
    sort: model.sort,
  };
  const exportHref = (kind: 'csv' | 'json'): string => href(`/dashboard/export.${kind}`, qs);
  const filterActive =
    (model.filter.q ?? '') !== '' ||
    model.filter.status !== undefined ||
    model.filter.state !== undefined ||
    model.filter.has !== undefined ||
    model.filter.sinceMs !== undefined ||
    model.filter.untilMs !== undefined;

  return html`<h1>Messages</h1>
<details class="filter-form" ${raw(filterActive ? 'open' : '')}>
<summary>Filters</summary>
<form method="get" action="/dashboard/messages">
  <fieldset>
    <legend>Filter messages</legend>
    <div class="field"><label for="f-q">Search</label>
      <input id="f-q" type="search" name="q" maxlength="100" value="${attr(model.filter.q ?? '')}" placeholder="subject or recipient email"></div>
    <div class="field"><label for="f-status">Status</label>
      <select id="f-status" name="status">
        <option value="">any</option>
        ${join(STATUS_OPTIONS.map((s) => opt(s, model.filter.status === s)))}
      </select></div>
    <div class="field"><label for="f-state">Recipient state</label>
      <select id="f-state" name="state">
        <option value="">any</option>
        ${join(RECIPIENT_STATES.map((s) => opt(s, model.filter.state === s)))}
      </select></div>
    <div class="field"><label for="f-has">Has</label>
      <select id="f-has" name="has">
        <option value="">any</option>
        ${join(HAS_OPTIONS.map((s) => opt(s, model.filter.has === s)))}
      </select></div>
    <div class="field"><label for="f-since">Since</label>
      <input id="f-since" type="text" name="since" placeholder="7d or epoch ms" value="${attr(model.filter.sinceMs !== undefined ? String(model.filter.sinceMs) : '')}"></div>
    <div class="field"><label for="f-until">Until</label>
      <input id="f-until" type="text" name="until" placeholder="epoch ms" value="${attr(model.filter.untilMs !== undefined ? String(model.filter.untilMs) : '')}"></div>
    <div class="field"><label for="f-limit">Per page</label>
      <select id="f-limit" name="limit">${join([25, 50, 100].map((n) => opt(String(n), model.limit === n)))}</select></div>
    <div class="field"><label for="f-sort">Sort</label>
      <select id="f-sort" name="sort">${join(SORT_OPTIONS.map(([v, label]) => opt(v, model.sort === v, label)))}</select></div>
    <button type="submit">Apply filters</button>
  </fieldset>
</form>
</details>
<p class="export-links"><a href="${exportHref('csv')}">Export CSV</a> · <a href="${exportHref('json')}">Export JSON</a></p>
<div class="table-wrap">
<table id="message-list">
  <caption class="visually-hidden">Messages</caption>
  <thead><tr>
    <th scope="col">Sent</th><th scope="col">Subject</th><th scope="col">To</th>
    <th scope="col">State</th><th scope="col">Opens</th><th scope="col">Clicks</th>
    <th scope="col">Replied</th><th scope="col">Reminder</th>
  </tr></thead>
  <tbody>${join(model.rows.map((r) => messageRow(r)))}</tbody>
</table>
</div>
${model.rows.length === 0 ? html`<p class="note">No messages match these filters.</p>` : ''}
${pager({
  offset: model.offset,
  limit: model.limit,
  total: model.total,
  baseHref: '/dashboard/messages',
  extraParams: { q: model.filter.q, status: model.filter.status, state: model.filter.state, has: model.filter.has, since: model.filter.sinceMs, until: model.filter.untilMs, sort: model.sort },
})}`;
}
