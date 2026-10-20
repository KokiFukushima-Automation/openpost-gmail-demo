import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../../src/db/index.js';
import { Scheduler } from '../../src/jobs/scheduler.js';
import { createPruneJob } from '../../src/jobs/prune.js';
import type { Job } from '../../src/jobs/scheduler.js';

function setupDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

describe('Scheduler', () => {
  it('103. runDue runs the prune job once, writes the jobs row, and skips it before the interval elapses', async () => {
    const db = setupDb();
    const scheduler = new Scheduler({ db });
    let runs = 0;
    scheduler.register({
      name: 'prune',
      intervalMs: 60_000,
      async run() {
        runs += 1;
        return { detail: {} };
      },
    });

    const first = await scheduler.runDue(1000);
    expect(first).toEqual([{ name: 'prune', status: 'ok' }]);
    expect(runs).toBe(1);
    const jobRow = db.prepare('SELECT * FROM jobs WHERE name = ?').get('prune') as { last_run_at: number; last_status: string };
    expect(jobRow.last_run_at).toBe(1000);
    expect(jobRow.last_status).toBe('ok');

    const second = await scheduler.runDue(30_000); // interval hasn't elapsed yet
    expect(second).toEqual([{ name: 'prune', status: 'skipped' }]);
    expect(runs).toBe(1);

    const third = await scheduler.runDue(70_000); // now it has
    expect(third).toEqual([{ name: 'prune', status: 'ok' }]);
    expect(runs).toBe(2);
  });

  it('104. a throwing job records last_status=error and the scheduler keeps running the others', async () => {
    const db = setupDb();
    const scheduler = new Scheduler({ db, log: { error: () => undefined } });
    let goodRuns = 0;
    const throwingJob: Job = {
      name: 'boom',
      intervalMs: 1000,
      async run() {
        throw new Error('kaboom');
      },
    };
    const goodJob: Job = {
      name: 'good',
      intervalMs: 1000,
      async run() {
        goodRuns += 1;
        return {};
      },
    };
    scheduler.register(throwingJob);
    scheduler.register(goodJob);

    const results = await scheduler.runDue(1000);
    expect(results).toEqual([
      { name: 'boom', status: 'error' },
      { name: 'good', status: 'ok' },
    ]);
    expect(goodRuns).toBe(1);
    const boomRow = db.prepare('SELECT * FROM jobs WHERE name = ?').get('boom') as { last_status: string; last_error: string };
    expect(boomRow.last_status).toBe('error');
    expect(boomRow.last_error).toContain('kaboom');
  });

  it('105. PRUNE_ENABLED=false -> the prune job is never registered (mirrors openpost serve\'s `if (config.pruneEnabled) scheduler.register(...)` guard)', async () => {
    const db = setupDb();
    const scheduler = new Scheduler({ db });
    const pruneEnabled = false;
    if (pruneEnabled) {
      scheduler.register(createPruneJob(db, { retentionDays: 1, intervalHours: 24, vacuumThreshold: 0 }));
    }
    const results = await scheduler.runDue(1000);
    expect(results).toEqual([]);
  });

  it('finding #7: the job row is claimed (last_run_at + a "running" status) before run() executes, not after it completes', async () => {
    const db = setupDb();
    const scheduler = new Scheduler({ db });
    let sawRunningWhileInFlight = false;
    scheduler.register({
      name: 'slow',
      intervalMs: 0,
      async run() {
        const row = db.prepare('SELECT last_run_at, last_status FROM jobs WHERE name = ?').get('slow') as
          | { last_run_at: number; last_status: string }
          | undefined;
        sawRunningWhileInFlight = row?.last_run_at === 1000 && row?.last_status === 'running';
      },
    });
    await scheduler.runDue(1000);
    expect(sawRunningWhileInFlight).toBe(true);
    const finalRow = db.prepare('SELECT last_status FROM jobs WHERE name = ?').get('slow') as { last_status: string };
    expect(finalRow.last_status).toBe('ok');
  });

  it('finding #7: start() never begins an overlapping tick while a job from the previous tick is still in flight', async () => {
    const db = setupDb();
    const scheduler = new Scheduler({ db });
    let concurrent = 0;
    let maxConcurrent = 0;
    let release: (() => void) | undefined;
    scheduler.register({
      name: 'slow-overlap',
      intervalMs: 0,
      async run() {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        concurrent -= 1;
      },
    });
    scheduler.start(5);
    // Several 5ms ticks fire while the job above is deliberately stuck awaiting `release`.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(maxConcurrent).toBe(1);
    release?.();
    await scheduler.stop();
  });

  it('bonus: the prune job actually deletes rows older than the retention window and audits prune.run', async () => {
    const db = setupDb();
    db.prepare(
      `INSERT INTO accounts (id, email, display_name, transport, created_at) VALUES ('a1','s@example.com',NULL,'dryrun',0)`,
    ).run();
    db.prepare(
      `INSERT INTO messages (id, account_id, subject, status, tracking_enabled, click_tracking_enabled, created_at, self_copy_strategy, self_copy_msg_id, notify_muted)
       VALUES ('m1','a1','s','sent',1,0,0,NULL,NULL,0)`,
    ).run();
    db.prepare(
      `INSERT INTO recipients (id, message_id, email, kind, token, open_count, machine_open_count, click_count, created_at, state, notify_muted)
       VALUES ('r1','m1','x@example.com','to','tok1',0,0,0,0,'not_opened',0)`,
    ).run();
    db.prepare(
      `INSERT INTO open_events (id, recipient_id, occurred_at, classification, confidence, counted, created_at)
       VALUES ('e1','r1',100,'human',1,1,100)`,
    ).run();

    const job = createPruneJob(db, { retentionDays: 1, intervalHours: 24, vacuumThreshold: 0 });
    const nowMs = 1000 + 2 * 24 * 60 * 60 * 1000;
    await job.run(nowMs);

    const remaining = db.prepare('SELECT COUNT(*) AS n FROM open_events').get() as { n: number };
    expect(remaining.n).toBe(0);
    const auditCount = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'prune.run'`).get() as { n: number };
    expect(auditCount.n).toBe(1);
  });
});
