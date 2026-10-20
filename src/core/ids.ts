import { randomBytes } from 'node:crypto';

// Crockford base32 alphabet (lowercase canonical form), no padding.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const ALPHABET_INDEX = new Map<string, number>();
for (let i = 0; i < ALPHABET.length; i++) {
  const ch = ALPHABET[i];
  if (ch !== undefined) ALPHABET_INDEX.set(ch, i);
}
// Crockford treats i/l as 1 and o as 0 when decoding.
ALPHABET_INDEX.set('i', 1);
ALPHABET_INDEX.set('l', 1);
ALPHABET_INDEX.set('o', 0);

/** Encode arbitrary bytes as lowercase Crockford base32, no padding. */
export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i] as number;
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return output;
}

/** Decode a lowercase (or uppercase) Crockford base32 string. Throws on invalid characters. */
export function base32Decode(s: string): Uint8Array {
  const lower = s.toLowerCase();
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of lower) {
    const idx = ALPHABET_INDEX.get(ch);
    if (idx === undefined) {
      throw new Error(`invalid base32 character: ${ch}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

/** 16 random bytes -> 26-char Crockford base32 id. */
export function newId(): string {
  return base32Encode(randomBytes(16));
}
