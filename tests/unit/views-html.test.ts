import { readFileSync, readdirSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { describe, expect, it } from 'vitest';
import { attr, classNames, escapeHtml, href, html, join, raw, render } from '../../src/server/views/html.js';
import { layout } from '../../src/server/views/layout.js';
import { recipientRow } from '../../src/server/views/fragments.js';
import { RULE_DOC } from '../../src/server/views/format.js';
import { CLASSIFY_RULE_IDS } from '../../src/core/classify.js';

describe('views/html', () => {
  it('121. html escapes & < > " \' / in interpolations; raw() passes through; arrays join without separators; null/undefined/false render empty', () => {
    const evil = `& < > " ' /`;
    const doc = html`<p>${evil}</p>`;
    expect(render(doc)).toBe('<p>&amp; &lt; &gt; &quot; &#39; &#47;</p>');

    const rawDoc = html`<p>${raw('<b>bold</b>')}</p>`;
    expect(render(rawDoc)).toBe('<p><b>bold</b></p>');

    const arrDoc = html`${['a', 'b', 'c']}`;
    expect(render(arrDoc)).toBe('abc');

    const nully = html`[${null}][${undefined}][${false}]`;
    expect(render(nully)).toBe('[][][]');
  });

  it('122. a script-injecting subject renders escaped and never re-appears as markup', () => {
    const subject = '"><script>alert(1)</script>';
    const doc = html`<td>${subject}</td>`;
    const out = render(doc);
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('123. href() percent-encodes a query string; attr() is quote-safe', () => {
    const url = href('/dashboard/messages', { q: 'a&b', offset: 25 });
    expect(url).toBe('/dashboard/messages?q=a%26b&offset=25');

    const value = attr('"><script>');
    const doc = html`<input value="${raw(value)}">`;
    expect(render(doc)).not.toContain('"><script>');
    expect(render(doc)).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('href() omits undefined/null/empty params', () => {
    expect(href('/x', { a: undefined, b: null, c: '', d: 1 })).toBe('/x?d=1');
    expect(href('/x', {})).toBe('/x');
  });

  it('escapeHtml escapes every documented character', () => {
    expect(escapeHtml('&<>"\'/')).toBe('&amp;&lt;&gt;&quot;&#39;&#47;');
  });

  it('join() concatenates SafeHtml/plain values with an optional separator', () => {
    const parts = [html`<a>`, html`<b>`];
    expect(render(join(parts, ','))).toBe('<a>,<b>');
  });

  it('classNames() keeps only truthy entries', () => {
    expect(classNames({ a: true, b: false, c: true })).toBe('a c');
  });

  it('124. layout() emits <html lang="en">, a skip link, one <h1>, <main id="main">, and links only /dashboard/assets/* (no external origins)', () => {
    const out = render(layout({ title: 'Messages', active: 'messages', body: html`<h1>Messages</h1>`, csrf: 'tok', live: true }));
    expect(out).toContain('<html lang="en">');
    expect(out).toContain('class="skip-link"');
    expect((out.match(/<h1[ >]/g) ?? []).length).toBe(1);
    expect(out).toContain('<main id="main">');
    const hrefs = [...out.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1] as string);
    // No external origin anywhere in the page; every stylesheet/script src is a same-origin asset.
    for (const h of hrefs) {
      expect(h).not.toMatch(/^https?:\/\//);
    }
    const assetHrefs = [...out.matchAll(/<(?:link[^>]*rel="stylesheet"|script)[^>]*src="([^"]+)"/g)];
    for (const [, src] of assetHrefs) {
      expect(src?.startsWith('/dashboard/assets/')).toBe(true);
    }
  });

  it('125. fragments.recipientRow() carries data-recipient-id and data-message-id and renders state as text + icon (not colour alone)', () => {
    const out = render(
      recipientRow({
        id: 'rid1',
        messageId: 'mid1',
        email: 'a@example.com',
        kind: 'to',
        state: 'read_confirmed',
        openCount: 2,
        machineOpenCount: 0,
        clickCount: 1,
        repliedAt: null,
        pendingReminder: false,
        nowMs: Date.now(),
      }),
    );
    expect(out).toContain('data-recipient-id="rid1"');
    expect(out).toContain('data-message-id="mid1"');
    expect(out).toContain('Read confirmed');
    expect(out).toMatch(/aria-hidden="true">[^<]+</);
  });

  it('126. format.RULE_DOC has an entry for every rule id the classifier can emit', () => {
    for (const id of CLASSIFY_RULE_IDS) {
      expect(RULE_DOC[id]).toBeTruthy();
    }
  });

  // Phase 3.1 (L2/M9 #121-123): `raw()` is the ONLY unescaped-injection path (html.ts's own doc
  // comment) - a page module must never call it on a bare DB-sourced value (the state badge and
  // flash `kind` both used to). This is a real grep test, not a restatement of the implementation:
  // it parses every `raw(...)` call in `views/pages/` and fails if the argument is anything other
  // than a string literal or a ternary between two string literals.
  function extractRawCallArgs(source: string): string[] {
    const args: string[] = [];
    const callRe = /\braw\(/g;
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(source)) !== null) {
      let depth = 1;
      let i = m.index + m[0].length;
      const start = i;
      while (i < source.length && depth > 0) {
        if (source[i] === '(') depth += 1;
        else if (source[i] === ')') depth -= 1;
        i += 1;
      }
      args.push(source.slice(start, i - 1));
    }
    return args;
  }

  const RAW_ALLOWED_ARG =
    /^(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|[\w.]+\s*\?\s*'(?:[^'\\]|\\.)*'\s*:\s*'(?:[^'\\]|\\.)*')$/;

  it("127. grep: raw() in views/pages/ only ever wraps a literal (or a ternary of two literals), never a bare DB-sourced value", () => {
    const pagesDir = joinPath(process.cwd(), 'src', 'server', 'views', 'pages');
    const files = readdirSync(pagesDir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    let checked = 0;
    for (const file of files) {
      const src = readFileSync(joinPath(pagesDir, file), 'utf8');
      for (const arg of extractRawCallArgs(src)) {
        checked += 1;
        expect(RAW_ALLOWED_ARG.test(arg.trim()), `${file}: raw(${arg}) is not an allow-listed literal argument`).toBe(true);
      }
    }
    // Guards against the test silently checking nothing if every raw() call is ever removed from
    // pages/ - messages.ts's `<option ... raw(selected ? 'selected' : '')>` is expected to remain.
    expect(checked).toBeGreaterThan(0);
  });

  it('128. state badges and the flash banner never import raw() at all (format.ts/fragments.ts, the two findings that motivated 127)', () => {
    for (const file of ['format.ts', 'fragments.ts']) {
      const src = readFileSync(joinPath(process.cwd(), 'src', 'server', 'views', file), 'utf8');
      const importLine = src.split('\n').find((l) => l.includes("from './html.js'")) ?? '';
      expect(importLine).not.toMatch(/\braw\b/);
    }
  });
});
