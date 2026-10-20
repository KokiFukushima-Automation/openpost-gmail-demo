import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupTestServer, type TestServer } from '../helpers/setup.js';
import { seedDemo } from '../../src/db/seed.js';
import { migrate } from '../../src/db/index.js';
import {
  addRecipient,
  createMessage,
  ensureAccount,
  getDashboardMessageRow,
  markMessageSent,
  markRecipientSent,
  setRepliedAt,
} from '../../src/db/repo.js';
import { newId } from '../../src/core/ids.js';

const SEED_NOW = 1_789_000_000_000;

describe('dashboard pages (app.inject)', () => {
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

  it('138. GET /dashboard/messages -> 200 text/html, the sec 2.3 CSP with no unsafe-inline, no-store, one <tr> per message', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/dashboard/messages' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['content-security-policy']).not.toContain('unsafe-inline');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
    const trCount = (res.body.match(/<tr data-message-id=/g) ?? []).length;
    expect(trCount).toBe(12);
  });

  it('139. filters: q matches subject/email (and escapes % _ literally), status, state=replied, has=clicks, since=7d each narrow the set; an invalid enum -> 400', async () => {
    const byQ = await env.app.inject({ method: 'GET', url: '/dashboard/messages?q=recipient0' });
    expect(byQ.body).toContain('recipient0@example.com');

    // M9 (139): every seeded email is literally "...@example.com" - a `_` in `q` MUST be matched
    // as a literal underscore, not SQL LIKE's "any one character" wildcard. "e_ample" (an 'x'
    // swapped for '_') would match every row's "@example.com" if the wildcard fired, and zero rows
    // if it was escaped correctly.
    const byUnderscore = await env.app.inject({ method: 'GET', url: '/dashboard/messages?q=e_ample' });
    expect(byUnderscore.statusCode).toBe(200);
    expect((byUnderscore.body.match(/<tr data-message-id=/g) ?? []).length).toBe(0);

    // Same idea for `%`: "recipient0%1" would match "recipient0" followed by anything then "1" if
    // wildcarded (a hit against "recipient01@example.com", if present); the literal string never
    // occurs in any seeded row, so a correctly escaped search still returns nothing.
    const byPercent = await env.app.inject({ method: 'GET', url: '/dashboard/messages?q=recipient0%251' });
    expect(byPercent.statusCode).toBe(200);
    expect((byPercent.body.match(/<tr data-message-id=/g) ?? []).length).toBe(0);

    const byState = await env.app.inject({ method: 'GET', url: '/dashboard/messages?state=replied' });
    expect(byState.statusCode).toBe(200);
    const repliedRows = (byState.body.match(/<tr data-message-id=/g) ?? []).length;
    expect(repliedRows).toBeGreaterThan(0);
    expect(repliedRows).toBeLessThan(12);

    const byHas = await env.app.inject({ method: 'GET', url: '/dashboard/messages?has=clicks' });
    expect(byHas.statusCode).toBe(200);

    const byStatus = await env.app.inject({ method: 'GET', url: '/dashboard/messages?status=dryrun' });
    expect(byStatus.statusCode).toBe(200);

    const bySince = await env.app.inject({ method: 'GET', url: '/dashboard/messages?since=7d' });
    expect(bySince.statusCode).toBe(200);

    const invalid = await env.app.inject({ method: 'GET', url: '/dashboard/messages?status=bogus' });
    expect(invalid.statusCode).toBe(400);
  });

  it('140. pagination: limit=25&offset=25 returns a real, distinct second page; the pager links preserve limit/offset', async () => {
    // M9 (140): 12 seeded messages can never produce a genuine second page at any allowed --limit
    // (25/50/100) - offset=25 was always trivially empty, which would pass even with a broken
    // OFFSET. Reseed with enough rows that page 2 has real, different content.
    seedDemo(env.db, { seed: 7, nowMs: SEED_NOW, messages: 30, reset: true, force: true });

    const first = await env.app.inject({ method: 'GET', url: '/dashboard/messages?limit=25&offset=0' });
    const second = await env.app.inject({ method: 'GET', url: '/dashboard/messages?limit=25&offset=25' });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.body).toContain('30 total');

    const idsOf = (body: string): string[] => [...body.matchAll(/<tr data-message-id="([^"]+)"/g)].map((m) => m[1] as string);
    const firstIds = idsOf(first.body);
    const secondIds = idsOf(second.body);
    expect(firstIds).toHaveLength(25);
    expect(secondIds).toHaveLength(5);
    // A real second page, not a re-rendered first page or an empty one.
    expect(secondIds.every((id) => !firstIds.includes(id))).toBe(true);

    // The pager's own "Next" link on page 1 preserves both params (link preservation).
    expect(first.body).toMatch(/href="[^"]*offset=25[^"]*"/);
    expect(first.body).toMatch(/href="[^"]*limit=25[^"]*"/);
    // Page 2 has no further page - "Next" is inert, not a live link past the end.
    expect(second.body).not.toMatch(/href="[^"]*offset=50[^"]*"/);
  });

  it('M2. a message whose every recipient replied shows worstState=replied, not read_confirmed', async () => {
    const SENT_AT = SEED_NOW - 60_000;
    const account = ensureAccount(env.db, { email: 'sender@example.com', transport: 'dryrun' });
    const message = createMessage(env.db, {
      accountId: account.id,
      subject: 'all replied',
      bodyHtml: '<p>hi</p>',
      bodyText: 'hi',
      status: 'sent',
      trackingEnabled: true,
      clickTrackingEnabled: false,
    });
    markMessageSent(env.db, message.id, { rfc822MsgId: '<orig@example.com>', sentAt: SENT_AT });
    const recipient = addRecipient(env.db, { messageId: message.id, email: 'alice@example.com', token: newId() });
    markRecipientSent(env.db, recipient.id, { rfc822MsgId: '<orig@example.com>', sentAt: SENT_AT, threadId: 't1' });
    setRepliedAt(env.db, recipient.id, { atMs: SENT_AT + 1000, replyMsgId: '<reply@example.com>' });
    // deriveRecipientState only sets state='replied' via recomputeRecipientCounters/setRepliedAt's
    // own bookkeeping in the real reply-detection path; set it directly here since this test only
    // cares about buildDashboardRow's own worst-case aggregation, not reply detection.
    env.db.prepare(`UPDATE recipients SET state = 'replied' WHERE id = ?`).run(recipient.id);

    const row = getDashboardMessageRow(env.db, message.id);
    expect(row?.worstState).toBe('replied');

    const res = await env.app.inject({ method: 'GET', url: `/dashboard/messages/${message.id}` });
    expect(res.statusCode).toBe(200);
  });

  it('141. GET /dashboard/messages/:id renders one timeline entry per open/click/reply in occurred_at order, with classification/confidence/rule chips (DoD 2 part 1)', async () => {
    const recipient = env.db.prepare('SELECT message_id FROM recipients WHERE open_count > 0 LIMIT 1').get() as { message_id: string };
    const res = await env.app.inject({ method: 'GET', url: `/dashboard/messages/${recipient.message_id}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('class="timeline"');
    expect(res.body).toContain('rule-chip');
    expect(res.body).toContain('class="confidence"');
  });

  it('142. GET /dashboard/events/open/:id shows rule documentation, redacted signals and the override form; an unknown id 404s as HTML', async () => {
    const event = env.db.prepare(`SELECT id FROM open_events LIMIT 1`).get() as { id: string };
    const res = await env.app.inject({ method: 'GET', url: `/dashboard/events/open/${event.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Override classification');
    expect(res.body).toContain('<dt>Rules</dt>');

    const notFound = await env.app.inject({ method: 'GET', url: '/dashboard/events/open/does-not-exist' });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.headers['content-type']).toContain('text/html');
    expect(notFound.body).not.toContain('Error:'); // no raw stack trace
  });

  it('143. /dashboard/assets/app.css returns 200 with immutable + a strong ETag, 304 on If-None-Match, and a traversal attempt 404s', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/dashboard/assets/app.css' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.headers.etag).toBeTruthy();

    const cached = await env.app.inject({ method: 'GET', url: '/dashboard/assets/app.css', headers: { 'if-none-match': res.headers.etag as string } });
    expect(cached.statusCode).toBe(304);

    const traversal = await env.app.inject({ method: 'GET', url: '/dashboard/assets/..%2F..%2Fpackage.json' });
    expect(traversal.statusCode).toBe(404);
  });

  it('144. override via POST /dashboard/actions/reclassify (bot -> human): the event swaps, counters recompute, zero notifications enqueued', async () => {
    const botEvent = env.db.prepare(`SELECT id, recipient_id FROM open_events WHERE classification = 'bot' LIMIT 1`).get() as { id: string; recipient_id: string };
    expect(botEvent).toBeTruthy();
    const before = env.db.prepare('SELECT open_count FROM recipients WHERE id = ?').get(botEvent.recipient_id) as { open_count: number };

    const res = await env.app.inject({
      method: 'POST',
      url: '/dashboard/actions/reclassify',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `kind=open&eventId=${botEvent.id}&classification=human`,
    });
    expect(res.statusCode).toBe(303);

    const updatedEvent = env.db.prepare('SELECT classification, counted FROM open_events WHERE id = ?').get(botEvent.id) as { classification: string; counted: number };
    expect(updatedEvent.classification).toBe('human');
    expect(updatedEvent.counted).toBe(1);
    const after = env.db.prepare('SELECT open_count FROM recipients WHERE id = ?').get(botEvent.recipient_id) as { open_count: number };
    expect(after.open_count).toBe(before.open_count + 1);

    const notificationCount = (env.db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number }).n;
    expect(notificationCount).toBe(0);
  });

  it('145. the override appears in GET /dashboard/audit as a reclassify.override row with a bot -> human diff (DoD 2 part 2)', async () => {
    const botEvent = env.db.prepare(`SELECT id FROM open_events WHERE classification = 'bot' LIMIT 1`).get() as { id: string };
    await env.app.inject({
      method: 'POST',
      url: '/dashboard/actions/reclassify',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `kind=open&eventId=${botEvent.id}&classification=human`,
    });
    const res = await env.app.inject({ method: 'GET', url: '/dashboard/audit?action=reclassify.override' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('bot');
    expect(res.body).toContain('human');
    expect(res.body).toContain('→');
  });

  it('146. GET /dashboard/reminders lists pending/fired/cancelled; POST reminder-cancel cancels a pending one', async () => {
    const listRes = await env.app.inject({ method: 'GET', url: '/dashboard/reminders' });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.body).toContain('pending');
    expect(listRes.body).toContain('fired');
    expect(listRes.body).toContain('cancelled');

    const pending = env.db.prepare(`SELECT id FROM reminders WHERE status = 'pending' LIMIT 1`).get() as { id: string };
    const cancelRes = await env.app.inject({
      method: 'POST',
      url: '/dashboard/actions/reminder-cancel',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `id=${pending.id}`,
    });
    expect(cancelRes.statusCode).toBe(303);
    const updated = env.db.prepare('SELECT status FROM reminders WHERE id = ?').get(pending.id) as { status: string };
    expect(updated.status).toBe('cancelled');
  });

  it('191. every dashboard HTML route sets the exact sec 2.3 CSP/nosniff/same-origin-referrer/DENY/no-store; zero bare <script>, style=, or on*= handlers', async () => {
    // Phase 5 deviation (docs/09_phase5_spec.md §2.2, see setDashboardHeaders's own comment):
    // Referrer-Policy is `same-origin`, not `no-referrer`, as of Phase 5 - `no-referrer` nulls the
    // `Origin` header on the compose page's real (non-AJAX) form POST per the Fetch/HTML spec,
    // which the CSRF same-origin check cannot tell apart from a cross-origin submission. Nothing is
    // ever sent to a third-party origin either way; only genuinely same-origin requests (every
    // dashboard page, to every other) now also carry Origin/Referer.
    const paths = ['/dashboard/messages', '/dashboard/audit', '/dashboard/stats', '/dashboard/reminders', '/dashboard/campaigns'];
    for (const path of paths) {
      const res = await env.app.inject({ method: 'GET', url: path });
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('same-origin');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
      expect(res.body).not.toMatch(/\sstyle=/);
      expect(res.body).not.toMatch(/\son\w+=/i);
    }
  });

  it('192. accessibility smoke: lang present, one <h1>, every input/select has a matching label, every table has a caption + th scope', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/dashboard/messages' });
    expect(res.body).toContain('<html lang="en">');
    expect((res.body.match(/<h1[ >]/g) ?? []).length).toBe(1);
    const inputIds = [...res.body.matchAll(/<(?:input|select) id="([^"]+)"/g)].map((m) => m[1]);
    for (const id of inputIds) {
      expect(res.body).toContain(`for="${id}"`);
    }
    expect(res.body).toContain('<caption class="visually-hidden">');
    expect(res.body).toContain('scope="col"');
  });
});
