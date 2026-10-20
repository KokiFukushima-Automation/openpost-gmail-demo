// Runs exactly one reminders firing pass and SIGKILLs itself the instant a reminder's notification
// has been enqueued but NOT yet marked fired - used by tests/integration/reminders-flow.test.ts
// (case 176, DoD 3) to prove that a real process death in exactly that window never produces a
// second delivery once a fresh pass re-claims the lease. Invoked via `tsx` (a devDependency already
// used for `npm run dev`) so it can import the TypeScript sources directly with no separate build
// step.
//
// Phase 3.1 (M5): this used to kill at `onClaimed` (right after the claim, before ANY firing work),
// which never actually reached `notifyEnqueue` at all - so the crash-recovery half of §3.3's
// argument table ("enqueue happened, fire didn't - re-claim must not double-notify") was never
// exercised by this script. `notifyEnqueue` is now wired to a real `NotifyWorker` (so the
// enqueue actually writes a `notifications` row before the kill), and the kill itself moved to the
// new `onEnqueued` seam, right after that write.
//
// argv: <dbPath> <nowMsAtClaim>
import { loadConfig } from '../src/config/env.ts';
import { openDb, migrate } from '../src/db/index.ts';
import { EventBus } from '../src/notify/bus.ts';
import { NotifyWorker } from '../src/notify/worker.ts';
import { runRemindersOnce } from '../src/jobs/reminders.ts';

const [, , dbPath, nowMsArg] = process.argv;
const nowMs = Number(nowMsArg);

const config = loadConfig({
  TRACKING_SECRET: 'x'.repeat(40),
  TRACKING_BASE_URL: 'http://127.0.0.1:8787',
  DB_PATH: dbPath,
  NOTIFY_CHANNELS: 'slack',
  SLACK_WEBHOOK_URL: 'http://127.0.0.1:1/webhook',
  NOTIFY_ALLOW_PRIVATE_URLS: 'true',
});

const db = openDb(dbPath);
migrate(db);
const bus = new EventBus();
const notifyWorker = new NotifyWorker({ db, config, bus });

await runRemindersOnce(
  {
    db,
    config,
    bus,
    owner: 'crash-child',
    notifyEnqueue: (e) => notifyWorker.enqueueForEvent(e),
    onEnqueued: () => process.kill(process.pid, 'SIGKILL'),
  },
  nowMs,
  10,
);

// Unreachable if onEnqueued fired (the process is dead by then) - reached only if there was
// nothing to claim/enqueue, which the test treats as its own failure (the crash scenario never
// got to run).
process.exit(0);
