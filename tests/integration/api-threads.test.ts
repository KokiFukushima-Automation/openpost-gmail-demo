import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupTestServer, type TestServer } from '../helpers/setup.js';
import { ensureAccount, createMessage, markMessageSent, addRecipient } from '../../src/db/repo.js';
import { newId } from '../../src/core/ids.js';
import { issueSession } from '../../src/server/auth/session.js';

const ALLOWED_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

function seed(env: TestServer): { messageId: string; threadId: string; rfc822: string } {
  const account = ensureAccount(env.db, { email: 'sender@example.com', transport: 'dryrun' });
  const message = createMessage(env.db, {
    accountId: account.id,
    subject: 'Re: Q3 numbers',
    bodyHtml: '<p>hi</p>',
    bodyText: 'hi',
    status: 'sent',
    trackingEnabled: true,
    clickTrackingEnabled: false,
  });
  markMessageSent(env.db, message.id, { threadId: 'gmail-thread-1', rfc822MsgId: '<abc@x.com>', sentAt: Date.now() });
  addRecipient(env.db, { messageId: message.id, email: 'a@example.com', token: newId() });
  return { messageId: message.id, threadId: 'gmail-thread-1', rfc822: '<abc@x.com>' };
}

describe('POST /api/threads/lookup', () => {
  let env: TestServer;
  beforeEach(() => {
    env = setupTestServer({ configOverrides: { apiToken: 'secret-token' } });
  });
  afterEach(() => {
    env.db.close();
  });

  it('335/336. matches by threadId, then rfc822 id, then subject; reports matchedBy; unmatched -> null; enforces the 100-key cap', async () => {
    const { threadId, rfc822 } = seed(env);
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/threads/lookup',
      headers: { authorization: 'Bearer secret-token' },
      payload: { threadIds: [threadId], rfc822MessageIds: [rfc822], subjects: ['Q3 numbers', 'totally unrelated'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { results: Array<{ key: string; matchedBy: string | null }> };
    expect(body.results.find((r) => r.key === threadId)?.matchedBy).toBe('threadId');
    expect(body.results.find((r) => r.key === rfc822)?.matchedBy).toBe('rfc822MessageId');
    expect(body.results.find((r) => r.key === 'Q3 numbers')?.matchedBy).toBe('subject');
    expect(body.results.find((r) => r.key === 'totally unrelated')?.matchedBy).toBeNull();

    const tooMany = Array.from({ length: 101 }, (_, i) => `t${i}`);
    const capRes = await env.app.inject({
      method: 'POST',
      url: '/api/threads/lookup',
      headers: { authorization: 'Bearer secret-token' },
      payload: { threadIds: tooMany },
    });
    expect(capRes.statusCode).toBe(400);
  });

  it('requires a bearer when API_TOKEN is set', async () => {
    const res = await env.app.inject({ method: 'POST', url: '/api/threads/lookup', payload: { threadIds: ['x'] } });
    expect(res.statusCode).toBe(401);
  });

  it('finding #13: the default response has aggregate summary but never a recipients[] array', async () => {
    const { threadId } = seed(env);
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/threads/lookup',
      headers: { authorization: 'Bearer secret-token' },
      payload: { threadIds: [threadId] },
    });
    const body = res.json() as { results: Array<{ summary?: unknown; recipients?: unknown }> };
    const result = body.results[0]!;
    expect(result.summary).toBeDefined();
    expect(result.recipients).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('a@example.com');
  });

  it('finding #13: ?recipients=1 WITH a valid bearer includes the recipients[] array', async () => {
    const { threadId } = seed(env);
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/threads/lookup?recipients=1',
      headers: { authorization: 'Bearer secret-token' },
      payload: { threadIds: [threadId] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { results: Array<{ recipients?: Array<{ email: string }> }> };
    expect(body.results[0]?.recipients?.[0]?.email).toBe('a@example.com');
  });

  it('finding #13: ?recipients=1 is refused (403) over the dashboard-cookie fallback, even though the plain lookup would accept it', async () => {
    const cookieEnv = setupTestServer({ configOverrides: { apiToken: 'secret-token', dashboardEnabled: true, dashboardPassword: 'pw123456' } });
    const { threadId } = seed(cookieEnv);
    const { issueSession: issue } = await import('../../src/server/auth/session.js');
    const { cookie } = issue(cookieEnv.config, Date.now());
    const cookieHeader = `openpost_sess=${cookie.split(';')[0]!.split('=')[1]!}`;

    // The plain (non-recipients) lookup accepts the same-origin dashboard cookie fine.
    const plain = await cookieEnv.app.inject({
      method: 'POST',
      url: '/api/threads/lookup',
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      payload: JSON.stringify({ threadIds: [threadId] }),
    });
    expect(plain.statusCode).toBe(200);

    const withRecipients = await cookieEnv.app.inject({
      method: 'POST',
      url: '/api/threads/lookup?recipients=1',
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      payload: JSON.stringify({ threadIds: [threadId] }),
    });
    expect(withRecipients.statusCode).toBe(403);
    cookieEnv.db.close();
  });

  it('finding #13: ?recipients=1 is refused (403) when API_TOKEN is unset entirely, even though the plain lookup is then unauthenticated by existing design', async () => {
    const openEnv = setupTestServer(); // no apiToken configured at all
    const { threadId } = seed(openEnv);
    const plain = await openEnv.app.inject({ method: 'POST', url: '/api/threads/lookup', payload: { threadIds: [threadId] } });
    expect(plain.statusCode).toBe(200);

    const withRecipients = await openEnv.app.inject({ method: 'POST', url: '/api/threads/lookup?recipients=1', payload: { threadIds: [threadId] } });
    expect(withRecipients.statusCode).toBe(403);
    openEnv.db.close();
  });

  it('finding #13: subject-based matches across many keys share one candidate query (behavioural check: correctness holds at the 100-key cap)', async () => {
    seed(env);
    const manySubjects = Array.from({ length: 100 }, (_, i) => (i === 0 ? 'Q3 numbers' : `unrelated-${i}`));
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/threads/lookup',
      headers: { authorization: 'Bearer secret-token' },
      payload: { subjects: manySubjects },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { results: Array<{ key: string; matchedBy: string | null }> };
    expect(body.results.find((r) => r.key === 'Q3 numbers')?.matchedBy).toBe('subject');
    expect(body.results.filter((r) => r.matchedBy === null)).toHaveLength(99);
  });
});

describe('CORS for /api', () => {
  it('337. unset API_CORS_ORIGINS -> no CORS headers and no OPTIONS handling', async () => {
    const env = setupTestServer({ configOverrides: { apiToken: 'secret-token', apiCorsOrigins: [] } });
    const res = await env.app.inject({ method: 'GET', url: '/api/messages', headers: { authorization: 'Bearer secret-token', origin: ALLOWED_ORIGIN } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await env.app.inject({ method: 'OPTIONS', url: '/api/messages', headers: { origin: ALLOWED_ORIGIN } });
    expect(preflight.statusCode).not.toBe(204);
    env.db.close();
  });

  it('337. set + API_TOKEN -> preflight 204 with exact-origin echo and Vary: Origin; a non-allowlisted origin gets nothing', async () => {
    const env = setupTestServer({ configOverrides: { apiToken: 'secret-token', apiCorsOrigins: [ALLOWED_ORIGIN] } });
    const preflight = await env.app.inject({ method: 'OPTIONS', url: '/api/messages', headers: { origin: ALLOWED_ORIGIN } });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(preflight.headers['vary']).toBe('Origin');
    expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();

    const other = await env.app.inject({ method: 'GET', url: '/api/messages', headers: { authorization: 'Bearer secret-token', origin: 'https://evil.example.com' } });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
    env.db.close();
  });

  it('337. a cross-origin request authenticated ONLY by the dashboard cookie is 401 - even with a REAL, currently-valid session cookie', async () => {
    const env = setupTestServer({
      configOverrides: { apiToken: 'secret-token', apiCorsOrigins: [ALLOWED_ORIGIN], dashboardEnabled: true, dashboardPassword: 'pw123456' },
    });
    // Finding #18: the original version of this test sent a FAKE cookie value ('whatever'), so it
    // would have gotten 401 regardless of whether the cross-origin branch was reached at all -
    // authenticateDashboard rejects a garbage cookie on its own. Mint a genuine, currently-valid
    // session (the same helper issueSession produces for a real login) so this actually proves the
    // cross-origin gate refuses a cookie that a same-origin request would accept.
    const { cookie } = issueSession(env.config, Date.now());
    const sessionCookieValue = cookie.split(';')[0]!.split('=')[1]!;
    const cookieHeader = `openpost_sess=${sessionCookieValue}`;

    // Control: the SAME cookie, same-origin (no Origin header), IS accepted - proving the cookie
    // itself is genuinely valid, so the cross-origin case below is a real refusal, not a red herring.
    const sameOrigin = await env.app.inject({ method: 'GET', url: '/api/messages', headers: { cookie: cookieHeader } });
    expect(sameOrigin.statusCode).toBe(200);

    const crossOrigin = await env.app.inject({
      method: 'GET',
      url: '/api/messages',
      headers: { origin: ALLOWED_ORIGIN, cookie: cookieHeader },
    });
    expect(crossOrigin.statusCode).toBe(401);
    env.db.close();
  });
});

describe('Gmail overlay summary semantics', () => {
  it('uses the aggregate tracking unit for single mode, without claiming which addressee opened', async () => {
    const env = setupTestServer({configOverrides:{apiToken:'secret-token'}});
    const {messageId,threadId} = seed(env);
    env.db.prepare("UPDATE messages SET recipient_mode = 'single' WHERE id = ?").run(messageId);
    const aggregate = addRecipient(env.db,{messageId,email:'aggregate@invalid',token:newId(),isAggregate:true});
    env.db.prepare("UPDATE recipients SET state='read_confirmed',open_count=3,click_count=1,last_open_at=12345 WHERE id=?").run(aggregate.id);
    const res = await env.app.inject({method:'POST',url:'/api/threads/lookup',headers:{authorization:'Bearer secret-token'},payload:{threadIds:[threadId]}});
    expect(res.json().results[0].summary).toMatchObject({state:'read_confirmed',opens:3,clicks:1,recipients:1,lastOpenAt:12345});
    expect(JSON.stringify(res.json())).not.toContain('aggregate@invalid');
    await env.app.close(); env.db.close();
  });
  it('reports prefetch as unconfirmed, also resolving per-copy Gmail thread IDs', async () => {
    const env = setupTestServer({configOverrides:{apiToken:'secret-token'}});
    const {messageId} = seed(env);
    env.db.prepare("UPDATE messages SET thread_id=NULL WHERE id=?").run(messageId);
    env.db.prepare("UPDATE recipients SET thread_id='per-copy-thread',state='prefetched' WHERE message_id=?").run(messageId);
    const request = {method:'POST' as const,url:'/api/threads/lookup',headers:{authorization:'Bearer secret-token'},payload:{threadIds:['per-copy-thread']}};
    const res = await env.app.inject(request);
    expect(res.json().results[0].summary).toMatchObject({state:'prefetched',opens:0});
    env.db.prepare('UPDATE messages SET tracking_enabled=0 WHERE id=?').run(messageId);
    expect((await env.app.inject(request)).json().results[0].matchedBy).toBeNull();
    await env.app.close(); env.db.close();
  });
});
