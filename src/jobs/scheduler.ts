import type { DB } from '../db/index.js';

export interface Job {
  name: string;
  intervalMs: number;
  run(nowMs: number): Promise<{ detail?: unknown }>;
}

export interface Logger {
  error: (...args: unknown[]) => void;
}

const noopLogger: Logger = { error: () => undefined };

interface JobRow {
  name: string;
  last_run_at: number | null;
  last_status: string | null;
  last_error: string | null;
}

function getJobRow(db: DB, name: string): JobRow | null {
  const row = db.prepare('SELECT * FROM jobs WHERE name = ?').get(name) as JobRow | undefined;
  return row ?? null;
}

function upsertJobRow(db: DB, name: string, lastRunAt: number, status: string, error: string | null): void {
  db.prepare(
    `INSERT INTO jobs (name, last_run_at, last_status, last_error) VALUES (@name, @lastRunAt, @status, @error)
       ON CONFLICT(name) DO UPDATE SET last_run_at = @lastRunAt, last_status = @status, last_error = @error`,
  ).run({ name, lastRunAt, status, error });
}

export interface SchedulerDeps {
  db: DB;
  clock?: () => number;
  log?: Logger;
}

/** Runs registered `Job`s at their own interval, bookkept in the existing `jobs` table (§5.2). A
 *  throwing job is recorded `last_status='error'` and never stops the others or the scheduler
 *  itself. */
export class Scheduler {
  private readonly db: DB;
  private readonly clock: () => number;
  private readonly log: Logger;
  private readonly jobs: Job[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<unknown> | null = null;

  constructor(deps: SchedulerDeps) {
    this.db = deps.db;
    this.clock = deps.clock ?? (() => Date.now());
    this.log = deps.log ?? noopLogger;
  }

  register(job: Job): void {
    this.jobs.push(job);
  }

  async runDue(nowMs: number): Promise<Array<{ name: string; status: 'ok' | 'skipped' | 'error' }>> {
    const results: Array<{ name: string; status: 'ok' | 'skipped' | 'error' }> = [];
    for (const job of this.jobs) {
      const row = getJobRow(this.db, job.name);
      const due = row?.last_run_at === null || row === null || nowMs - (row.last_run_at as number) >= job.intervalMs;
      if (!due) {
        results.push({ name: job.name, status: 'skipped' });
        continue;
      }
      // Finding #7: claim by writing `last_run_at` (and a transient 'running' status) *before*
      // running the job, not after it completes - a job whose `run()` takes longer than its own
      // `intervalMs` must never look "not yet run" (and so get started a second time) to whatever
      // reads `last_run_at` while it is still in flight.
      upsertJobRow(this.db, job.name, nowMs, 'running', null);
      try {
        await job.run(nowMs);
        upsertJobRow(this.db, job.name, nowMs, 'ok', null);
        results.push({ name: job.name, status: 'ok' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          upsertJobRow(this.db, job.name, nowMs, 'error', message);
        } catch (writeErr) {
          this.log.error(writeErr, `scheduler: failed to record job "${job.name}" error`);
        }
        this.log.error(err, `scheduler: job "${job.name}" threw`);
        results.push({ name: job.name, status: 'error' });
      }
    }
    return results;
  }

  start(tickMs = 60_000): void {
    if (this.interval !== null) return;
    this.interval = setInterval(() => {
      // Finding #7: `setInterval` does not wait for its callback to finish - without this guard, a
      // `runDue` call that is still awaiting a slow job would overlap with the next tick's call.
      if (this.inFlight) return;
      const run = this.runDue(this.clock());
      this.inFlight = run;
      void run.finally(() => {
        if (this.inFlight === run) this.inFlight = null;
      });
    }, tickMs);
    this.interval.unref();
  }

  async stop(): Promise<void> {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.inFlight) {
      await this.inFlight.catch(() => undefined);
    }
  }
}
