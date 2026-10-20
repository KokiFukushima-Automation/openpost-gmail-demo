import type { Command } from 'commander';
import { loadConfig } from '../../config/env.js';
import { migrate, openDb } from '../../db/index.js';
import { getMessage, setMute } from '../../db/repo.js';
import { fail } from '../util.js';
import type { GlobalOpts } from '../util.js';

interface MuteOpts {
  recipient?: string;
  off?: boolean;
}

export function registerMuteCommand(program: Command): void {
  program
    .command('mute')
    .description('Mute (or unmute) notifications for a message or one of its recipients')
    .argument('<messageId>', 'message id')
    .option('--recipient <recipientId>', 'mute only this recipient, not the whole message')
    .option('--off', 'unmute instead of mute')
    .action((messageId: string, opts: MuteOpts, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);

        const message = getMessage(db, messageId);
        if (!message) throw new Error(`message not found: ${messageId}`);

        setMute(db, { messageId, recipientId: opts.recipient ?? null, muted: !opts.off });
        db.close();

        const result = { messageId, recipientId: opts.recipient ?? null, muted: !opts.off };
        if (g.json) process.stdout.write(`${JSON.stringify(result)}\n`);
        else process.stdout.write(`${result.muted ? 'muted' : 'unmuted'} ${opts.recipient ? `recipient ${opts.recipient}` : `message ${messageId}`}\n`);
      } catch (err) {
        fail(err, g.json);
      }
    });
}
