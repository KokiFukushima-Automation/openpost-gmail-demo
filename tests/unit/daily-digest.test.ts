import { describe, expect, it } from 'vitest';
import { openDb, migrate } from '../../src/db/index.js';
import { runDailyDigestOnce } from '../../src/jobs/daily-digest.js';
import { listNotifications } from '../../src/notify/queue.js';
import { makeConfig } from '../helpers/setup.js';

function setupDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

const DAY_MS = 24 * 3600_000;
// A fixed UTC instant whose local time-of-day is 09:05 - safely past a "09:00" DIGEST_DAILY_AT.
const BASE_MS = Date.UTC(2024, 0, 10, 9, 5, 0);

describe('daily digest job', () => {
  it('does nothing when DIGEST_DAILY_AT is unset', async () => {
    const db = setupDb();
    const config = makeConfig({ notifyChannels: ['slack'], slackWebhookUrl: 'https://hooks.slack.test/x', digestDailyAt: undefined });
    const result = await runDailyDigestOnce({ db, config }, BASE_MS);
    expect(result.sent).toBe(false);
    expect(listNotifications(db)).toHaveLength(0);
  });

  it('414. fires once per local day, dedupes across a "restart" (a second call same day is a no-op), and names counts only', async () => {
    const db = setupDb();
    const config = makeConfig({ notifyChannels: ['slack', 'ntfy'], slackWebhookUrl: 'https://hooks.slack.test/x', ntfyTopic: 'x', digestDailyAt: '09:00', digestTimezone: 'UTC' });

    const first = await runDailyDigestOnce({ db, config }, BASE_MS);
    expect(first.sent).toBe(true);
    const rows = listNotifications(db);
    expect(rows).toHaveLength(2); // one per configured channel
    expect(rows.every((r) => r.trigger === 'daily_digest')).toBe(true);

    // A second tick the same day (simulating a restart, or the 60s scheduler tick recurring) must
    // not enqueue a second round.
    const second = await runDailyDigestOnce({ db, config }, BASE_MS + 3600_000);
    expect(second.sent).toBe(false);
    expect(listNotifications(db)).toHaveLength(2);

    const payload = JSON.parse(rows[0]!.payload_json);
    expect(payload.trigger).toBe('daily_digest');
    expect(payload.digest).toBeDefined();
    expect(payload.recipient.email).toBeNull();
  });

  it('a tick before DIGEST_DAILY_AT does not fire yet', async () => {
    const db = setupDb();
    const config = makeConfig({ notifyChannels: ['slack'], slackWebhookUrl: 'https://hooks.slack.test/x', digestDailyAt: '23:00', digestTimezone: 'UTC' });
    const result = await runDailyDigestOnce({ db, config }, BASE_MS);
    expect(result.sent).toBe(false);
  });

  it('fires again the next day', async () => {
    const db = setupDb();
    const config = makeConfig({ notifyChannels: ['slack'], slackWebhookUrl: 'https://hooks.slack.test/x', digestDailyAt: '09:00', digestTimezone: 'UTC' });
    await runDailyDigestOnce({ db, config }, BASE_MS);
    const nextDay = await runDailyDigestOnce({ db, config }, BASE_MS + DAY_MS);
    expect(nextDay.sent).toBe(true);
    expect(listNotifications(db)).toHaveLength(2);
  });
});
