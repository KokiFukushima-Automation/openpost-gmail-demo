// Runs a campaign to completion (or until a chosen crash point) and SIGKILLs itself there - used
// by tests/integration/campaign-crash.test.ts (DoD 2, tests 265/266) to prove a real process death
// is handled by the at-most-once state machine, not merely simulated in-process.
//
// argv: <dbPath> <campaignId> <mode> [killAtRowIndex]
//   mode 'between-rows': kills right after a row was claimed but BEFORE beginRowSubmit runs for it
//                         (i.e. between two rows' work) - the pre-submit crash scenario (test 265).
//   mode 'mid-submit':   kills right after beginRowSubmit journalled submit_started_at for the row
//                         at row_index === killAtRowIndex, before the transport call - the
//                         "process died after submit began" scenario (test 266).
import { loadConfig } from '../src/config/env.ts';
import { openDb, migrate } from '../src/db/index.ts';
import { runCampaignOnce } from '../src/jobs/campaigns.ts';

const [, , dbPath, campaignId, mode, killAtRowIndexArg] = process.argv;
const killAtRowIndex = killAtRowIndexArg !== undefined ? Number(killAtRowIndexArg) : 0;

const config = loadConfig({
  TRACKING_SECRET: 'x'.repeat(40),
  TRACKING_BASE_URL: 'http://127.0.0.1:8787',
  DB_PATH: dbPath,
  MAIL_TRANSPORT: 'dryrun',
  FROM_EMAIL: 'sender@example.com',
});

const db = openDb(dbPath);
migrate(db);

let claimedCount = 0;

await runCampaignOnce(
  { db, config },
  campaignId,
  {
    sleep: async () => undefined,
    onRowClaimed: () => {
      claimedCount += 1;
      if (mode === 'between-rows' && claimedCount === killAtRowIndex + 1) {
        process.kill(process.pid, 'SIGKILL');
      }
    },
    onSubmitBegan: (row) => {
      if (mode === 'mid-submit' && row.row_index === killAtRowIndex) {
        process.kill(process.pid, 'SIGKILL');
      }
    },
  },
);

// Unreachable if a kill fired - reached only if the run completed without hitting the chosen
// crash point, which the test treats as its own failure (the crash scenario never got to run).
process.exit(0);
