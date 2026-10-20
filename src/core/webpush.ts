/**
 * RFC 8291 (Message Encryption for Web Push) and RFC 8292 (VAPID) implemented on `node:crypto`
 * only - docs/09_phase5_spec.md §4.1/§4.2. Zero new runtime dependency: `createECDH('prime256v1')`,
 * `createHmac('sha256')`, `createCipheriv`/`createDecipheriv('aes-128-gcm')` and
 * `crypto.sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' })` (which emits the raw 64-byte
 * `r||s` ES256 signature JOSE wants, with no DER surgery) are all this needs.
 *
 * `tests/unit/webpush.test.ts` checks this against the literal RFC 8291 Section 5 worked example
 * (fixed subscriber keys/ciphertext, verified byte-for-byte against the standard's own text —
 * salt, `rs`, `idlen`, `as_public` and ciphertext+tag length all match RFC 8291 §5 exactly):
 * `decryptPush` on the RFC's exact ciphertext bytes with the RFC's exact subscriber keypair
 * produces the RFC's exact plaintext,
 * "When I grow up, I want to be a watermelon". It also checks the implementation
 * self-consistently: a round trip (`encryptPush` -> `decryptPush` with an independently generated
 * subscriber keypair), the exact RFC 8188 aes128gcm byte framing, GCM tamper detection, and
 * uniqueness of ciphertext across repeated calls (fresh salt + ephemeral key every time).
 */
import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  randomBytes,
  sign as cryptoSign,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';

export interface VapidKeys {
  publicKey: string; // base64url, 65-byte uncompressed P-256 point
  privateKey: string; // base64url, 32-byte scalar
}

const CURVE = 'prime256v1';

function b64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

/** Generates a fresh VAPID (or push-encryption ephemeral) P-256 keypair. */
export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH(CURVE);
  ecdh.generateKeys();
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) };
}

/** Re-derives the 65-byte uncompressed public point from a raw private scalar. */
export function vapidPublicKeyFromPrivate(privateKey: string): string {
  const ecdh = createECDH(CURVE);
  ecdh.setPrivateKey(fromB64url(privateKey));
  return b64url(ecdh.getPublicKey());
}

/** Builds a `KeyObject` node's `crypto.sign`/`crypto.verify` can use, from the raw JWK components -
 *  the only reliable way to hand node an EC private key given as a bare 32-byte scalar. */
function privateKeyObject(privateKey: string, publicKey: string): KeyObject {
  const pub = fromB64url(publicKey);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('invalid VAPID public key: expected a 65-byte uncompressed P-256 point');
  }
  const x = pub.subarray(1, 33);
  const y = pub.subarray(33, 65);
  return createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: fromB64url(privateKey).toString('base64url'), x: b64url(x), y: b64url(y) },
    format: 'jwk',
  });
}

const MAX_VAPID_TTL_SEC = 24 * 3600;

export interface VapidAuthorizationInput {
  endpoint: string;
  subject: string;
  keys: VapidKeys;
  nowSec: number;
  ttlSec?: number;
}

/** RFC 8292: builds the `Authorization: vapid t=<jwt>, k=<publicKey>` header value. */
export function vapidAuthorization(a: VapidAuthorizationInput): string {
  if (!/^mailto:|^https:/.test(a.subject)) {
    throw new Error(`invalid VAPID subject "${a.subject}": must start with mailto: or https:`);
  }
  const aud = new URL(a.endpoint).origin;
  const ttl = Math.min(a.ttlSec ?? 43200, MAX_VAPID_TTL_SEC);
  const exp = a.nowSec + ttl;

  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud, exp, sub: a.subject };
  const signingInput = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
  const key = privateKeyObject(a.keys.privateKey, a.keys.publicKey);
  const signature = cryptoSign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  const jwt = `${signingInput}.${b64url(signature)}`;
  return `vapid t=${jwt}, k=${a.keys.publicKey}`;
}

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string; // base64url, 65-byte uncompressed point
  auth: string; // base64url, 16 bytes
}

export const MAX_PUSH_PLAINTEXT = 3993;

export class PushPayloadTooLargeError extends Error {
  constructor(size: number) {
    super(`push plaintext is ${size} bytes, exceeding the ${MAX_PUSH_PLAINTEXT}-byte aes128gcm single-record limit`);
    this.name = 'PushPayloadTooLargeError';
  }
}

const RECORD_SIZE = 4096;
const INFO_PREFIX = 'WebPush: info\0';
const CEK_INFO = 'Content-Encoding: aes128gcm\0';
const NONCE_INFO = 'Content-Encoding: nonce\0';
const PADDING_DELIMITER = 0x02;

