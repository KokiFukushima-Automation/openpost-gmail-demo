/**
 * `openpost init`'s interactive wizard, built on `node:readline/promises` with injected streams
 * (docs/08_phase4_spec.md §4.1) - the whole flow is driven from a test with a scripted stdin and
 * asserted on the produced `.env`, no TTY/pty and no new dependency.
 */
import { createInterface } from 'node:readline/promises';
import type { TransportName } from '../types.js';

export interface PromptIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  isTty: boolean;
}

export interface WizardAnswers {
  dataDir: string;
  baseUrl: string;
  fromEmail: string;
  fromName: string | null;
  transport: TransportName;
  dashboardPassword: string | null;
  generateMasterKey: boolean;
  enableTunnelHint: boolean;
  /** docs/09_phase5_spec.md §7.4: "Send notifications to your phone via Web Push?" - when true,
   *  `init.ts` generates a VAPID pair and `renderEnvFile` writes NOTIFY_CHANNELS=webpush + VAPID_*. */
  enablePush: boolean;
}

const TRANSPORTS: TransportName[] = ['dryrun', 'smtp', 'gmail', 'gmail-smtp'];

function isValidTransport(v: string): v is TransportName {
  return (TRANSPORTS as string[]).includes(v);
}

export async function runWizard(io: PromptIo, defaults: Partial<WizardAnswers>): Promise<WizardAnswers> {
  const rl = createInterface({ input: io.input, output: io.output, terminal: io.isTty });
  try {
    const ask = async (prompt: string, fallback: string): Promise<string> => {
      const answer = (await rl.question(`${prompt} [${fallback}]: `)).trim();
      return answer.length > 0 ? answer : fallback;
    };
    const askYesNo = async (prompt: string, fallback: boolean): Promise<boolean> => {
      const answer = (await rl.question(`${prompt} [${fallback ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase();
      if (answer.length === 0) return fallback;
      return answer === 'y' || answer === 'yes';
    };

    const dataDir = await ask('Data directory', defaults.dataDir ?? './data');
    const baseUrl = await ask('Public tracking base URL', defaults.baseUrl ?? 'http://127.0.0.1:8787');
    const fromEmail = await ask('Default sender email', defaults.fromEmail ?? '');
    const fromNameRaw = await ask('Default sender name (optional)', defaults.fromName ?? '');
    let transport: TransportName = defaults.transport ?? 'dryrun';
    for (;;) {
      const answer = await ask('Mail transport (dryrun/smtp/gmail/gmail-smtp)', transport);
      if (isValidTransport(answer)) {
        transport = answer;
        break;
      }
      io.output.write('please enter one of: dryrun, smtp, gmail, gmail-smtp\n');
    }
    const wantPassword = await askYesNo('Set a dashboard password now?', defaults.dashboardPassword !== null && defaults.dashboardPassword !== undefined);
    const dashboardPassword = wantPassword ? (await ask('Dashboard password', defaults.dashboardPassword ?? '')) || null : null;
    const generateMasterKey = await askYesNo('Generate an account-secrets master key now?', defaults.generateMasterKey ?? true);
    const enablePush = await askYesNo('Send notifications to your phone via Web Push?', defaults.enablePush ?? false);
    const enableTunnelHint = await askYesNo('Show tunnel setup instructions at the end?', defaults.enableTunnelHint ?? true);

    return {
      dataDir,
      baseUrl,
      fromEmail,
      fromName: fromNameRaw.length > 0 ? fromNameRaw : null,
      transport,
      dashboardPassword,
      generateMasterKey,
      enableTunnelHint,
      enablePush,
    };
  } finally {
    rl.close();
  }
}

// Finding #12 (docs/reports/phase4_review.md): every value used to be written verbatim
// (`KEY=value`) with no quoting or escaping at all - `init --yes --dashboard-password
// $'x\nAPI_TOKEN=abc'` injected an extra, attacker/typo-controlled assignment into the generated
// `.env`, and a value with a leading/trailing space or an embedded `#` round-tripped wrong (dotenv
// treats `#` outside quotes as starting a comment). Node's own `dotenv` package (this project's
// `.env` parser) is deliberately conservative about escaping inside quotes - it expands `\n`/`\r`
// only inside double quotes and does no escape processing at all inside single quotes - so rather
// than emit an escape sequence dotenv might not round-trip correctly, this picks whichever quote
// style needs none for a given value, and refuses outright (a clear error, not a corrupted file)
// for the handful of values neither style can represent.
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function quoteEnvValue(key: string, value: string): string {
  if (hasControlChar(value)) {
    throw new Error(`refusing to write ${key} to .env: its value contains a control character (a literal newline included), which could inject an extra assignment or corrupt the file`);
  }
  const needsQuoting = value.length === 0 || value !== value.trim() || /[#"'\\]/.test(value);
  if (!needsQuoting) return `${key}=${value}`;
  const hasSingleQuote = value.includes("'");
  const hasDoubleQuote = value.includes('"');
  if (!hasSingleQuote) return `${key}='${value}'`; // dotenv takes single-quoted content completely literally
  if (!hasDoubleQuote) return `${key}="${value}"`; // no \n/\r sequences to worry about - control chars were already rejected above
  throw new Error(`refusing to write ${key} to .env: its value contains both a single and a double quote character, which cannot be safely represented`);
}

/** Renders the `.env` file the wizard (or `--yes` flags) produces. Round-trips through
 *  `loadConfig` with zero issues (test 322). */
export function renderEnvFile(
  answers: WizardAnswers,
  generated: { trackingSecret: string; vapidKeys?: { publicKey: string; privateKey: string } },
): string {
  const lines: string[] = [
    '# Generated by `openpost init` - see docs/deploy.md for every variable.',
    quoteEnvValue('TRACKING_SECRET', generated.trackingSecret),
    quoteEnvValue('TRACKING_BASE_URL', answers.baseUrl),
    quoteEnvValue('DB_PATH', `${answers.dataDir}/openpost.db`),
    quoteEnvValue('OUT_DIR', `${answers.dataDir}/out`),
  ];
  if (answers.fromEmail) lines.push(quoteEnvValue('FROM_EMAIL', answers.fromEmail));
  if (answers.fromName) lines.push(quoteEnvValue('FROM_NAME', answers.fromName));
  lines.push(quoteEnvValue('MAIL_TRANSPORT', answers.transport));
  if (answers.dashboardPassword) {
    lines.push(quoteEnvValue('DASHBOARD_PASSWORD', answers.dashboardPassword));
  }
  if (answers.generateMasterKey) {
    lines.push(quoteEnvValue('OPENPOST_MASTER_KEY_FILE', `${answers.dataDir}/config/master.key`));
  }
  // docs/09_phase5_spec.md §7.4: "Send notifications to your phone via Web Push?" - generates and
  // writes VAPID_* plus NOTIFY_CHANNELS=webpush, the same treatment TRACKING_SECRET already gets.
  if (answers.enablePush && generated.vapidKeys) {
    lines.push(quoteEnvValue('NOTIFY_CHANNELS', 'webpush'));
    lines.push(quoteEnvValue('VAPID_PUBLIC_KEY', generated.vapidKeys.publicKey));
    lines.push(quoteEnvValue('VAPID_PRIVATE_KEY', generated.vapidKeys.privateKey));
    if (answers.fromEmail) {
      lines.push(quoteEnvValue('VAPID_SUBJECT', `mailto:${answers.fromEmail}`));
    }
  }
  lines.push('');
  return lines.join('\n');
}
