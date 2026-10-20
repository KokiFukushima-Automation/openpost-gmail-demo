import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setupTestServer } from '../helpers/setup.js';
import { runSend } from '../../src/mail/send-run.js';

const APP_CSS = readFileSync(join(process.cwd(), 'src', 'server', 'assets', 'app.css'), 'utf8');

describe('responsive rendering (docs/09_phase5_spec.md §3)', () => {
  it('382/383. every <td> on the message list carries a non-empty data-label, and the table is inside .table-wrap', async () => {
    const { app, db, config } = setupTestServer();
    await runSend({ db, config }, { to: ['a@example.com'], cc: [], bcc: [], subject: 'Hi', html: '<p>hi</p>', text: 'hi', track: true, trackClicks: undefined, optOutLink: false, mute: false });

    const res = await app.inject({ method: 'GET', url: '/dashboard/messages' });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body).toContain('<div class="table-wrap">');
    const tdMatches = [...body.matchAll(/<td(?:\s[^>]*)?>/g)];
    expect(tdMatches.length).toBeGreaterThan(0);
    for (const m of tdMatches) {
      expect(m[0]).toMatch(/data-label="[^"]+"/);
    }
  });

  it('384. the bottom nav lists exactly the six NavKeys and marks the active one with aria-current', async () => {
    const { app } = setupTestServer();
    const res = await app.inject({ method: 'GET', url: '/dashboard/messages' });
    const navMatch = /<nav class="nav-bottom"[^>]*>([\s\S]*?)<\/nav>/.exec(res.body);
    expect(navMatch).not.toBeNull();
    const nav = navMatch![1] as string;
    // Interpolated href values are escaped by the `html` tagged template (including `/` ->
    // `&#47;`, which a browser decodes back to `/` when parsing the attribute) - decode that one
    // entity back for a readable assertion.
    const hrefs = [...nav.matchAll(/href="([^"]+)"/g)].map((m) => (m[1] as string).replace(/&#47;/g, '/'));
    expect(hrefs).toEqual([
      '/dashboard/messages',
      '/dashboard/compose',
      '/dashboard/campaigns',
      '/dashboard/reminders',
      '/dashboard/stats',
      '/dashboard/settings',
    ]);
    expect(nav).toContain('aria-current="page"');
    // Exactly one active item.
    expect((nav.match(/aria-current="page"/g) ?? []).length).toBe(1);
  });

  it('385. thead is visually hidden (clip-based), not display:none, at the phone breakpoint', () => {
    const block = /@media \(max-width: 480px\) \{[\s\S]*?\.table-wrap thead \{([\s\S]*?)\}/.exec(APP_CSS);
    expect(block).not.toBeNull();
    const decl = block![1] as string;
    expect(decl).toMatch(/clip:\s*rect\(0,\s*0,\s*0,\s*0\)/);
    expect(decl).not.toMatch(/display:\s*none/);
  });

  it('386. the filter form renders <details open> when a filter is active and closed otherwise', async () => {
    const { app } = setupTestServer();
    const withFilter = await app.inject({ method: 'GET', url: '/dashboard/messages?q=hello' });
    expect(withFilter.body).toMatch(/<details class="filter-form" open>/);
    const withoutFilter = await app.inject({ method: 'GET', url: '/dashboard/messages' });
    expect(withoutFilter.body).toMatch(/<details class="filter-form" >/);
    expect(withoutFilter.body).not.toContain('<details class="filter-form" open>');
  });

  it('387. desktop layout (>860px) is unaffected: the header nav and filter form remain server-rendered exactly as before, forced open by CSS above 860px', () => {
    expect(APP_CSS).toMatch(/@media \(min-width: 861px\) \{[\s\S]*?\.filter-form summary \{ display: none; \}/);
  });

  it('388. no page module emits an inline style= or a <script> without src', async () => {
    const { app, db, config } = setupTestServer();
    await runSend({ db, config }, { to: ['a@example.com'], cc: [], bcc: [], subject: 'Hi', html: '<p>hi</p>', text: 'hi', track: true, trackClicks: undefined, optOutLink: false, mute: false });
    const paths = ['/dashboard/messages', '/dashboard/campaigns', '/dashboard/reminders', '/dashboard/stats', '/dashboard/audit', '/dashboard/compose', '/dashboard/settings'];
    for (const path of paths) {
      const res = await app.inject({ method: 'GET', url: path });
      expect(res.statusCode, path).toBe(200);
      expect(res.body, path).not.toMatch(/\sstyle=/);
      // A <script> with no src attribute at all (an inline script body) is disallowed; every
      // <script> emitted must carry src="...".
      const scriptTags = [...res.body.matchAll(/<script(\s[^>]*)?>/g)];
      for (const tag of scriptTags) {
        expect(tag[0], `${path}: ${tag[0]}`).toMatch(/\ssrc="/);
      }
    }
  });
});
