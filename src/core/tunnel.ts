export type TunnelProvider = 'cloudflare' | 'ngrok' | 'flyio';

export interface TunnelPlan {
  provider: TunnelProvider;
  prerequisites: string[];
  commands: string[];
  envExports: string[];
  verify: string[];
  warnings: string[];
}

export interface BuildTunnelPlanOpts {
  provider: TunnelProvider;
  port: number;
  hostname?: string;
  tunnelName?: string;
}

/** `openpost tunnel` is a planner, never a daemon: it never installs anything, and without
 *  `--exec` it only ever prints this plan (§3.2). */
export function buildTunnelPlan(opts: BuildTunnelPlanOpts): TunnelPlan {
  switch (opts.provider) {
    case 'cloudflare':
      return buildCloudflarePlan(opts);
    case 'ngrok':
      return buildNgrokPlan(opts);
    case 'flyio':
      return buildFlyioPlan(opts);
  }
}

function buildCloudflarePlan(opts: BuildTunnelPlanOpts): TunnelPlan {
  const tunnelName = opts.tunnelName ?? 'openpost';
  const hostname = opts.hostname ?? '<hostname, e.g. t.example.com>';
  return {
    provider: 'cloudflare',
    prerequisites: [
      'cloudflared CLI installed (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)',
      'a Cloudflare account with the sending domain (or a subdomain of it) on Cloudflare DNS',
    ],
    commands: [
      'cloudflared tunnel login',
      `cloudflared tunnel create ${tunnelName}`,
      `cloudflared tunnel route dns ${tunnelName} ${hostname}`,
      `cloudflared tunnel run --url http://127.0.0.1:${opts.port} ${tunnelName}`,
    ],
    envExports: [
      `export TRACKING_BASE_URL=https://${hostname}`,
      'export TRUST_PROXY=true',
      'export BIND_ADDRESS=127.0.0.1',
    ],
    verify: [`openpost doctor --url https://${hostname}`],
    warnings: [
      'Recommended: stable hostname on your own domain, free, no inbound port opened, a real ' +
        'certificate, and a subdomain of your sending domain (doc 02 §3 spam-safety requirement).',
    ],
  };
}

function buildNgrokPlan(opts: BuildTunnelPlanOpts): TunnelPlan {
  return {
    provider: 'ngrok',
    prerequisites: ['ngrok CLI installed (https://ngrok.com/download)', 'an ngrok account (free tier is fine)'],
    commands: [`ngrok http ${opts.port}`],
    envExports: [
      'export TRACKING_BASE_URL=https://<random>.ngrok-free.app  # use the exact URL ngrok prints',
      'export TRUST_PROXY=true',
      'export BIND_ADDRESS=127.0.0.1',
    ],
    verify: ['openpost doctor --url <the ngrok URL ngrok printed>'],
    warnings: [
      '`*.ngrok-free.app` is heavily blocklisted; never use it for a real send - use it only to ' +
        'confirm that an inbound request reaches your pixel.',
    ],
  };
}

function buildFlyioPlan(opts: BuildTunnelPlanOpts): TunnelPlan {
  const hostname = opts.hostname ?? '<app>.fly.dev';
  return {
    provider: 'flyio',
    prerequisites: [
      'flyctl CLI installed and authenticated (https://fly.io/docs/flyctl/)',
      'a Fly.io app with a persistent volume mounted at /data',
    ],
    commands: [
      'fly launch --no-deploy',
      'fly volumes create openpost_data --size 1',
      'fly secrets set TRACKING_SECRET=... WEBHOOK_SECRET=...',
      'fly deploy',
    ],
    envExports: [
      'export DB_PATH=/data/openpost.db',
      'export BIND_ADDRESS=0.0.0.0',
      'export TRUST_PROXY=true',
      `export TRACKING_BASE_URL=https://${hostname}`,
    ],
    verify: [`openpost doctor --url https://${hostname}`],
    warnings: [
      'One machine only: min_machines_running = 1 and autoscaling off - SQLite tolerates exactly ' +
        'one writer.',
      `In fly.toml set internal_port = ${opts.port} and force_https = true.`,
      'Vercel is not supported for the main instance (no persistent SQLite).',
    ],
  };
}

/** Thin, injectable wrapper so tests never touch `PATH`: `which('cloudflared')` in production,
 *  a literal function in tests (§3.2). */
export function detectBinary(name: string, which: (n: string) => string | null): string | null {
  return which(name);
}
