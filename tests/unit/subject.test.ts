import { describe, expect, it } from 'vitest';
import { normalizeSubject } from '../../src/core/subject.js';

describe('subject', () => {
  it('332. strips stacked Re: Fwd: RE: prefixes and [list] tags, NFKC-normalises, truncates', () => {
    expect(normalizeSubject('Re: Fwd: RE: hello')).toBe('hello');
    expect(normalizeSubject('[my-list] Re: hello')).toBe('hello');
    expect(normalizeSubject('Re: [my-list] hello')).toBe('hello');
    expect(normalizeSubject('a'.repeat(250)).length).toBe(200);
  });

  it('333. matches the real-world subject-form table, including CJK reply prefixes', () => {
    const table: Array<[string, string]> = [
      ['Hello world', 'hello world'],
      ['RE: Hello world', 'hello world'],
      ['Re: Hello world', 'hello world'],
      ['re:Hello world', 'hello world'],
      ['Fwd: Hello world', 'hello world'],
      ['FW: Hello world', 'hello world'],
      ['Aw: Hello world', 'hello world'],
      ['Rif: Hello world', 'hello world'],
      ['回复：Hello world', 'hello world'],
      ['转发：Hello world', 'hello world'],
      ['Re: Re: Re: Hello world', 'hello world'],
      ['Re: Fwd: Aw: Hello world', 'hello world'],
      ['[team] Hello world', 'hello world'],
      ['Re: [team] Hello world', 'hello world'],
      ['  Hello   world  ', 'hello world'],
      ['HELLO WORLD', 'hello world'],
      ['Hello World™', 'hello world™'.normalize('NFKC').toLowerCase()],
      ['', ''],
      ['Re:', ''],
      ['Re: A', 'a'],
    ];
    for (const [input, expected] of table) {
      expect(normalizeSubject(input)).toBe(expected);
    }
  });

  it('334. two different subjects never normalise to the same key in the table', () => {
    const distinctInputs = ['Hello world', 'Goodbye world', 'Re: project update', 'Re: project updates'];
    const normalized = distinctInputs.map(normalizeSubject);
    expect(new Set(normalized).size).toBe(distinctInputs.length);
  });
});
