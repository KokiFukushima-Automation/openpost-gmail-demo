import { describe, expect, it } from 'vitest';
import { collectLinks, htmlToText, injectPixel, rewriteLinks } from '../../src/core/html.js';

const PIXEL_SRC = 'https://t.example.com/o/1abc.def.gif?v=xyz12345';

describe('html', () => {
  it('7. injectPixel inserts exactly one <img> immediately before </body>', () => {
    const html = '<html><body><p>Hello</p></body></html>';
    const result = injectPixel(html, PIXEL_SRC);
    expect(result.injected).toBe(true);
    expect((result.html.match(/<img/g) ?? []).length).toBe(1);

    const bodyCloseIdx = result.html.indexOf('</body>');
    const imgMatch = /<img[^>]*\/>/.exec(result.html);
    expect(imgMatch).not.toBeNull();
    const imgTag = imgMatch?.[0] as string;
    const imgIdx = result.html.indexOf(imgTag);
    // The img tag sits immediately before </body>, with nothing else in between.
    expect(result.html.slice(imgIdx + imgTag.length, bodyCloseIdx)).toBe('');
    expect(result.html.slice(0, imgIdx)).toBe('<html><body><p>Hello</p>');
  });

  it('8. no </body> appends at the end and reports injected true', () => {
    const html = '<p>no body tag here</p>';
    const result = injectPixel(html, PIXEL_SRC);
    expect(result.injected).toBe(true);
    expect(result.html.startsWith(html)).toBe(true);
    expect(result.html).toContain('<img');
  });

  it('9. injecting twice with the same origin does not add a second pixel', () => {
    const html = '<html><body></body></html>';
    const first = injectPixel(html, PIXEL_SRC);
    const second = injectPixel(first.html, 'https://t.example.com/o/2different.gif?v=abcdefgh');
    expect(second.injected).toBe(false);
    expect((second.html.match(/<img/g) ?? []).length).toBe(1);
  });

  it('injectPixel tolerates an unparseable pixel src (no origin check, still injects)', () => {
    const result = injectPixel('<html><body></body></html>', 'not a valid url');
    expect(result.injected).toBe(true);
    expect(result.html).toContain('not a valid url');
  });

  it('finding #7: an unrelated same-origin image never blocks injection', () => {
    const html = '<html><body><img src="https://t.example.com/logo.png" alt="logo"></body></html>';
    const result = injectPixel(html, PIXEL_SRC);
    expect(result.injected).toBe(true);
    expect((result.html.match(/<img/g) ?? []).length).toBe(2);
  });

  it('finding #7: a same-tracking-path pixel with a DIFFERENT token still blocks a second injection', () => {
    const html = '<html><body><img src="https://t.example.com/o/completely-different-token.gif?v=zzzzzzzz" width="1" height="1" alt="" /></body></html>';
    const result = injectPixel(html, PIXEL_SRC);
    expect(result.injected).toBe(false);
    expect((result.html.match(/<img/g) ?? []).length).toBe(1);
  });

  it('10. injected markup has width/height/alt and no hidden-content tricks', () => {
    const result = injectPixel('<html><body></body></html>', PIXEL_SRC);
    expect(result.html).toMatch(/width="1"/);
    expect(result.html).toMatch(/height="1"/);
    expect(result.html).toMatch(/alt=""/);
    expect(result.html).not.toMatch(/display:\s*none/);
    expect(result.html).not.toMatch(/visibility:\s*hidden/);
  });

  it('11. collectLinks finds http/https anchors in order and ignores others', () => {
    const html = `
      <a href="https://example.com/a">A</a>
      <a href="mailto:x@example.com">mail</a>
      <a href="tel:+1234">tel</a>
      <a href="#section">anchor</a>
      <a href="data:text/plain;base64,AA==">data</a>
      <a href="https://example.com/b" data-no-track>no-track</a>
      <a href="https://example.com/c">C</a>
    `;
    const links = collectLinks(html);
    expect(links.map((l) => l.url)).toEqual(['https://example.com/a', 'https://example.com/c']);
    expect(links[0]?.position).toBe(0);
    expect(links[1]?.position).toBe(1);
  });

  it('12. rewriteLinks preserves query/fragment and leaves the rest of the document byte-identical', () => {
    const html =
      '<p>Hi <a href="https://example.com/x?a=1&amp;b=2#frag">go</a> and <a href="https://untouched.example.com/y">stay</a>.</p>';
    const rewritten = rewriteLinks(html, (t) =>
      t.url.includes('example.com/x') ? 'https://t.example.com/c/TOKEN' : null,
    );
    expect(rewritten).toContain('href="https://t.example.com/c/TOKEN"');
    // Everything else - including the untouched link, its surrounding text, and the fact that this
    // is a fragment rather than a full document - is byte-identical (finding #14: cheerio's default
    // document mode used to rewrap fragments in <html><head></head><body>...</body></html>).
    const expectedUnchanged = html.replace(
      'href="https://example.com/x?a=1&amp;b=2#frag"',
      'href="https://t.example.com/c/TOKEN"',
    );
    expect(rewritten).toBe(expectedUnchanged);
  });

  it('finding #14: rewriteLinks does not wrap a bare fragment in <html><head><body>', () => {
    const html = '<p>hello</p>';
    expect(rewriteLinks(html, () => null)).toBe(html);
    expect(collectLinks(html)).toEqual([]);
  });

  it('finding #14: rewriteLinks/collectLinks skip links whose host is in skipHosts (the tracking domain)', () => {
    const html =
      '<a href="https://t.example.com/u/TOKEN">unsubscribe</a> <a href="https://example.com/a">go</a>';
    const opts = { skipHosts: ['t.example.com'] };
    expect(collectLinks(html, opts).map((l) => l.url)).toEqual(['https://example.com/a']);

    const rewritten = rewriteLinks(html, () => 'https://t.example.com/c/REWRITTEN', opts);
    // The tracking-domain link is left completely untouched...
    expect(rewritten).toContain('href="https://t.example.com/u/TOKEN"');
    // ...while a link that isn't on the tracking domain is still rewritten normally.
    expect(rewritten).toContain('href="https://t.example.com/c/REWRITTEN"');
  });

  it('13. htmlToText renders links as "label <original-url>"', () => {
    const html = '<p><a href="https://x/y?a=b">Click</a></p>';
    const text = htmlToText(html);
    expect(text).toContain('Click <https://x/y?a=b>');
  });

  it('htmlToText converts <br> and block elements to newlines and ends with one newline', () => {
    const html = '<div>Line1<br>Line2</div><p>Para</p>';
    const text = htmlToText(html);
    expect(text).toBe('Line1\nLine2\n\nPara\n');
  });
});
