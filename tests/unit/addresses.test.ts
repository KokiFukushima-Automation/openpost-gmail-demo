import { describe, expect, it } from 'vitest';
import { isValidAddress, splitAddresses } from '../../src/core/addresses.js';

describe('addresses: splitAddresses/isValidAddress', () => {
  it('splits on comma, semicolon and whitespace, trims, lower-cases the domain only', () => {
    const { valid, invalid } = splitAddresses(' Alice@Example.com, bob@example.com;  carol@EXAMPLE.com  dave@example.org ');
    expect(valid).toEqual(['Alice@example.com', 'bob@example.com', 'carol@example.com', 'dave@example.org']);
    expect(invalid).toEqual([]);
  });

  it('de-duplicates by normalized form (domain case folded, local part exact), preserving first-seen order', () => {
    const { valid } = splitAddresses('a@example.com, a@Example.com, b@example.com');
    expect(valid).toEqual(['a@example.com', 'b@example.com']);
  });

  it('371. rejects an address containing CR/LF (header injection guard)', () => {
    const { valid, invalid } = splitAddresses('good@example.com, evil@example.com\r\nBcc:attacker@evil.com');
    expect(valid).toEqual(['good@example.com']);
    expect(invalid.length).toBeGreaterThan(0);
  });

  it('isValidAddress rejects missing @, multiple @, empty local/domain, and a domain with no dot', () => {
    expect(isValidAddress('nodomain')).toBe(false);
    expect(isValidAddress('two@@example.com')).toBe(false);
    expect(isValidAddress('@example.com')).toBe(false);
    expect(isValidAddress('user@')).toBe(false);
    expect(isValidAddress('user@localhost')).toBe(false);
    expect(isValidAddress('user@example.com')).toBe(true);
  });

  it('empty input yields no addresses', () => {
    expect(splitAddresses('   ')).toEqual({ valid: [], invalid: [] });
  });
});
