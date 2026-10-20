import { describe, expect, it } from 'vitest';
import { collectLinks, linkifyText, rewriteLinks, textToHtml } from '../../src/core/html.js';

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

describe('linkifyText', () => {
  const cases: Array<[string, string]> = [
    ['no url here', 'no url here'],
    ['see https://example.com/x', 'see <a href="https://example.com/x">https://example.com/x</a>'],
    ['see https://example.com/x.', 'see <a href="https://example.com/x">https://example.com/x</a>.'],
    ['see https://example.com/x,', 'see <a href="https://example.com/x">https://example.com/x</a>,'],
    ['see https://example.com/x!', 'see <a href="https://example.com/x">https://example.com/x</a>!'],
    ['see https://example.com/x)', 'see <a href="https://example.com/x">https://example.com/x</a>)'],
    ['(see https://example.com/x)', '(see <a href="https://example.com/x">https://example.com/x</a>)'],
    ['https://example.com/(a)', '<a href="https://example.com/(a)">https://example.com/(a)</a>'],
    ['two https://a.example and https://b.example links', 'two <a href="https://a.example">https://a.example</a> and <a href="https://b.example">https://b.example</a> links'],
    ['http://plain.example', '<a href="http://plain.example">http://plain.example</a>'],
    ['not a url: ftp://example.com', 'not a url: ftp://example.com'],
    ['mailto:a@example.com is not linkified', 'mailto:a@example.com is not linkified'],
  ];

  it.each(cases)('372. linkifies %s', (input, expected) => {
    expect(linkifyText(escapeHtmlText(input))).toBe(expected);
  });

  it('a body containing literal <a href=x> markup is inert (escaped first, so it never re-parses as a live tag)', () => {
    const escaped = escapeHtmlText('click <a href=evil>here</a> or https://real.example');
    const out = linkifyText(escaped);
    expect(out).not.toContain('<a href=evil>');
    expect(out).toContain('&lt;a href=evil&gt;');
    expect(out).toContain('<a href="https://real.example">https://real.example</a>');
  });

  it('a URL already on the tracking host is linkified the same as any other - skipHosts is applied downstream by collectLinks/rewriteLinks', () => {
    const out = linkifyText(escapeHtmlText('pixel at https://t.example.com/o/abc.gif'));
    expect(out).toContain('<a href="https://t.example.com/o/abc.gif">');
  });
});

describe('textToHtml', () => {
  it('escapes, linkifies, and wraps paragraphs; blank lines separate <p>, single newlines become <br>', () => {
    const html = textToHtml('Hello <world>\n\nSee https://example.com/x for more.\nSecond line.');
    expect(html).toContain('<html><body>');
    expect(html).toContain('Hello &lt;world&gt;');
    expect(html).toContain('<a href="https://example.com/x">https://example.com/x</a>');
    expect(html).toContain('<br>Second line.');
  });

  it('empty input renders an empty body without throwing', () => {
    expect(textToHtml('')).toBe('<html><body></body></html>');
    expect(textToHtml('   \n  ')).toBe('<html><body></body></html>');
  });

  it('373. textToHtml output round-trips through collectLinks/rewriteLinks so click tracking applies to a linkified body', () => {
    const html = textToHtml('Please visit https://example.com/signup today.');
    const targets = collectLinks(html);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.url).toBe('https://example.com/signup');
    const rewritten = rewriteLinks(html, () => 'https://t.example.com/c/token123');
    expect(rewritten).toContain('href="https://t.example.com/c/token123"');
  });
});
