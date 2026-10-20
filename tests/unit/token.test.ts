import { describe, expect, it } from 'vitest';
import { newId } from '../../src/core/ids.js';
import { clickUrl, optOutUrl, pixelUrl, signToken, verifyToken } from '../../src/core/token.js';
import type { TokenPurpose } from '../../src/types.js';

const SECRET = 'a'.repeat(32);
const OTHER_SECRET = 'b'.repeat(32);

describe('token', () => {
  it('1. signToken -> verifyToken round-trips for each purpose', () => {
    const purposes: TokenPurpose[] = ['o', 'c', 'u'];
    for (const purpose of purposes) {
      const rid = newId();
      const token = signToken(purpose, rid, SECRET);
      const result = verifyToken(purpose, token, { current: SECRET });
      expect(result).toEqual({ ok: true, rid, usedPrevious: false });
    }
  });

  it('2. a token signed for purpose "o" fails verification as "c"', () => {
    const rid = newId();
    const token = signToken('o', rid, SECRET);
    const result = verifyToken('c', token, { current: SECRET });
    expect(result).toEqual({ ok: false, reason: 'signature' });
  });

  it('3. flipping one character of the signature fails verification', () => {
    const rid = newId();
    const token = signToken('o', rid, SECRET);
    const [head, sig] = token.split('.');
    const lastChar = sig.at(-1) as string;
    const flipped = lastChar === '0' ? '1' : '0';
    const tampered = `${head}.${sig.slice(0, -1)}${flipped}`;
    const result = verifyToken('o', tampered, { current: SECRET });
    expect(result).toEqual({ ok: false, reason: 'signature' });
  });

  it('4. malformed input returns reason "format" without throwing', () => {
    const cases = ['', '1', 'x.y.z', '1***.####', '2abc.def'];
    for (const bad of cases) {
      expect(() => verifyToken('o', bad, { current: SECRET })).not.toThrow();
      const result = verifyToken('o', bad, { current: SECRET });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('format');
    }
  });

  it('5. rotation: previous secret verifies with usedPrevious true; unknown secret fails', () => {
    const rid = newId();
    const token = signToken('o', rid, OTHER_SECRET);
    const rotated = verifyToken('o', token, { current: SECRET, previous: OTHER_SECRET });
    expect(rotated).toEqual({ ok: true, rid, usedPrevious: true });

    const unknown = verifyToken('o', token, { current: SECRET, previous: 'c'.repeat(32) });
    expect(unknown).toEqual({ ok: false, reason: 'signature' });
  });

  it('6. pixelUrl output has the expected shape', () => {
    const rid = newId();
    const token = signToken('o', rid, SECRET);
    const url = pixelUrl('https://t.example.com', token, 'abcd1234');
    // Note: the token itself contains an internal "." (format "1<rid>.<sig>"), so the character
    // class below intentionally allows dots alongside the literal ".gif" suffix.
    expect(url).toMatch(/^https?:\/\/.+\/o\/[0-9a-z.]+\.gif\?v=[0-9a-z]{8}$/);
  });

  it('clickUrl and optOutUrl build the expected paths', () => {
    const rid = newId();
    expect(clickUrl('https://t.example.com', signToken('c', rid, SECRET))).toMatch(
      /^https:\/\/t\.example\.com\/c\/1[0-9a-z]+\.[0-9a-z]+$/,
    );
    expect(optOutUrl('https://t.example.com', signToken('u', rid, SECRET))).toMatch(
      /^https:\/\/t\.example\.com\/u\/1[0-9a-z]+\.[0-9a-z]+$/,
    );
  });

  it('verifyToken rejects an empty rid or empty signature segment', () => {
    expect(verifyToken('o', '1.', { current: SECRET })).toEqual({ ok: false, reason: 'format' });
    expect(verifyToken('o', '1abc.', { current: SECRET })).toEqual({ ok: false, reason: 'format' });
  });

  it('finding #9: rejects a signature segment re-cased or re-spelled to a decode-equivalent alias', () => {
    const rid = newId();
    const token = signToken('o', rid, SECRET);
    const [head, sig] = token.split('.') as [string, string];

    // Same 10 signature bytes under Crockford's decode-tolerant aliasing, spelled differently.
    const upperCased = `${head}.${sig.toUpperCase()}`;
    expect(verifyToken('o', upperCased, { current: SECRET })).toEqual({ ok: false, reason: 'format' });

    // Flip the case of just the first alphabetic character, if there is one.
    const firstAlphaIdx = [...sig].findIndex((c) => /[a-z]/.test(c));
    if (firstAlphaIdx >= 0) {
      const chars = [...sig];
      chars[firstAlphaIdx] = (chars[firstAlphaIdx] as string).toUpperCase();
      const mixedCase = `${head}.${chars.join('')}`;
      expect(verifyToken('o', mixedCase, { current: SECRET })).toEqual({ ok: false, reason: 'format' });
    }
  });

  it('finding #9: rejects rid/signature segments of the wrong canonical length', () => {
    const rid = newId();
    const token = signToken('o', rid, SECRET);
    const [head, sig] = token.split('.') as [string, string];

    expect(verifyToken('o', `${head}0.${sig}`, { current: SECRET })).toEqual({ ok: false, reason: 'format' });
    expect(verifyToken('o', `${head}.${sig}0`, { current: SECRET })).toEqual({ ok: false, reason: 'format' });
    expect(verifyToken('o', `${head.slice(0, -1)}.${sig}`, { current: SECRET })).toEqual({
      ok: false,
      reason: 'format',
    });
  });

  it('finding #9: rejects a canonical-alphabet rid containing an uppercase letter', () => {
    const rid = newId();
    const token = signToken('o', rid, SECRET);
    const [head, sig] = token.split('.') as [string, string];
    const upperRid = head[0] + head.slice(1).toUpperCase();
    expect(verifyToken('o', `${upperRid}.${sig}`, { current: SECRET })).toEqual({
      ok: false,
      reason: 'format',
    });
  });
});
