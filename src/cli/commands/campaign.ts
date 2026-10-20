import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { Command } from 'commander';
import { loadConfig } from '../../config/env.js';
import { migrate, openDb } from '../../db/index.js';
import {
  campaignCounts,
  createCampaign,
  getCampaign,
  insertRows,
  listCampaigns,
  listRows,
  requeueIndeterminate,
  setCampaignStatus,
  transitionCampaignStatus,
  type CampaignRowStatus,
  type CampaignStatus,
} from '../../db/campaigns.js';
import { campaignReport } from '../../db/campaign-stats.js';
import { CsvError, parseCsv, pickEmailColumn } from '../../core/csv.js';
import { collectVars, renderTemplate, TemplateError } from '../../core/template.js';
import { assertSafeHrefs } from '../../core/html.js';
import { assignVariant, type Variant } from '../../core/variant.js';
import { toCsvGeneric } from '../../server/export.js';
import { resolveAccount } from '../../mail/accounts.js';
import { ensureAccount } from '../../db/repo.js';
import type { DB } from '../../db/index.js';
import { runCampaignOnce } from '../../jobs/campaigns.js';
import { fail } from '../util.js';
import type { GlobalOpts } from '../util.js';

const RESERVED_KEYS = new Set(['email', 'campaign_name', 'sender_name', 'sender_email', 'unsubscribe_url']);

interface CreateOpts {
  name: string;
  csv: string;
  template?: string;
  html?: string;
  subject: string;
  subjectB?: string;
  variantSplit?: string;
  textTemplate?: string;
  emailColumn?: string;
  delimiter?: string;
  fromAccount?: string;
  transport?: string;
  dryRun?: boolean;
  ratePerMinute?: string;
  jitterMs?: string;
  dailyCap?: string;
  digestMinutes?: string;
  noTrackClicks?: boolean;
  allowRaw?: boolean;
  start?: boolean;
}

function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/** Finding #6: a shared, human-readable rendering of `transitionCampaignStatus`'s refusal, used by
 *  every CLI subcommand that changes a campaign's status by name (pause/resume/cancel) so an
 *  operator sees exactly which current status blocked the request, rather than the command
 *  silently "succeeding" against an unknown id or a terminal campaign. */
function explainTransitionError(id: string, error: { error: 'not_found' } | { error: 'invalid_transition'; from: CampaignStatus }): Error {
  if (error.error === 'not_found') return new Error(`no campaign ${id}`);
  return new Error(`campaign ${id} is '${error.from}' - that transition is not allowed`);
}

/** Finding #9: `Number(...)` alone accepts 0, negative numbers and non-integers - the env-var
 *  equivalents of these same knobs are already bounds-checked (src/config/env.ts's
 *  `parseIntBounded`, with the exact same per-field minimums used here: 1 for rate/cap/digest, 0
 *  for jitter - zero jitter is a legitimate "no jitter" request), but `campaign create`'s CLI flags
 *  were not. `--rate-per-minute 0` (or a negative value) made `nextDelayMs` yield `Infinity`/`<=0` -
 *  Node clamps `setTimeout(Infinity)` to 1ms, so the campaign blasted at full, unpaced speed;
 *  `--daily-cap 0`/negative made the cap fire (and, per finding #5, stick) immediately. */
function parseBoundedInt(flag: string, raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
    throw new Error(`${flag} must be an integer >= ${min} (got "${raw}")`);
  }
  return n;
}

function parseVariantSplit(spec: string | undefined): [number, number] {
  if (!spec) return [50, 50];
  const parts = spec.split('/').map((s) => Number(s.trim()));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n) || n <= 0)) {
    throw new Error(`--variant-split must look like "50/50" (got "${spec}")`);
  }
  return [parts[0] as number, parts[1] as number];
}

