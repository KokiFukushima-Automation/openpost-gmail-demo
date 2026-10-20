import { execFileSync } from 'node:child_process';
import type { Command } from 'commander';
import { buildTunnelPlan, detectBinary, type TunnelProvider } from '../../core/tunnel.js';
import { fail } from '../util.js';
import type { GlobalOpts } from '../util.js';

interface TunnelOpts {
  provider?: string;
  port?: string;
  hostname?: string;
  exec?: boolean;
}

const PROVIDERS: TunnelProvider[] = ['cloudflare', 'ngrok', 'flyio'];
const BINARY_BY_PROVIDER: Record<TunnelProvider, string> = {
  cloudflare: 'cloudflared',
  ngrok: 'ngrok',
  flyio: 'flyctl',
};

function which(name: string): string | null {
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
      .split('\n')[0];
    return found && found.length > 0 ? found : null;
  } catch {
    return null;
  }
}

export function registerTunnelCommand(program: Command): void {
  program
    .command('tunnel')
    .description('Print (or run) the commands to expose the tracking server publicly')
    .option('--provider <name>', 'cloudflare | ngrok | flyio', 'cloudflare')
    .option('--port <n>', 'local port the tracking server listens on', '8787')
    .option('--hostname <host>', 'public hostname (cloudflare/flyio)')
    .option('--exec', 'run the provider binary if it is already on PATH')
    .action((opts: TunnelOpts, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const provider = (opts.provider ?? 'cloudflare') as TunnelProvider;
        if (!PROVIDERS.includes(provider)) {
          throw new Error(`--provider must be one of ${PROVIDERS.join(', ')}`);
        }
        const planOpts: { provider: TunnelProvider; port: number; hostname?: string } = {
          provider,
          port: Number(opts.port ?? 8787),
        };
        if (opts.hostname !== undefined) planOpts.hostname = opts.hostname;
        const plan = buildTunnelPlan(planOpts);

        if (g.json) {
          process.stdout.write(`${JSON.stringify(plan)}\n`);
        } else {
          process.stdout.write(`# ${plan.provider} tunnel plan\n\nprerequisites:\n`);
          for (const p of plan.prerequisites) process.stdout.write(`  - ${p}\n`);
          process.stdout.write('\ncommands:\n');
          for (const c of plan.commands) process.stdout.write(`  ${c}\n`);
          process.stdout.write('\nenv (in the shell that runs openpost):\n');
          for (const e of plan.envExports) process.stdout.write(`  ${e}\n`);
          process.stdout.write('\nverify:\n');
          for (const v of plan.verify) process.stdout.write(`  ${v}\n`);
          if (plan.warnings.length > 0) {
            process.stdout.write('\nwarnings:\n');
            for (const w of plan.warnings) process.stdout.write(`  ! ${w}\n`);
          }
        }

        if (opts.exec) {
          const binaryName = BINARY_BY_PROVIDER[provider];
          const found = detectBinary(binaryName, which);
          if (!found) {
            process.stderr.write(`error: ${binaryName} is not on PATH - install it first, then re-run with --exec\n`);
            process.exit(2);
          }
          process.stdout.write(`\n--exec: found ${binaryName} at ${found}. Run the commands above yourself in order -\n`);
          process.stdout.write('openpost never runs an interactive login or a long-lived daemon on your behalf.\n');
        }
      } catch (err) {
        fail(err, g.json);
      }
    });
}
