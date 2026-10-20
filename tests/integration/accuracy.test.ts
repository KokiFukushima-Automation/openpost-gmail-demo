import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../../src/db/index.js';
import { accuracyReport } from '../../src/db/report.js';
import { addLink, addRecipient, createMessage, ensureAccount, markMessageSent } from '../../src/db/repo.js';
import { newId } from '../../src/core/ids.js';
import { setupTestServer } from '../helpers/setup.js';
import { seedDemo } from '../../src/db/seed.js';

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const account = ensureAccount(db, { email: 's@example.com', transport: 'dryrun' });
  const message = createMessage(db, {
    accountId: account.id,
    subject: 's',
    bodyHtml: null,
    bodyText: null,
    status: 'sent',
    trackingEnabled: true,
    clickTrackingEnabled: true,
  });
  db.prepare('UPDATE messages SET sent_at = ? WHERE id = ?').run(0, message.id);
  const r1 = addRecipient(db, { messageId: message.id, email: 'a@example.com', token: 'a'.repeat(26) });
  const r2 = addRecipient(db, { messageId: message.id, email: 'b@example.com', token: 'b'.repeat(26) });
  const link = addLink(db, { messageId: message.id, url: 'https://example.com', label: null, position: 0 });

  db.prepare(
    `INSERT INTO open_events (id, recipient_id, occurred_at, classification, confidence, counted, reason, created_at)
     VALUES ('e1', ?, 1000, 'human', 0.9, 1, 'R9', 1000)`,
  ).run(r1.id);
  db.prepare(
    `INSERT INTO open_events (id, recipient_id, occurred_at, classification, confidence, counted, reason, created_at)
     VALUES ('e2', ?, 2_000_000, 'apple_mpp', 0.9, 0, 'R4,apple_ip', 2_000_000)`,
  ).run(r2.id);
  db.prepare(
    `INSERT INTO click_events (id, link_id, recipient_id, occurred_at, classification, confidence, counted, reason, created_at)
     VALUES ('c1', @linkId, @recipientId, 1500, 'human', 0.6, 1, 'R10,implied_by_click', 1500)`,
  ).run({ linkId: link.id, recipientId: r1.id });
  db.prepare(`UPDATE recipients SET open_count = 1, click_count = 1, state = 'read_confirmed' WHERE id = ?`).run(r1.id);
  db.prepare(`UPDATE recipients SET machine_open_count = 1, state = 'prefetched' WHERE id = ?`).run(r2.id);

  return db;
}

