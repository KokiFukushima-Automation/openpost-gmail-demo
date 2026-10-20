// Runs a campaign to completion against a shared on-disk db - used by
// tests/integration/campaign-flow.test.ts's real two-process concurrency test (finding #18: the
// in-process "two concurrent runCampaignOnce calls" test shared one better-sqlite3 handle, so it
// only ever proved async interleaving within one process, not the two-`openpost serve`-processes
// claim its own module header makes). Two of these are started at (as close to) the same time
// against the SAME db file, proving claimNextRow's CAS holds across real OS processes.
import { loadConfig } from '../src/config/env.ts';
import { openDb, migrate } from '../src/db/index.ts';
import { runCampaignOnce } from '../src/jobs/campaigns.ts';

const [, , dbPath, campaignId, owner] = process.argv;

const config = loadConfig({
  TRACKING_SECRET: 'x'.repeat(40),
  TRACKING_BASE_URL: 'http://127.0.0.1:8787',
  DB_PATH: dbPath,
  MAIL_TRANSPORT: 'dryrun',
  FROM_EMAIL: 'sender@example.com',
});

const db = openDb(dbPath);
migrate(db);

const result = await runCampaignOnce({ db, config }, campaignId, { sleep: async () => undefined, owner });
db.close();
process.stdout.write(JSON.stringify(result));
process.exit(0);
