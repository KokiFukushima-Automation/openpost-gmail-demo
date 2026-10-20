import type { DB } from '../db/index.js';
import { listRecipientsForExport, type ExportRow, type MessageFilter } from '../db/repo.js';

const EXPORT_COLUMNS = [
  'message_id',
  'sent_at',
  'subject',
  'recipient_id',
  'email',
  'kind',
  'state',
  'open_count',
  'machine_open_count',
  'first_open_at',
  'last_open_at',
  'click_count',
  'first_click_at',
  'replied_at',
  'opted_out_at',
  'time_to_open_ms',
  'thread_id',
  'status',
  'sent_at_iso',
  'is_aggregate',
  'recipient_mode',
] as const;

export interface ExportPresentedRow {
  message_id: string;
  sent_at: number | null;
  subject: string;
  recipient_id: string;
  email: string;
  kind: string;
  state: string;
  open_count: number;
  machine_open_count: number;
  first_open_at: number | null;
  last_open_at: number | null;
  click_count: number;
  first_click_at: number | null;
  replied_at: number | null;
  opted_out_at: number | null;
  time_to_open_ms: number | null;
  thread_id: string | null;
  status: string;
  sent_at_iso: string | null;
  /** docs/07_recipient_semantics.md §4.4: 1 for the single-mode aggregate row (`email` is the
   *  literal placeholder `(all recipients)`, never a real address), 0 for every addressee row. */
  is_aggregate: number;
  recipient_mode: string;
}

function toPresented(r: ExportRow): ExportPresentedRow {
  return {
    message_id: r.message_id,
    sent_at: r.sent_at,
    subject: r.subject,
    recipient_id: r.recipient_id,
    email: r.email,
    kind: r.kind,
    state: r.state,
    open_count: r.open_count,
    machine_open_count: r.machine_open_count,
    first_open_at: r.first_open_at,
    last_open_at: r.last_open_at,
    click_count: r.click_count,
    first_click_at: r.first_click_at,
    replied_at: r.replied_at,
    opted_out_at: r.opted_out_at,
    time_to_open_ms: r.first_open_at !== null && r.first_open_at >= r.eff_sent_at ? r.first_open_at - r.eff_sent_at : null,
    thread_id: r.thread_id,
    status: r.status,
    sent_at_iso: r.sent_at !== null ? new Date(r.sent_at).toISOString() : null,
    is_aggregate: r.is_aggregate,
    recipient_mode: r.recipient_mode,
  };
}

export interface ExportResult {
  rows: ExportPresentedRow[];
  overLimit: boolean;
}

/** One row per recipient, matching the same filter the list page uses (§2.8). `maxRows` caps the
 *  result; `overLimit` tells the route to respond 413 instead of streaming a partial export. */
export function exportRows(db: DB, filter: MessageFilter, maxRows: number): ExportResult {
  const rows = listRecipientsForExport(db, filter, maxRows + 1);
  if (rows.length > maxRows) {
    return { rows: rows.slice(0, maxRows).map(toPresented), overLimit: true };
  }
  return { rows: rows.map(toPresented), overLimit: false };
}

/** Cells starting with `= + - @` (or a tab/CR, which some spreadsheet apps also treat as formula
 *  triggers) are prefixed with `'` - RFC 4180 has nothing to say about formula injection, but every
 *  major spreadsheet app executes an unescaped leading `=`/`+`/`-`/`@` on import (§2.8). */
function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

/** RFC 4180 (CRLF line endings, `"` doubling), UTF-8 with a BOM (so Excel opens it correctly), and
 *  the formula-injection guard above. */
export function toCsv(rows: ExportPresentedRow[]): string {
  const header = EXPORT_COLUMNS.join(',');
  const lines = rows.map((row) => EXPORT_COLUMNS.map((col) => csvCell(cellToString((row as unknown as Record<string, unknown>)[col]))).join(','));
  const BOM = '﻿';
  return `${BOM}${[header, ...lines].join('\r\n')}\r\n`;
}

/** Same RFC-4180-plus-formula-guard shape as `toCsv`, generalised to an arbitrary column list -
 *  used by campaign rows export (§2.11's `rows.csv`), which has its own shape unrelated to
 *  `ExportPresentedRow`. */
export function toCsvGeneric(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const header = columns.join(',');
  const lines = rows.map((row) => columns.map((col) => csvCell(cellToString(row[col]))).join(','));
  const BOM = '﻿';
  return `${BOM}${[header, ...lines].join('\r\n')}\r\n`;
}
