import { createHash, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config/env.js';

/** Hash-then-compare normalises both operands to a fixed 32-byte length before the constant-time
 *  comparison, so there is no early-return-on-length-mismatch branch to time either (finding #18).
 *  Shared by every `/api`-prefixed route (messages, SSE, reclassify) so they all key auth on the
 *  same rule: a bearer is required whenever `API_TOKEN` is configured at all (finding #2). */
function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function apiAuthRequired(config: AppConfig): boolean {
  return config.apiToken !== undefined;
}

export function isValidApiBearer(config: AppConfig, header: string | string[] | undefined): boolean {
  if (!apiAuthRequired(config)) return true;
  if (typeof header !== 'string') return false;
  const expected = `Bearer ${config.apiToken as string}`;
  return constantTimeEqual(header, expected);
}
