#!/usr/bin/env node
// A tiny local webhook receiver for the Phase 2 curl smoke test (docs/05_phase2_spec.md §7.6).
// Verifies every delivery's X-Openpost-Signature against WEBHOOK_SECRET and prints VALID/INVALID.
//
// Usage: node scripts/fake-receiver.mjs <port>
//   WEBHOOK_SECRET must be set in the environment (the same value passed to `openpost serve`).

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 9099);
const secret = process.env.WEBHOOK_SECRET;

if (!secret) {
  console.error('WEBHOOK_SECRET is not set - cannot verify deliveries');
  process.exit(2);
}

function verify(headers, rawBody) {
  const signatureHeader = headers['x-openpost-signature'] ?? '';
  const timestampHeader = headers['x-openpost-timestamp'] ?? '';
  const match = /^sha256=([0-9a-f]{64})$/.exec(signatureHeader);
  if (!match) return { ok: false, reason: 'missing/malformed X-Openpost-Signature' };

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: 'missing/invalid X-Openpost-Timestamp' };
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > 300) return { ok: false, reason: 'timestamp more than 5 minutes old' };

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  const given = Buffer.from(match[1], 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true };
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const result = verify(req.headers, rawBody);
    const label = result.ok ? 'VALID' : `INVALID (${result.reason})`;
    console.log(`[fake-receiver] ${req.method} ${req.url} event=${req.headers['x-openpost-event']} delivery=${req.headers['x-openpost-delivery']} -> ${label}`);
    console.log(`[fake-receiver] body: ${rawBody}`);
    res.writeHead(result.ok ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: result.ok }));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[fake-receiver] listening on http://127.0.0.1:${port}`);
});
