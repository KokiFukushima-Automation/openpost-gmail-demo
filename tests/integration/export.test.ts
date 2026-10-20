import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupTestServer, type TestServer } from '../helpers/setup.js';
import { seedDemo } from '../../src/db/seed.js';
import { migrate } from '../../src/db/index.js';

const SEED_NOW = 1_789_000_000_000;

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** A tiny RFC-4180 parser (not a new dependency) used only to prove test 148's round-trip claim. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 2;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

describe('dashboard export', () => {
  let env: TestServer;

  beforeEach(() => {
    env = setupTestServer({ startAt: SEED_NOW });
    migrate(env.db);
    seedDemo(env.db, { seed: 7, nowMs: SEED_NOW, messages: 12, reset: false, force: false });
  });

  afterEach(async () => {
    await env.app.close();
    env.db.close();
  });

  it('147. export.csv honours the same filters as the list, emits CRLF + BOM + RFC-4180 quoting, one row per recipient', async () => {
    const recipientCount = (env.db.prepare('SELECT COUNT(*) AS n FROM recipients').get() as { n: number }).n;
    const res = await env.app.inject({ method: 'GET', url: '/dashboard/export.csv' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('openpost-export-');
    expect(res.rawPayload[0]).toBe(0xef); // UTF-8 BOM
    expect(res.body).toContain('\r\n');
    const rows = parseCsv(stripBom(res.body));
    expect(rows[0]?.[0]).toBe('message_id');
    // header + one row per recipient (a trailing blank row from the final CRLF is fine)
    expect(rows.filter((r) => r.length > 1)).toHaveLength(recipientCount + 1);

    const filtered = await env.app.inject({ method: 'GET', url: '/dashboard/export.csv?state=replied' });
    const filteredRows = parseCsv(stripBom(filtered.body)).filter((r) => r.length > 1);
    expect(filteredRows.length).toBeLessThan(rows.length);
    expect(filteredRows.length).toBeGreaterThan(1);
  });

  it('148. a formula-injection subject is prefixed with \' in CSV; embedded quotes/newlines round-trip through a reference parser', async () => {
    const account = env.db.prepare('SELECT id FROM accounts LIMIT 1').get() as { id: string };
    const { createMessage, addRecipient, markMessageSent } = await import('../../src/db/repo.js');
    const { newId } = await import('../../src/core/ids.js');
    const evilSubject = '=cmd|\' /c calc\'!A0';
    const message = createMessage(env.db, {
      accountId: account.id,
      subject: evilSubject,
      bodyHtml: null,
      bodyText: null,
      status: 'sent',
      trackingEnabled: true,
      clickTrackingEnabled: false,
    });
    markMessageSent(env.db, message.id, { rfc822MsgId: '<x@y>', sentAt: SEED_NOW });
    addRecipient(env.db, { messageId: message.id, email: 'quote"embed,and\nnewline@example.com', token: newId() });

    const res = await env.app.inject({ method: 'GET', url: '/dashboard/export.csv' });
    const body = stripBom(res.body);
    expect(body).toContain(`'${evilSubject}`);
    const rows = parseCsv(body);
    const dataRow = rows.find((r) => r[4]?.includes('embed'));
    expect(dataRow).toBeDefined();
    expect(dataRow?.[4]).toBe('quote"embed,and\nnewline@example.com');
  });

  it('149. .json matches the documented shape; over-limit -> 413 naming the variable; tokens appear in neither format', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/dashboard/export.json' });
    expect(res.statusCode).toBe(200);
    const parsed = res.json() as { generatedAt: number; filter: unknown; count: number; rows: unknown[] };
    expect(typeof parsed.generatedAt).toBe('number');
    expect(parsed.count).toBe(parsed.rows.length);

    // Simulate an over-limit filter via a tiny DASHBOARD_MAX_EXPORT_ROWS.
    const tinyEnv = setupTestServer({ startAt: SEED_NOW, configOverrides: { dashboardMaxExportRows: 1 } });
    migrate(tinyEnv.db);
    seedDemo(tinyEnv.db, { seed: 7, nowMs: SEED_NOW, messages: 12, reset: false, force: false });
    const overRes = await tinyEnv.app.inject({ method: 'GET', url: '/dashboard/export.json' });
    expect(overRes.statusCode).toBe(413);
    expect(JSON.stringify(overRes.json())).toContain('DASHBOARD_MAX_EXPORT_ROWS');
    await tinyEnv.app.close();
    tinyEnv.db.close();

    expect(JSON.stringify(res.json())).not.toMatch(/[01-9a-hjkmnp-tv-z]{26}\.[01-9a-hjkmnp-tv-z]{16}/); // no signed token shape
    const csvRes = await env.app.inject({ method: 'GET', url: '/dashboard/export.csv' });
    expect(csvRes.body).not.toContain('/o/1');
    expect(csvRes.body).not.toContain('/c/1');
  });

  it('L14. export row order is byte-stable across repeated calls, tiebreaking on recipient_id when sent_at and created_at both tie', async () => {
    const { createMessage, addRecipient, markMessageSent } = await import('../../src/db/repo.js');
    const { newId } = await import('../../src/core/ids.js');
    const account = env.db.prepare('SELECT id FROM accounts LIMIT 1').get() as { id: string };
    const message = createMessage(env.db, {
      accountId: account.id,
      subject: 'tiebreak',
      bodyHtml: null,
      bodyText: null,
      status: 'sent',
      trackingEnabled: true,
      clickTrackingEnabled: false,
    });
    markMessageSent(env.db, message.id, { rfc822MsgId: '<tie@example.com>', sentAt: SEED_NOW });
    const r1 = addRecipient(env.db, { messageId: message.id, email: 'tie1@example.com', token: newId() });
    const r2 = addRecipient(env.db, { messageId: message.id, email: 'tie2@example.com', token: newId() });
    // Force an exact tie on BOTH the primary sort key (sent_at, via message.sent_at fallback -
    // these recipients never got their own sent_at) and the first tiebreak (created_at) - only
    // recipient_id is left to break the tie.
    const SAME_CREATED_AT = SEED_NOW - 1000;
    env.db.prepare('UPDATE recipients SET created_at = ? WHERE id IN (?, ?)').run(SAME_CREATED_AT, r1.id, r2.id);

    const expectedOrder = [r1.id, r2.id].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const bodies: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await env.app.inject({ method: 'GET', url: '/dashboard/export.csv' });
      expect(res.statusCode).toBe(200);
      bodies.push(res.body);
    }
    // Byte-stable: three independent calls produce byte-identical output.
    expect(bodies[1]).toBe(bodies[0]);
    expect(bodies[2]).toBe(bodies[0]);

    const rows = parseCsv(stripBom(bodies[0] as string)).filter((r) => r.length > 1);
    const tieRows = rows.filter((r) => r[4] === 'tie1@example.com' || r[4] === 'tie2@example.com');
    expect(tieRows.map((r) => r[3])).toEqual(expectedOrder); // column 3 is recipient_id
  });
});
