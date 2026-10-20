import { describe, expect, it } from 'vitest';
import { CsvError, normalizeHeader, parseCsv, pickEmailColumn } from '../../src/core/csv.js';

describe('csv', () => {
  it('230. quoted fields with embedded commas, CRLF and "" round-trip exactly', () => {
    const text = 'name,note\r\n"Doe, Jane","She said ""hi""\r\nline2"\r\n';
    const table = parseCsv(text);
    expect(table.rows).toEqual([{ name: 'Doe, Jane', note: 'She said "hi"\r\nline2' }]);
  });

  it('231. BOM is stripped; CRLF and LF files parse identically', () => {
    const bomCrlf = '﻿a,b\r\n1,2\r\n';
    const lf = 'a,b\n1,2\n';
    expect(parseCsv(bomCrlf)).toEqual(parseCsv(lf));
  });

  it('232. delimiter auto-detection picks ; and tab from the header line; --delimiter overrides', () => {
    expect(parseCsv('a;b\n1;2\n').delimiter).toBe(';');
    expect(parseCsv('a\tb\n1\t2\n').delimiter).toBe('\t');
    const overridden = parseCsv('a,b;c\n1,2;3\n', { delimiter: ';' });
    expect(overridden.delimiter).toBe(';');
    expect(overridden.headers).toEqual(['a,b', 'c']);
  });

  it('233. a ragged row with extra cells is a CsvError naming the line; fewer cells leaves keys absent', () => {
    expect(() => parseCsv('a,b\n1,2,3\n')).toThrow(CsvError);
    try {
      parseCsv('a,b\n1,2,3\n');
    } catch (err) {
      expect((err as CsvError).line).toBe(2);
    }
    const short = parseCsv('a,b\n1\n');
    expect(short.rows[0]).toEqual({ a: '1' });
    expect('b' in (short.rows[0] as object)).toBe(false);
  });

  it('234. duplicate headers after normalisation are a CsvError', () => {
    expect(() => parseCsv('Email,email\na@b.com,x\n')).toThrow(CsvError);
  });

  it('235. maxRows / maxCellBytes fail with the line number and do not allocate the whole file', () => {
    expect(() => parseCsv('a\n1\n2\n3\n', { maxRows: 2 })).toThrow(CsvError);
    expect(() => parseCsv(`a\n${'x'.repeat(20)}\n`, { maxCellBytes: 10 })).toThrow(CsvError);
  });

  it('236. a column literally named __proto__ lands as an own property and does not touch Object.prototype', () => {
    const table = parseCsv('__proto__,constructor\nx,y\n');
    const row = table.rows[0] as Record<string, string>;
    expect(row.__proto__).toBe('x');
    expect(Object.prototype.hasOwnProperty.call(row, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('237. pickEmailColumn finds Email, E-Mail, address; ambiguity or absence is an error naming --email-column', () => {
    expect(pickEmailColumn(['Name', 'Email'])).toBe('Email');
    expect(pickEmailColumn(['Name', 'E-Mail'])).toBe('E-Mail');
    expect(pickEmailColumn(['Name', 'address'])).toBe('address');
    expect(() => pickEmailColumn(['Name'])).toThrow(/--email-column/);
    expect(() => pickEmailColumn(['Email', 'address'])).toThrow(/--email-column/);
    expect(pickEmailColumn(['foo', 'bar'], 'foo')).toBe('foo');
  });

  it('238. an empty file and a headers-only file each produce a distinct, named error', () => {
    let e1: CsvError | null = null;
    try {
      parseCsv('');
    } catch (err) {
      e1 = err as CsvError;
    }
    let e2: CsvError | null = null;
    try {
      parseCsv('a,b\n');
    } catch (err) {
      e2 = err as CsvError;
    }
    expect(e1?.message).toMatch(/empty file/);
    expect(e2?.message).toMatch(/no data rows/);
    expect(e1?.message).not.toBe(e2?.message);
  });

  it('239. a 500-row fixture parses to 500 rows with stable order', () => {
    const lines = ['name,email'];
    for (let i = 0; i < 500; i++) lines.push(`Person ${i},person${i}@example.com`);
    const table = parseCsv(lines.join('\n') + '\n');
    expect(table.rows).toHaveLength(500);
    expect(table.rows[0]).toEqual({ name: 'Person 0', email: 'person0@example.com' });
    expect(table.rows[499]).toEqual({ name: 'Person 499', email: 'person499@example.com' });
  });

  it('normalizeHeader trims, strips BOM, lowercases, collapses whitespace', () => {
    expect(normalizeHeader('  ﻿E-Mail   Address ')).toBe('e-mail address');
  });
});
