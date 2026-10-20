import { describe, expect, it } from 'vitest';
import { setupTestServer, type TestServer } from '../helpers/setup.js';
import { runAddonReaperOnce } from '../../src/jobs/addon.js';

function addonHeaders(config: TestServer['config']): Record<string, string> {
  return { authorization: `Bearer ${config.apiToken}`, 'content-type': 'application/json' };
}

describe('Gmail add-on server half (docs/09_phase5_spec.md §6.4-§6.5)', () => {
  it('415. /api/addon/* are 404 with ADDON_ENABLED=false', async () => {
    const env = setupTestServer({ configOverrides: { addonEnabled: false, apiToken: 'tok' } });
    const res = await env.app.inject({ method: 'POST', url: '/api/addon/track', headers: addonHeaders(env.config), payload: JSON.stringify({ to: ['a@example.com'] }) });
    expect(res.statusCode).toBe(404);
    await env.app.close();
    env.db.close();
  });

  it('416. 401 without the bearer', async () => {
    const env = setupTestServer({ configOverrides: { addonEnabled: true, apiToken: 'tok' } });
    const res = await env.app.inject({ method: 'POST', url: '/api/addon/track', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ to: ['a@example.com'] }) });
    expect(res.statusCode).toBe(401);
    await env.app.close();
    env.db.close();
  });

  it('417. track creates addressee rows + exactly one aggregate row and returns a pixel URL whose token resolves to that aggregate row', async () => {
    const env = setupTestServer({ configOverrides: { addonEnabled: true, apiToken: 'tok' } });
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/addon/track',
      headers: addonHeaders(env.config),
      payload: JSON.stringify({ subject: 'Q3 numbers', to: ['a@example.com'], draftId: 'r-123' }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.pixelUrl).toMatch(/^https?:\/\//);
    expect(body.pixelHtml).toContain('<img');

    const recipients = env.db.prepare('SELECT email, is_aggregate FROM recipients WHERE message_id = ?').all(body.messageId) as Array<{ email: string; is_aggregate: number }>;
    expect(recipients).toHaveLength(2);
    expect(recipients.filter((r) => r.is_aggregate === 1)).toHaveLength(1);
    expect(recipients.filter((r) => r.is_aggregate === 0)).toHaveLength(1);

    const aggregate = env.db.prepare('SELECT token FROM recipients WHERE message_id = ? AND is_aggregate = 1').get(body.messageId) as { token: string };
    expect(aggregate.token).toBe(body.token);
    await env.app.close();
    env.db.close();
  });

  it('418. pixelHtml is well-formed and parses cleanly', async () => {
    const env = setupTestServer({ configOverrides: { addonEnabled: true, apiToken: 'tok' } });
    const res = await env.app.inject({ method: 'POST', url: '/api/addon/track', headers: addonHeaders(env.config), payload: JSON.stringify({ to: ['a@example.com'] }) });
    const body = JSON.parse(res.body);
    const cheerio = await import('cheerio');
    const $ = cheerio.load(body.pixelHtml);
    const img = $('img');
    expect(img.length).toBe(1);
    expect(img.attr('src')).toBe(body.pixelUrl);
    await env.app.close();
    env.db.close();
  });

  it('419. one suppressed addressee -> whole message untracked, suppressed:true, empty pixelHtml', async () => {
    const env = setupTestServer({ configOverrides: { addonEnabled: true, apiToken: 'tok' } });
    env.db.exec(`INSERT INTO suppressions (email, reason, created_at) VALUES ('bad@example.com', 'manual_block', 0)`);
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/addon/track',
      headers: addonHeaders(env.config),
      payload: JSON.stringify({ to: ['good@example.com', 'bad@example.com'] }),
    });
    const body = JSON.parse(res.body);
    expect(body.suppressed).toBe(true);
    expect(body.pixelHtml).toBe('');
    const message = env.db.prepare('SELECT tracking_enabled FROM messages WHERE id = ?').get(body.messageId) as { tracking_enabled: number };
    expect(message.tracking_enabled).toBe(0);
    await env.app.close();
    env.db.close();
  });

  it('420/421/422/423. link stamps ids and flips status; a repeat is idempotent; a conflicting repeat is 409; sentAt is clamped', async () => {
    const env = setupTestServer({ configOverrides: { addonEnabled: true, apiToken: 'tok' } });
    const trackRes = await env.app.inject({ method: 'POST', url: '/api/addon/track', headers: addonHeaders(env.config), payload: JSON.stringify({ to: ['a@example.com'] }) });
    const { token, messageId } = JSON.parse(trackRes.body);

    const farFuture = Date.now() + 1000 * 3600 * 24 * 365;
    const linkRes = await env.app.inject({
      method: 'POST',
      url: '/api/addon/link',
      headers: addonHeaders(env.config),
      payload: JSON.stringify({ token, gmailMessageId: 'gm1', threadId: 't1', sentAt: farFuture }),
    });
    expect(linkRes.statusCode).toBe(200);
    expect(JSON.parse(linkRes.body)).toEqual({ linked: true, changed: true });

    const message = env.db.prepare('SELECT status, sent_at, thread_id FROM messages WHERE id = ?').get(messageId) as { status: string; sent_at: number; thread_id: string };
    expect(message.status).toBe('sent');
    expect(message.thread_id).toBe('t1');
    // 423: clamped to at most now + 5 minutes - never the far-future value supplied.
    expect(message.sent_at).toBeLessThan(farFuture);

    // 421: an identical repeat is a 200 no-op.
    const repeat = await env.app.inject({ method: 'POST', url: '/api/addon/link', headers: addonHeaders(env.config), payload: JSON.stringify({ token, gmailMessageId: 'gm1' }) });
    expect(repeat.statusCode).toBe(200);
    expect(JSON.parse(repeat.body)).toEqual({ linked: true, changed: false });

    // 422: a conflicting repeat (different gmailMessageId) is 409 and audited.
    const conflict = await env.app.inject({ method: 'POST', url: '/api/addon/link', headers: addonHeaders(env.config), payload: JSON.stringify({ token, gmailMessageId: 'gm2' }) });
    expect(conflict.statusCode).toBe(409);
    const conflictAudit = env.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'addon.link.conflict'`).get() as { n: number };
    expect(conflictAudit.n).toBe(1);

    await env.app.close();
    env.db.close();
  });

  it('424. the reaper marks only unlinked add-on drafts older than the timeout, and audits once', async () => {
    const env = setupTestServer({ configOverrides: { addonEnabled: true, apiToken: 'tok' } });
    const now = Date.now();
    const trackRes = await env.app.inject({ method: 'POST', url: '/api/addon/track', headers: addonHeaders(env.config), payload: JSON.stringify({ to: ['a@example.com'] }) });
    const { messageId } = JSON.parse(trackRes.body);
    // Backdate created_at so it's past the timeout.
    env.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(now - 49 * 3600_000, messageId);

    const result = runAddonReaperOnce({ db: env.db, timeoutHours: 48 }, now);
    expect(result.reaped).toBe(1);
    const message = env.db.prepare('SELECT status FROM messages WHERE id = ?').get(messageId) as { status: string };
    expect(message.status).toBe('abandoned');

    const reapAudit = env.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'addon.reap'`).get() as { n: number };
    expect(reapAudit.n).toBe(1);

    // A second run does nothing further (already abandoned, not 'draft').
    const second = runAddonReaperOnce({ db: env.db, timeoutHours: 48 }, now);
    expect(second.reaped).toBe(0);

    await env.app.close();
    env.db.close();
  });

  it('426. the rate limiter returns 429 above ADDON_RATE_PER_HOUR', async () => {
    const env = setupTestServer({ configOverrides: { addonEnabled: true, apiToken: 'tok', addonRatePerHour: 2 } });
    const headers = addonHeaders(env.config);
    await env.app.inject({ method: 'POST', url: '/api/addon/track', headers, payload: JSON.stringify({ to: ['a@example.com'] }) });
    await env.app.inject({ method: 'POST', url: '/api/addon/track', headers, payload: JSON.stringify({ to: ['a@example.com'] }) });
    const third = await env.app.inject({ method: 'POST', url: '/api/addon/track', headers, payload: JSON.stringify({ to: ['a@example.com'] }) });
    expect(third.statusCode).toBe(429);
    await env.app.close();
    env.db.close();
  });

  it('GET /api/addon/config returns version/trackingBaseUrl/pixelTemplate', async () => {
    const env = setupTestServer({ configOverrides: { addonEnabled: true, apiToken: 'tok' } });
    const res = await env.app.inject({ method: 'GET', url: '/api/addon/config', headers: { authorization: `Bearer ${env.config.apiToken}` } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.trackingBaseUrl).toBe(env.config.trackingBaseUrl);
    expect(body.pixelTemplate).toContain('{{pixelUrl}}');
    await env.app.close();
    env.db.close();
  });
});