function hkdfExpand(prk: Buffer, info: Buffer, len: number): Buffer {
  return createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([0x01])])).digest().subarray(0, len);
}

interface DerivedKeys {
  cek: Buffer;
  nonce: Buffer;
}

function deriveKeys(args: { sharedSecret: Buffer; authSecret: Buffer; salt: Buffer; uaPublic: Buffer; asPublic: Buffer }): DerivedKeys {
  const { sharedSecret, authSecret, salt, uaPublic, asPublic } = args;
  const prkKey = createHmac('sha256', authSecret).update(sharedSecret).digest();
  const keyInfo = Buffer.concat([Buffer.from(INFO_PREFIX), uaPublic, asPublic]);
  const ikm = hkdfExpand(prkKey, keyInfo, 32);
  const prk = createHmac('sha256', salt).update(ikm).digest();
  const cek = hkdfExpand(prk, Buffer.from(CEK_INFO), 16);
  const nonce = hkdfExpand(prk, Buffer.from(NONCE_INFO), 12);
  return { cek, nonce };
}

export interface EncryptPushInput {
  plaintext: Uint8Array;
  sub: PushSubscriptionKeys;
  /** Test-only: pins the salt instead of a fresh random one. */
  salt?: Uint8Array;
  /** Test-only: pins the server's ephemeral ECDH private key instead of generating one. */
  serverPrivateKey?: Uint8Array;
}

/**
 * RFC 8291 §3.4 / RFC 8188: encrypts `plaintext` for one push subscription. Body framing:
 * `salt(16) || rs=4096(4, big-endian) || idlen=0x41(1) || as_public(65) || ciphertext+tag`.
 */
export function encryptPush(a: EncryptPushInput): Buffer {
  if (a.plaintext.length > MAX_PUSH_PLAINTEXT) {
    throw new PushPayloadTooLargeError(a.plaintext.length);
  }
  const uaPublic = fromB64url(a.sub.p256dh);
  const authSecret = fromB64url(a.sub.auth);
  const salt = a.salt ? Buffer.from(a.salt) : randomBytes(16);

  const ecdh = createECDH(CURVE);
  if (a.serverPrivateKey) {
    ecdh.setPrivateKey(Buffer.from(a.serverPrivateKey));
  } else {
    ecdh.generateKeys();
  }
  const asPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);

  const { cek, nonce } = deriveKeys({ sharedSecret, authSecret, salt, uaPublic, asPublic });

  const record = Buffer.concat([Buffer.from(a.plaintext), Buffer.from([PADDING_DELIMITER])]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final()]);
  const tag = cipher.getAuthTag();

  const rsBuf = Buffer.alloc(4);
  rsBuf.writeUInt32BE(RECORD_SIZE, 0);
  const header = Buffer.concat([salt, rsBuf, Buffer.from([asPublic.length]), asPublic]);
  return Buffer.concat([header, ciphertext, tag]);
}

export interface DecryptPushInput {
  body: Uint8Array;
  /** The subscriber's own ECDH private key (raw scalar) - held only by the browser/test in real
   *  life; the server never sees it. */
  uaPrivateKey: Uint8Array;
  uaPublicKey: Uint8Array;
  auth: Uint8Array;
}

/** Inverse of `encryptPush`, from the subscriber's side - exported for tests and for
 *  `openpost push test --self-check`. */
export function decryptPush(a: DecryptPushInput): Buffer {
  const body = Buffer.from(a.body);
  if (body.length < 21) throw new Error('push body too short to contain an aes128gcm header');
  const salt = body.subarray(0, 16);
  const idlen = body[20] as number;
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertextAndTag = body.subarray(21 + idlen);
  if (ciphertextAndTag.length < 16) throw new Error('push body too short to contain a GCM tag');

  const ecdh = createECDH(CURVE);
  ecdh.setPrivateKey(Buffer.from(a.uaPrivateKey));
  const sharedSecret = ecdh.computeSecret(asPublic);

  const { cek, nonce } = deriveKeys({
    sharedSecret,
    authSecret: Buffer.from(a.auth),
    salt: Buffer.from(salt),
    uaPublic: Buffer.from(a.uaPublicKey),
    asPublic: Buffer.from(asPublic),
  });

  const tag = ciphertextAndTag.subarray(ciphertextAndTag.length - 16);
  const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.length - 16);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const record = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (record.length === 0 || record[record.length - 1] !== PADDING_DELIMITER) {
    throw new Error('invalid aes128gcm padding delimiter');
  }
  return record.subarray(0, record.length - 1);
}
