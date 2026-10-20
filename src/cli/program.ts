import { Command } from 'commander';
import { VERSION } from '../version.js';
import { registerAccountsCommand } from './commands/accounts.js';
import { registerAccuracyCommand } from './commands/accuracy.js';
import { registerAuthCommand } from './commands/auth.js';
import { registerBackupCommand } from './commands/backup.js';
import { registerCampaignCommand } from './commands/campaign.js';
import { registerDashboardCommand } from './commands/dashboard.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerForgetCommand } from './commands/forget.js';
import { registerInitCommand } from './commands/init.js';
import { registerListCommand } from './commands/list.js';
import { registerMigrateCommand } from './commands/migrate.js';
import { registerMuteCommand } from './commands/mute.js';
import { registerNotificationsCommand } from './commands/notifications.js';
import { registerNotifyCommand } from './commands/notify-test.js';
import { registerPruneCommand } from './commands/prune.js';
import { registerPushCommand } from './commands/push.js';
import { registerReclassifyCommand } from './commands/reclassify.js';
import { registerRemindCommand } from './commands/remind.js';
import { registerRemindersCommand } from './commands/reminders.js';
import { registerSeedCommand } from './commands/seed.js';
import { registerSendCommand } from './commands/send.js';
import { registerServeCommand } from './commands/serve.js';
import { registerShowCommand } from './commands/show.js';
import { registerStatsCommand } from './commands/stats.js';
import { registerTunnelCommand } from './commands/tunnel.js';
import { registerUpdateRangesCommand } from './commands/update-ranges.js';

/** Builds a fresh `openpost` commander program. Kept separate from index.ts so tests can drive it
 *  with synthetic argv instead of process.argv. */
export function createProgram(): Command {
  const program = new Command();

  program
    .name('openpost')
    .description('Self-hostable Gmail open-tracking tool')
    .version(VERSION)
    .exitOverride()
    .option('--db <path>', 'override DB_PATH')
    .option('--json', 'machine-readable output')
    .option('--verbose', 'verbose logging');

  registerInitCommand(program);
  registerMigrateCommand(program);
  registerServeCommand(program);
  registerSendCommand(program);
  registerListCommand(program);
  registerShowCommand(program);
  registerPruneCommand(program);

  // Phase 2
  registerDoctorCommand(program);
  registerTunnelCommand(program);
  registerAuthCommand(program);
  registerUpdateRangesCommand(program);
  registerReclassifyCommand(program);
  registerForgetCommand(program);
  registerAccuracyCommand(program);
  registerNotificationsCommand(program);
  registerNotifyCommand(program);
  registerMuteCommand(program);

  // Phase 3
  registerRemindCommand(program);
  registerRemindersCommand(program);
  registerStatsCommand(program);
  registerSeedCommand(program);
  registerDashboardCommand(program);

  // Phase 4
  registerCampaignCommand(program);
  registerAccountsCommand(program);
  registerBackupCommand(program);

  // Phase 5
  registerPushCommand(program);

  return program;
}
