import { describe, expect, it } from 'vitest';
import { buildTunnelPlan, detectBinary } from '../../src/core/tunnel.js';

describe('buildTunnelPlan', () => {
  it("110a. cloudflare returns the four cloudflared commands, the TRACKING_BASE_URL/TRUST_PROXY exports and the doctor verify line", () => {
    const plan = buildTunnelPlan({ provider: 'cloudflare', port: 8787, hostname: 't.example.com' });
    expect(plan.commands).toHaveLength(4);
    expect(plan.commands.some((c) => c.includes('cloudflared tunnel login'))).toBe(true);
    expect(plan.commands.some((c) => c.includes('cloudflared tunnel create'))).toBe(true);
    expect(plan.commands.some((c) => c.includes('cloudflared tunnel route dns'))).toBe(true);
    expect(plan.commands.some((c) => c.includes('cloudflared tunnel run --url http://127.0.0.1:8787'))).toBe(true);
    expect(plan.envExports).toContain('export TRACKING_BASE_URL=https://t.example.com');
    expect(plan.envExports).toContain('export TRUST_PROXY=true');
    expect(plan.verify[0]).toBe('openpost doctor --url https://t.example.com');
  });

  it('110b. ngrok carries the blocklist warning', () => {
    const plan = buildTunnelPlan({ provider: 'ngrok', port: 8787 });
    expect(plan.commands).toEqual(['ngrok http 8787']);
    expect(plan.warnings.some((w) => w.includes('ngrok-free.app') && w.includes('blocklisted'))).toBe(true);
  });

  it('110c. flyio names the volume and min_machines_running = 1', () => {
    const plan = buildTunnelPlan({ provider: 'flyio', port: 8787, hostname: 'myapp.fly.dev' });
    expect(plan.commands.some((c) => c.includes('fly volumes create'))).toBe(true);
    expect(plan.warnings.some((w) => w.includes('min_machines_running = 1'))).toBe(true);
    expect(plan.verify[0]).toBe('openpost doctor --url https://myapp.fly.dev');
  });
});

describe('detectBinary', () => {
  it('is a thin wrapper over the injected which()', () => {
    expect(detectBinary('cloudflared', () => '/usr/bin/cloudflared')).toBe('/usr/bin/cloudflared');
    expect(detectBinary('cloudflared', () => null)).toBeNull();
  });
});
