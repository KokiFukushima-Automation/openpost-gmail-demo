import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { loadConfig } from '../../config/env.js';
import { htmlToText } from '../../core/html.js';
import { migrate, openDb } from '../../db/index.js';
import { runSend, type RecipientResult } from '../../mail/send-run.js';
import type { RecipientModeOption, TransportName } from '../../types.js';
import { fail } from '../util.js';
import type { GlobalOpts } from '../util.js';

export { shouldRunSelfCopy } from '../../mail/send-run.js';
export type { RecipientResult } from '../../mail/send-run.js';

interface SendOpts {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  htmlFile?: string;
  html?: string;
  textFile?: string;
  text?: string;
  from?: string;
  track: boolean; // --no-track flips this to false
  trackClicks?: boolean; // --no-track-clicks flips this to false; --track-clicks is a no-op alias
  optoutLink?: boolean;
  transport?: TransportName;
  dryRun?: boolean;
  out?: string;
  mute?: boolean;
  recipientMode?: RecipientModeOption;
}

function collectRepeatable(value: string, previous: string[]): string[] {
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return [...previous, ...parts];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function registerSendCommand(program: Command): void {
  program
    .command('send')
    .description('Send a tracked message')
    .requiredOption('--to <email>', 'recipient email (repeatable / comma-separated)', collectRepeatable, [])
    .option('--cc <email>', 'cc recipient (repeatable / comma-separated)', collectRepeatable, [])
    .option('--bcc <email>', 'bcc recipient (repeatable / comma-separated)', collectRepeatable, [])
    .requiredOption('--subject <text>', 'message subject')
    .option('--html-file <path>', 'path to an HTML body file')
    .option('--html <string>', 'HTML body inline')
    .option('--text-file <path>', 'path to a plain-text body file')
    .option('--text <string>', 'plain-text body inline')
    .option('--from <email>', 'sender address (defaults to FROM_EMAIL)')
    .option('--no-track', 'do not inject the open-tracking pixel')
    .option('--track-clicks', 'rewrite links for click tracking (on by default; kept for compatibility, has no effect)')
    .option('--no-track-clicks', 'do not rewrite links for click tracking (on by default - §4.3)')
    .option('--optout-link', 'append an opt-out footer link')
    .option('--transport <name>', 'dryrun | smtp | gmail | gmail-smtp (overrides MAIL_TRANSPORT)')
    .option('--dry-run', 'force the dryrun transport; never sends over the network')
    .option('--out <dir>', 'override OUT_DIR for dry-run artefacts')
    .option('--mute', 'suppress notifications for this message from the start')
    .option('--recipient-mode <mode>', 'auto | per-recipient | single (overrides RECIPIENT_MODE)')
    .action(async (opts: SendOpts, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env);
        const dbPath = g.db ?? config.dbPath;
        const db = openDb(dbPath);
        migrate(db);

        let htmlTemplate: string;
        if (opts.htmlFile) {
          htmlTemplate = readFileSync(opts.htmlFile, 'utf8');
        } else if (opts.html) {
          htmlTemplate = opts.html;
        } else if (opts.text || opts.textFile) {
          const plain = opts.textFile ? readFileSync(opts.textFile, 'utf8') : (opts.text as string);
          htmlTemplate = `<html><body><pre>${escapeHtml(plain)}</pre></body></html>`;
        } else {
          throw new Error('a body is required: pass --html, --html-file, --text or --text-file');
        }

        let textTemplate: string | undefined;
        if (opts.textFile) {
          textTemplate = readFileSync(opts.textFile, 'utf8');
        } else if (opts.text) {
          textTemplate = opts.text;
        }
        // §4.3: the plain-text alternative always comes from the ORIGINAL template, never from the
        // click-rewritten HTML, so it keeps the original URLs.
        const finalTextTemplate = textTemplate ?? htmlToText(htmlTemplate);

        const transportName: TransportName | undefined = opts.dryRun ? 'dryrun' : opts.transport;

        const result = await runSend(
          { db, config },
          {
            to: opts.to,
            cc: opts.cc,
            bcc: opts.bcc,
            subject: opts.subject,
            html: htmlTemplate,
            text: finalTextTemplate,
            from: opts.from,
            track: opts.track,
            trackClicks: opts.trackClicks === false ? false : undefined,
            optOutLink: opts.optoutLink === true,
            mute: opts.mute === true,
            transport: transportName,
            recipientMode: opts.recipientMode,
            outDir: opts.out,
          },
        );

        db.close();

        const output = {
          messageId: result.messageId,
          transport: result.transport,
          recipientMode: result.mode,
          recipients: result.recipients,
          // Finding #7 (phase5.1): pre-extraction `send.ts` left this key OUT of the JSON entirely
          // when no self-copy ran (it was `undefined`, and `JSON.stringify` drops `undefined`
          // properties) - `RunSendResult.selfCopy` is `null` in that case, so spread it in only when
          // truthy to restore the old --json shape byte for byte.
          ...(result.selfCopy ? { selfCopy: result.selfCopy } : {}),
        };
        if (g.json) {
          process.stdout.write(`${JSON.stringify(output)}\n`);
        } else {
          process.stdout.write(`message: ${result.messageId}\ntransport: ${result.transport}\nrecipient-mode: ${result.mode}\n`);
          if (result.mode === 'single' && result.singleSuppressedReason) {
            process.stdout.write(`note: sent untracked - ${result.singleSuppressedReason}\n`);
          }
          for (const r of result.recipients as RecipientResult[]) {
            const status = r.suppressed && result.mode === 'per-recipient' ? 'suppressed: tracking disabled' : r.sent ? 'sent' : `failed: ${r.error}`;
            const label = r.isAggregate ? `${r.email} (message-level)` : `${r.email} (${r.kind})`;
            process.stdout.write(`  ${label} - ${status}\n`);
            if (r.pixelUrl) process.stdout.write(`    pixel: ${r.pixelUrl}\n`);
            else if (r.pixelInjected === false) process.stdout.write('    pixel: not injected (message already contained one)\n');
            if (r.artifacts) {
              process.stdout.write(`    html:  ${r.artifacts.htmlPath}\n`);
              process.stdout.write(`    eml:   ${r.artifacts.emlPath}\n`);
            }
          }
          if (result.selfCopy) {
            process.stdout.write(`self-copy (${result.selfCopy.strategy}): ${result.selfCopy.ok ? 'ok' : `failed - ${result.selfCopy.error}`}\n`);
          }
        }

        if (!result.recipients.some((r) => r.sent)) {
          process.exit(1);
        }
      } catch (err) {
        fail(err, g.json);
      }
    });
}