describe('compose-time image suppression', () => {
  it('retains an unlinked draft image as self-open without incrementing human opens', async () => {
    const env=setupTestServer({configOverrides:{addonEnabled:true,apiToken:'test-token',openIgnoreSeconds:0}});
    const response=await env.app.inject({method:'POST',url:'/api/addon/track',headers:addonHeaders(env.config),payload:{to:['self@example.com']}});
    const tracked=response.json();
    await env.app.inject({method:'GET',url:new URL(tracked.pixelUrl).pathname,headers:{'user-agent':'Mozilla/5.0 Chrome/130.0 Safari/537.36'}});
    const event=env.db.prepare('SELECT classification,counted,reason FROM open_events').get();
    expect(event).toMatchObject({classification:'self_open',counted:0,reason:'unsent_or_unlinked'});
    const row=env.db.prepare('SELECT open_count FROM recipients WHERE message_id=? AND is_aggregate=1').get(tracked.messageId);
    expect(row).toMatchObject({open_count:0});await env.app.close();env.db.close();
  });
  it('repairs historical pre-send human counts when linked, without deleting their evidence',async()=>{
    const env=setupTestServer({configOverrides:{addonEnabled:true,apiToken:'test-token'}});
    const response=await env.app.inject({method:'POST',url:'/api/addon/track',headers:addonHeaders(env.config),payload:{to:['self@example.com']}});
    const tracked=response.json();
    const row=env.db.prepare('SELECT id FROM recipients WHERE message_id=? AND is_aggregate=1').get(tracked.messageId) as {id:string};
    const before=Date.now()-100;
    env.db.prepare("INSERT INTO open_events(id,recipient_id,occurred_at,classification,confidence,counted,created_at)VALUES('old-compose',?,?,'human',1,1,?)").run(row.id,before,before);
    env.db.prepare("UPDATE recipients SET open_count=1,state='opened' WHERE id=?").run(row.id);
    const payload={token:tracked.token,gmailMessageId:'18f1234567890abc',threadId:'18f1234567890abc',sentAt:Date.now()};
    expect((await env.app.inject({method:'POST',url:'/api/addon/link',headers:addonHeaders(env.config),payload})).statusCode).toBe(200);
    expect(env.db.prepare("SELECT counted,classification,original_classification FROM open_events WHERE id='old-compose'").get()).toMatchObject({counted:0,classification:'self_open',original_classification:'human'});
    expect(env.db.prepare('SELECT open_count FROM recipients WHERE id=?').get(row.id)).toMatchObject({open_count:0});
    expect((await env.app.inject({method:'POST',url:'/api/addon/link',headers:addonHeaders(env.config),payload})).json()).toMatchObject({linked:true,changed:false});
    await env.app.close();env.db.close();
  });
});