export function registerCampaignCommand(program: Command): void {
  const campaign = program.command('campaign').description('Mail-merge campaigns (CSV mail merge)');

  campaign
    .command('create')
    .description('Import a CSV and create a campaign')
    .requiredOption('--name <name>', 'campaign name')
    .requiredOption('--csv <file>', 'CSV file path')
    .option('--template <file>', 'HTML body template file')
    .option('--html <string>', 'HTML body template inline')
    .requiredOption('--subject <tpl>', 'subject template')
    .option('--subject-b <tpl>', 'a second subject variant (A/B test)')
    .option('--variant-split <a/b>', 'weight split for --subject-b, e.g. 50/50', '50/50')
    .option('--text-template <file>', 'plain-text body template file')
    .option('--email-column <col>', 'CSV column holding the address (auto-detected otherwise)')
    .option('--delimiter <d>', 'CSV delimiter: , ; or tab (auto-detected otherwise)')
    .option('--from-account <ref>', 'account id/label/email to send from')
    .option('--transport <name>', 'dryrun | smtp | gmail | gmail-smtp')
    .option('--dry-run', 'force the dryrun transport')
    .option('--rate-per-minute <n>', 'send rate', '20')
    .option('--jitter-ms <n>', 'pacing jitter', '4000')
    .option('--daily-cap <n>', 'rolling 24h cap for this account', '400')
    .option('--digest-minutes <n>', 'digest window', '60')
    .option('--no-track-clicks', 'disable click tracking for this campaign')
    .option('--allow-raw', 'allow {{{raw}}} template output (unescaped HTML from CSV cells)')
    .option('--start', 'start sending immediately after import')
    .action((opts: CreateOpts, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env);
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);

        const csvText = readFileSync(opts.csv, 'utf8');
        const delimiter = opts.delimiter === 'tab' ? '\t' : (opts.delimiter as ',' | ';' | undefined);
        const table = parseCsv(csvText, delimiter ? { delimiter } : {});
        const emailColumn = pickEmailColumn(table.headers, opts.emailColumn);

        const bodyTemplate = opts.template ? readFileSync(opts.template, 'utf8') : (opts.html ?? '');
        if (!bodyTemplate) throw new Error('a body is required: pass --template or --html');
        const textTemplate = opts.textTemplate ? readFileSync(opts.textTemplate, 'utf8') : undefined;

        // Validation order (§2.7, test 252): unknown var -> unsafe href -> reserved column ->
        // missing email column. The email column is already resolved above (pickEmailColumn
        // throws its own named error first), so the remaining checks run against the header set.
        const csvColumns = new Set(table.headers.filter((h) => h !== emailColumn));
        for (const col of csvColumns) {
          if (RESERVED_KEYS.has(col)) {
            throw new Error(`CSV column "${col}" is a reserved template key - rename the column`);
          }
        }
        const allowRaw = opts.allowRaw === true;
        const sampleVars: Record<string, string> = { email: 'sample@example.com', campaign_name: opts.name, sender_name: '', sender_email: '', unsubscribe_url: 'https://example.com/u/sample' };
        for (const h of table.headers) sampleVars[h] = table.rows[0]?.[h] ?? 'sample';
        const varsInTemplates = new Set([
          ...collectVars(opts.subject),
          ...collectVars(bodyTemplate),
          ...(opts.subjectB ? collectVars(opts.subjectB) : []),
          ...(textTemplate ? collectVars(textTemplate) : []),
        ]);
        for (const key of varsInTemplates) {
          if (!(key in sampleVars)) {
            throw new Error(`unknown template key "${key}" - not a CSV column or a reserved key`);
          }
        }
        renderTemplate(opts.subject, sampleVars, { mode: 'subject', allowRaw });
        const renderedHtml = renderTemplate(bodyTemplate, sampleVars, { mode: 'html', allowRaw });
        assertSafeHrefs(renderedHtml);
        if (opts.subjectB) renderTemplate(opts.subjectB, sampleVars, { mode: 'subject', allowRaw });
        if (textTemplate) renderTemplate(textTemplate, sampleVars, { mode: 'text', allowRaw });

        const account = resolveAccount(db, config, opts.fromAccount);
        const transportName = opts.dryRun ? 'dryrun' : (opts.transport as typeof account.transport | undefined) ?? account.transport;

        const variants: Variant[] | null = opts.subjectB
          ? (() => {
              const [wa, wb] = parseVariantSplit(opts.variantSplit);
              return [
                { key: 'A', template: opts.subject, weight: wa },
                { key: 'B', template: opts.subjectB as string, weight: wb },
              ];
            })()
          : null;

        const csvSha256 = createHash('sha256').update(csvText).digest('hex');
        const campaignRow = createCampaign(db, {
          name: opts.name,
          accountId: account.id === 'env' ? resolveEnvAccountId(db, config) : account.id,
          subjectTemplate: opts.subject,
          subjectVariantsJson: variants ? JSON.stringify(variants) : null,
          bodyHtmlTemplate: bodyTemplate,
          bodyTextTemplate: textTemplate ?? null,
          allowRaw,
          fromEmail: account.email,
          fromName: account.fromName,
          transport: transportName,
          trackClicks: opts.noTrackClicks !== true,
          dryRun: opts.dryRun === true,
          ratePerMinute: parseBoundedInt('--rate-per-minute', opts.ratePerMinute, 20, 1),
          jitterMs: parseBoundedInt('--jitter-ms', opts.jitterMs, 4000, 0),
          dailyCap: parseBoundedInt('--daily-cap', opts.dailyCap, 400, 1),
          emailColumn,
          columnsJson: JSON.stringify(table.headers),
          csvPath: opts.csv,
          csvSha256,
          digestWindowMinutes: parseBoundedInt('--digest-minutes', opts.digestMinutes, 60, 1),
          createdAt: Date.now(),
        });

        const seenEmails = new Set<string>();
        let deduped = 0;
        const rowsToInsert = table.rows.map((row, i) => {
          const email = (row[emailColumn] ?? '').trim().toLowerCase();
          const isDup = seenEmails.has(email);
          if (isDup) deduped += 1;
          else seenEmails.add(email);
          const variant = variants ? assignVariant(campaignRow.id, email, variants) : 'A';
          return {
            rowIndex: i,
            email,
            varsJson: JSON.stringify(row),
            variant,
            status: (isDup ? 'skipped' : 'pending') as CampaignRowStatus,
            skipReason: isDup ? 'duplicate_in_csv' : undefined,
          };
        });
        insertRows(db, campaignRow.id, rowsToInsert, Date.now());

        if (opts.start) {
          setCampaignStatus(db, campaignRow.id, 'running', Date.now());
        }
        db.close();

        const output = {
          campaignId: campaignRow.id,
          imported: rowsToInsert.length,
          deduped,
          variantSplit: variants ? variants.map((v) => ({ key: v.key, weight: v.weight })) : null,
        };
        if (g.json) {
          process.stdout.write(`${JSON.stringify(output)}\n`);
        } else {
          process.stdout.write(`campaign: ${campaignRow.id}\nimported: ${output.imported} rows (${deduped} duplicate)\n`);
        }
      } catch (err) {
        if (err instanceof CsvError || err instanceof TemplateError) {
          process.stderr.write(`error: ${err.message}\n`);
          process.exit(2);
        }
        fail(err, g.json);
      }
    });

  campaign
    .command('run <id>')
    .description('Send pending rows of a campaign')
    .option('--limit <n>', 'max rows to send this call')
    .option('--max-seconds <n>', 'stop after this many seconds')
    .option('--once', 'process at most one row')
    .action(async (id: string, opts: { limit?: string; maxSeconds?: string; once?: boolean }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env);
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);
        const result = await runCampaignOnce(
          { db, config },
          id,
          {
            limit: opts.once ? 1 : opts.limit ? Number(opts.limit) : undefined,
            maxSeconds: opts.maxSeconds ? Number(opts.maxSeconds) : undefined,
          },
        );
        db.close();
        if (g.json) {
          process.stdout.write(`${JSON.stringify(result)}\n`);
        } else {
          process.stdout.write(`${result.stopped}: claimed=${result.claimed} sent=${result.sent} skipped=${result.skipped} failed=${result.failed}\n`);
        }
      } catch (err) {
        fail(err, g.json);
      }
    });

  campaign
    .command('pause <id>')
    .description('Pause a running campaign')
    .action((id: string, _opts: unknown, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);
        const result = transitionCampaignStatus(db, id, 'paused', Date.now(), 'paused by operator');
        db.close();
        if (!result.ok) throw explainTransitionError(id, result);
        process.stdout.write(g.json ? `${JSON.stringify({ id, status: 'paused' })}\n` : 'paused\n');
      } catch (err) {
        fail(err, g.json);
      }
    });

  campaign
    .command('resume <id>')
    .description('Resume a paused campaign')
    .option('--retry-indeterminate', 'requeue rows left in an indeterminate crash state')
    .action((id: string, opts: { retryIndeterminate?: boolean }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);
        // Finding #6: `resume` on a cancelled (terminal) campaign, or on an unknown id, used to
        // call setCampaignStatus unconditionally and ignore its boolean result - "resumed" printed
        // either way. transitionCampaignStatus only allows paused|draft -> running.
        const result = transitionCampaignStatus(db, id, 'running', Date.now());
        if (!result.ok) {
          db.close();
          throw explainTransitionError(id, result);
        }
        let requeued = 0;
        if (opts.retryIndeterminate) {
          requeued = requeueIndeterminate(db, id);
        }
        db.close();
        const output = { id, status: 'running', requeuedIndeterminate: requeued };
        if (g.json) {
          process.stdout.write(`${JSON.stringify(output)}\n`);
        } else {
          process.stdout.write(`resumed${requeued > 0 ? ` (requeued ${requeued} indeterminate row(s) - they may be duplicates if the earlier attempt actually reached the recipient)` : ''}\n`);
        }
      } catch (err) {
        fail(err, g.json);
      }
    });

  campaign
    .command('cancel <id>')
    .description('Cancel a campaign (terminal; already-sent rows are kept)')
    .option('--yes', 'skip confirmation')
    .action(async (id: string, opts: { yes?: boolean }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      // Finding #6/#12 precedent (src/cli/commands/forget.ts): --yes was declared but never read -
      // cancel is terminal and irreversible for a running send, so it deserves the same
      // "prompt unless told not to, and --json implies --yes since nothing can answer a prompt"
      // pattern forget.ts already established, not a bare unconditional status flip.
      const yes = opts.yes || !!g.json;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);
        const existing = getCampaign(db, id);
        if (!existing) {
          db.close();
          throw new Error(`no campaign ${id}`);
        }
        if (!yes) {
          process.stdout.write(`about to cancel campaign ${id} ("${existing.name}", currently ${existing.status}) - already-sent rows are kept.\n`);
          const proceed = await confirm('Proceed?');
          if (!proceed) {
            db.close();
            process.stdout.write('aborted, nothing changed\n');
            return;
          }
        }
        const result = transitionCampaignStatus(db, id, 'cancelled', Date.now(), 'cancelled by operator');
        db.close();
        if (!result.ok) throw explainTransitionError(id, result);
        process.stdout.write(g.json ? `${JSON.stringify({ id, status: 'cancelled' })}\n` : 'cancelled\n');
      } catch (err) {
        fail(err, g.json);
      }
    });

  campaign
    .command('list')
    .description('List campaigns')
    .option('--status <s>', 'draft|running|paused|completed|cancelled|failed|all', 'all')
    .option('--limit <n>', 'max rows', '200')
    .action((opts: { status?: string; limit?: string }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);
        const rows = listCampaigns(db, { status: (opts.status ?? 'all') as CampaignStatus | 'all', limit: Number(opts.limit ?? 200) });
        db.close();
        if (g.json) {
          process.stdout.write(`${JSON.stringify({ campaigns: rows })}\n`);
        } else if (rows.length === 0) {
          process.stdout.write('no campaigns\n');
        } else {
          for (const c of rows) {
            process.stdout.write(`${c.id}  ${c.status.padEnd(10)} ${c.name} (${c.total_rows} rows)\n`);
          }
        }
      } catch (err) {
        fail(err, g.json);
      }
    });

  campaign
    .command('show <id>')
    .description('Show one campaign')
    .action((id: string, _opts: unknown, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);
        const row = getCampaign(db, id);
        const counts = row ? campaignCounts(db, id) : null;
        db.close();
        if (!row) throw new Error(`no campaign ${id}`);
        const output = { campaign: row, counts };
        if (g.json) {
          process.stdout.write(`${JSON.stringify(output)}\n`);
        } else {
          process.stdout.write(`${row.name} (${row.status})\n${JSON.stringify(counts)}\n`);
        }
      } catch (err) {
        fail(err, g.json);
      }
    });

  campaign
    .command('stats <id>')
    .description('Per-variant stats and significance for a campaign')
    .action((id: string, _opts: unknown, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);
        const report = campaignReport(db, id);
        db.close();
        if (g.json) {
          process.stdout.write(`${JSON.stringify(report)}\n`);
        } else {
          process.stdout.write(`sent=${report.sent} opened=${report.opened} (${(report.openRate * 100).toFixed(1)}%) clicked=${report.clicked} replied=${report.replied}\n`);
          for (const v of report.variants) {
            process.stdout.write(`  variant ${v.variant}: sent=${v.sent} opened=${v.opened} (${(v.openRate * 100).toFixed(1)}%)\n`);
          }
          if (report.significance) {
            process.stdout.write(`  z=${report.significance.z.toFixed(3)} (${report.significance.variantA} vs ${report.significance.variantB}) - ${report.significance.caveat}\n`);
          }
        }
      } catch (err) {
        fail(err, g.json);
      }
    });

  campaign
    .command('rows <id>')
    .description('List a campaign\'s rows')
    .option('--status <s>', 'pending|claimed|sent|skipped|failed|all', 'all')
    .option('--limit <n>', 'max rows', '1000')
    .option('--csv', 'output as CSV')
    .action((id: string, opts: { status?: string; limit?: string; csv?: boolean }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);
        const rows = listRows(db, id, { status: (opts.status ?? 'all') as CampaignRowStatus | 'all', limit: Number(opts.limit ?? 1000) });
        db.close();
        if (opts.csv) {
          process.stdout.write(
            toCsvGeneric(
              rows.map((r) => ({ row_index: r.row_index, email: r.email, variant: r.variant, status: r.status, skip_reason: r.skip_reason ?? '', last_error: r.last_error ?? '' })),
              ['row_index', 'email', 'variant', 'status', 'skip_reason', 'last_error'],
            ),
          );
        } else if (g.json) {
          process.stdout.write(`${JSON.stringify({ rows })}\n`);
        } else {
          for (const r of rows) {
            process.stdout.write(`${r.row_index}  ${r.status.padEnd(8)} ${r.email}  ${r.skip_reason ?? r.last_error ?? ''}\n`);
          }
        }
      } catch (err) {
        fail(err, g.json);
      }
    });

  campaign
    .command('preview <id>')
    .description('Render one or more rows to disk without sending')
    .option('--row <n>', 'row index to render', '0')
    .option('--out <dir>', 'output directory', './preview')
    .action((id: string, opts: { row?: string; out?: string }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);
        const campaignRow = getCampaign(db, id);
        if (!campaignRow) throw new Error(`no campaign ${id}`);
        const rowIndex = Number(opts.row ?? 0);
        const row = db.prepare('SELECT * FROM campaign_rows WHERE campaign_id = ? AND row_index = ?').get(id, rowIndex) as
          | { vars_json: string; variant: string; email: string }
          | undefined;
        if (!row) throw new Error(`no row ${rowIndex} in campaign ${id}`);
        db.close();

        const vars = { ...(JSON.parse(row.vars_json) as Record<string, string>), email: row.email, campaign_name: campaignRow.name, sender_name: campaignRow.from_name ?? '', sender_email: campaignRow.from_email, unsubscribe_url: 'https://example.com/u/preview' };
        const allowRaw = campaignRow.allow_raw === 1;
        const subjectTemplate = campaignRow.subject_variants_json
          ? ((JSON.parse(campaignRow.subject_variants_json) as Variant[]).find((v) => v.key === row.variant)?.template ?? campaignRow.subject_template)
          : campaignRow.subject_template;
        const subject = renderTemplate(subjectTemplate, vars, { mode: 'subject', allowRaw });
        const html = renderTemplate(campaignRow.body_html_template, vars, { mode: 'html', allowRaw });

        const outDir = opts.out ?? './preview';
        mkdirSync(outDir, { recursive: true });
        const base = `${id}.${rowIndex}`;
        writeFileSync(join(outDir, `${base}.html`), html);
        writeFileSync(join(outDir, `${base}.txt`), `Subject: ${subject}\n\n${html.replace(/<[^>]+>/g, '')}`);
        const output = { campaignId: id, row: rowIndex, subject, htmlPath: join(outDir, `${base}.html`) };
        process.stdout.write(g.json ? `${JSON.stringify(output)}\n` : `wrote ${output.htmlPath}\nsubject: ${subject}\n`);
      } catch (err) {
        fail(err, g.json);
      }
    });
}

function resolveEnvAccountId(db: DB, config: ReturnType<typeof loadConfig>): string {
  if (!config.fromEmail) throw new Error('no sender: pass --from-account or set FROM_EMAIL');
  const row = db.prepare('SELECT id FROM accounts WHERE email = ?').get(config.fromEmail) as { id: string } | undefined;
  if (row) return row.id;
  return ensureAccount(db, { email: config.fromEmail, displayName: config.fromName, transport: config.mailTransport }).id;
}