describe('accuracyReport (120c)', () => {
  it('rule counts match an independent SQL cross-check', () => {
    const db = seed();
    const report = accuracyReport(db, 0);

    expect(report.rules.R9).toBe(1);
    expect(report.rules.R4).toBe(1);
    expect(report.rules.apple_ip).toBe(1);
    expect(report.rules.R10).toBe(1);
    expect(report.rules.implied_by_click).toBe(1);

    // Independent cross-check: count 'R4' occurrences directly via SQL.
    const crossCheck = db
      .prepare(`SELECT COUNT(*) AS n FROM open_events WHERE ',' || reason || ',' LIKE '%,R4,%'`)
      .get() as { n: number };
    expect(crossCheck.n).toBe(report.rules.R4);

    expect(report.opens.total).toBe(2);
    expect(report.opens.counted).toBe(1);
    expect(report.opens.machine).toBe(1);
    expect(report.clicks.total).toBe(1);
    expect(report.recipients.total).toBe(2);
    expect(report.recipients.byState.read_confirmed).toBe(1);
    expect(report.recipients.byState.prefetched).toBe(1);
    expect(report.derived.backfilledOpens).toBe(0); // no open_events row itself has implied_by_click as an open

    db.close();
  });

  it('--since filters by time window', () => {
    const db = seed();
    const recent = accuracyReport(db, 1_500_000);
    expect(recent.opens.total).toBe(1); // only e2 at 2_000_000 qualifies
    expect(recent.rules.R4).toBe(1);
    expect(recent.rules.R9).toBeUndefined();
    db.close();
  });

  it('the JSON shape matches the documented AccuracyReport', () => {
    const db = seed();
    const report = accuracyReport(db, 0);
    expect(report).toHaveProperty('since');
    expect(report).toHaveProperty('generatedAt');
    expect(report).toHaveProperty('messages');
    expect(report).toHaveProperty('recipients.byState');
    expect(report).toHaveProperty('opens.byClassification');
    expect(report).toHaveProperty('clicks.byClassification');
    expect(report).toHaveProperty('rules');
    expect(report).toHaveProperty('derived.countedOpenRate');
    expect(report).toHaveProperty('notifications.sent');
    db.close();
  });

  it('157. GET /api/stats still contains every AccuracyReport field AND the new stats key; ?view=stats returns only the latter; an invalid tz -> 400', async () => {
    const env = setupTestServer({ startAt: 1_789_000_000_000 });
    migrate(env.db);
    seedDemo(env.db, { seed: 7, nowMs: 1_789_000_000_000, messages: 12, reset: false, force: false });

    const full = await env.app.inject({ method: 'GET', url: '/api/stats' });
    expect(full.statusCode).toBe(200);
    const fullBody = full.json();
    for (const key of ['since', 'generatedAt', 'messages', 'recipients', 'opens', 'clicks', 'rules', 'derived', 'notifications']) {
      expect(fullBody).toHaveProperty(key);
    }
    expect(fullBody).toHaveProperty('stats');
    expect(fullBody.stats).toHaveProperty('rates.openRate');
    expect(fullBody.stats).toHaveProperty('bestHour.peakHour');

    const statsOnly = await env.app.inject({ method: 'GET', url: '/api/stats?view=stats' });
    expect(statsOnly.statusCode).toBe(200);
    const statsOnlyBody = statsOnly.json();
    expect(Object.keys(statsOnlyBody)).toEqual(['stats']);

    const accuracyOnly = await env.app.inject({ method: 'GET', url: '/api/stats?view=accuracy' });
    expect(accuracyOnly.statusCode).toBe(200);
    expect(accuracyOnly.json()).not.toHaveProperty('stats');

    const badTz = await env.app.inject({ method: 'GET', url: '/api/stats?tz=Mars/Phobos' });
    expect(badTz.statusCode).toBe(400);

    await env.app.close();
    env.db.close();
  });

  it('M6. GET /api/stats and /dashboard/stats default to a bounded recent window (a years-old message is excluded by default, included with an explicit ?since=0)', async () => {
    const env = setupTestServer();
    migrate(env.db);
    const account = ensureAccount(env.db, { email: 'sender@example.com', transport: 'dryrun' });
    const ancientMessage = createMessage(env.db, {
      accountId: account.id,
      subject: 'ancient',
      bodyHtml: '<p>hi</p>',
      bodyText: 'hi',
      status: 'sent',
      trackingEnabled: true,
      clickTrackingEnabled: false,
    });
    // Five years before "now" - far outside any sane default (90d) or max (366d) window.
    const ancientSentAt = Date.now() - 5 * 365 * 86_400_000;
    markMessageSent(env.db, ancientMessage.id, { rfc822MsgId: '<ancient@example.com>', sentAt: ancientSentAt });
    addRecipient(env.db, { messageId: ancientMessage.id, email: 'old@example.com', token: newId() });

    const defaultView = await env.app.inject({ method: 'GET', url: '/api/stats?view=stats' });
    expect(defaultView.statusCode).toBe(200);
    expect(defaultView.json().stats.totals.recipients).toBe(0);
    // The default window is bounded, not all-time (`since` must be well after 1970).
    expect(defaultView.json().stats.since).toBeGreaterThan(Date.now() - 366 * 86_400_000);

    const explicitSince = await env.app.inject({ method: 'GET', url: '/api/stats?view=stats&since=0' });
    expect(explicitSince.statusCode).toBe(200);
    // Even with an explicit since=0, the window is capped at STATS_MAX_WINDOW_DAYS - a message
    // from 5 years ago still falls outside a (default) 366-day cap.
    expect(explicitSince.json().stats.totals.recipients).toBe(0);
    expect(explicitSince.json().stats.since).toBeGreaterThan(0);

    const dashboardStats = await env.app.inject({ method: 'GET', url: '/dashboard/stats' });
    expect(dashboardStats.statusCode).toBe(200);
    expect(dashboardStats.body).not.toContain('1970-01-01');

    await env.app.close();
    env.db.close();
  });
});
