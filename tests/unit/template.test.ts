import { describe, expect, it } from 'vitest';
import { collectVars, renderTemplate, sanitizeHeaderValue, TemplateError } from '../../src/core/template.js';
import { assertSafeHrefs } from '../../src/core/html.js';

describe('template', () => {
  it('240. {{name}} is HTML-escaped in html mode and verbatim in text mode', () => {
    const src = 'Hi {{name}}';
    expect(renderTemplate(src, { name: '<b>&"\'' }, { mode: 'html' })).toBe('Hi &lt;b&gt;&amp;&quot;&#39;');
    expect(renderTemplate(src, { name: '<b>&"\'' }, { mode: 'text' })).toBe('Hi <b>&"\'');
  });

  it('241. {{{name}}} throws without allowRaw and passes through with it', () => {
    const src = 'Hi {{{name}}}';
    expect(() => renderTemplate(src, { name: '<b>' }, { mode: 'html' })).toThrow(TemplateError);
    expect(renderTemplate(src, { name: '<b>' }, { mode: 'html', allowRaw: true })).toBe('Hi <b>');
  });

  it('242. an unknown key throws TemplateError naming the key - never renders empty', () => {
    try {
      renderTemplate('Hi {{missing}}', {}, { mode: 'html' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateError);
      expect((err as TemplateError).key).toBe('missing');
    }
  });

  it('243. collectVars returns sorted unique keys', () => {
    expect(collectVars('{{b}} {{a}} {{b}} {{{a}}}')).toEqual(['a', 'b']);
  });

  it('244 (reserved-key enforcement lives in campaign create; here we just prove collectVars sees it)', () => {
    expect(collectVars('{{email}} {{unsubscribe_url}}')).toEqual(['email', 'unsubscribe_url']);
  });

  it('245. a value containing {{other}} is not re-rendered (single pass)', () => {
    const out = renderTemplate('{{a}}', { a: '{{b}}' }, { mode: 'text' });
    expect(out).toBe('{{b}}');
  });

  it('246. an unterminated {{ throws with a byte offset', () => {
    try {
      renderTemplate('Hi {{name', {}, { mode: 'text' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateError);
      expect((err as TemplateError).offset).toBe(3);
    }
  });

  it('247. an invalid key charset throws', () => {
    expect(() => renderTemplate('{{bad key!}}', {}, { mode: 'text' })).toThrow(TemplateError);
  });

  it('248. subject mode never HTML-escapes (an apostrophe stays an apostrophe)', () => {
    expect(renderTemplate("Hi {{name}}'s", { name: "O'Brien" }, { mode: 'subject' })).toBe("Hi O'Brien's");
  });

  it('249. sanitizeHeaderValue strips CR/LF/NUL, collapses whitespace, truncates at 900 bytes', () => {
    const injected = sanitizeHeaderValue('X\r\nBcc: attacker@evil.com');
    expect(injected).not.toMatch(/[\r\n]/);
    expect(injected).toBe('X Bcc: attacker@evil.com');
    const long = sanitizeHeaderValue('a'.repeat(2000));
    expect(Buffer.byteLength(long, 'utf8')).toBeLessThanOrEqual(900);
    // Rendered through the subject-mode path, a CR/LF-carrying cell cannot produce a second header.
    const rendered = renderTemplate('Hi {{x}}', { x: 'Y\r\nBcc: evil@example.com' }, { mode: 'subject' });
    expect(rendered).not.toMatch(/[\r\n]/);
  });

  it('250. assertSafeHrefs rejects javascript:/data: hrefs and accepts http/https/mailto/cid', () => {
    expect(() => assertSafeHrefs('<a href="javascript:alert(1)">x</a>')).toThrow(/unsafe/);
    expect(() => assertSafeHrefs('<img src="data:text/html,evil">')).toThrow(/unsafe/);
    expect(() => assertSafeHrefs('<a href="https://example.com">x</a><a href="mailto:a@b.com">y</a><a href="cid:abc">z</a>')).not.toThrow();
  });

  it('251. a rendered body with a 4KB variable stays one string with the value intact', () => {
    const big = 'x'.repeat(4096);
    const out = renderTemplate('<p>{{v}}</p>', { v: big }, { mode: 'html' });
    expect(out).toBe(`<p>${big}</p>`);
  });
});
