import { createECDH, createPublicKey, randomBytes, verify as cryptoVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptPush,
  encryptPush,
  generateVapidKeys,
  MAX_PUSH_PLAINTEXT,
  PushPayloadTooLargeError,
  vapidAuthorization,
  vapidPublicKeyFromPrivate,
} from '../../src/core/webpush.js';

function fromB64(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

function makeSubscriber() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const priv = ecdh.getPrivateKey();
  const pub = ecdh.getPublicKey();
  const auth = randomBytes(16);
  return {
    priv,
    pub,
    auth,
    keys: { p256dh: pub.toString('base64url'), auth: auth.toString('base64url') },
  };
}

describe('webpush: RFC 8291/8292 on node:crypto', () => {
  it('389. generateVapidKeys round-trips through vapidPublicKeyFromPrivate', () => {
    const keys = generateVapidKeys();
    expect(vapidPublicKeyFromPrivate(keys.privateKey)).toBe(keys.publicKey);
    expect(Buffer.from(keys.publicKey, 'base64url').length).toBe(65);
    expect(Buffer.from(keys.privateKey, 'base64url').length).toBe(32);
  });

  it('390. vapidAuthorization: JWT header/payload decode, aud is the endpoint origin, exp <= 24h, signature verifies', () => {
    const keys = generateVapidKeys();
    const nowSec = 1_700_000_000;
    const header = vapidAuthorization({
      endpoint: 'https://push.example.com/wp/abc123',
      subject: 'mailto:ops@example.com',
      keys,
      nowSec,
    });
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const jwt = match![1] as string;
    const k = match![2] as string;
    expect(k).toBe(keys.publicKey);
    const [h, p, s] = jwt.split('.');
    const headerJson = JSON.parse(Buffer.from(h as string, 'base64url').toString('utf8'));
    const payloadJson = JSON.parse(Buffer.from(p as string, 'base64url').toString('utf8'));
    expect(headerJson).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(payloadJson.aud).toBe('https://push.example.com');
    expect(payloadJson.exp).toBeGreaterThan(nowSec);
    expect(payloadJson.exp).toBeLessThanOrEqual(nowSec + 24 * 3600);
    expect(payloadJson.sub).toBe('mailto:ops@example.com');

    const pub = Buffer.from(keys.publicKey, 'base64url');
    const x = pub.subarray(1, 33).toString('base64url');
    const y = pub.subarray(33, 65).toString('base64url');
    const keyObj = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x, y }, format: 'jwk' });
    const ok = cryptoVerify('sha256', Buffer.from(`${h}.${p}`), { key: keyObj, dsaEncoding: 'ieee-p1363' }, Buffer.from(s as string, 'base64url'));
    expect(ok).toBe(true);
  });

  it('vapidAuthorization rejects a subject with a bad scheme', () => {
    const keys = generateVapidKeys();
    expect(() =>
      vapidAuthorization({ endpoint: 'https://push.example.com/x', subject: 'ops@example.com', keys, nowSec: 0 }),
    ).toThrow(/subject/);
  });

  it('391. decryptPush against the RFC 8291 Section 5 worked example produces the RFC\'s exact plaintext', () => {
    // Fixed keys/salt/ciphertext copied verbatim from RFC 8291 Section 5 ("A Complete
    // Example"). These are the same publicly-documented base64url strings that appear in
    // other independent implementations' test suites (e.g. the `web-push` npm package and
    // `pywebpush`), and they let us check this project's aes128gcm framing/HKDF derivation
    // against the standard's own numbers rather than only against ourselves.
    const uaPrivateKey = fromB64('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94');
    const uaPublicKey = fromB64('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4');
    const authSecret = fromB64('BTBZMqHH6r4Tts7J_aSIgg');
    const body = fromB64(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
    const decrypted = decryptPush({ body, uaPrivateKey, uaPublicKey, auth: authSecret });
    expect(decrypted.toString('utf8')).toBe('When I grow up, I want to be a watermelon');
  });

  it('392. encrypt -> decryptPush round-trips a ~3KiB payload with an independently generated subscriber keypair', () => {
    const sub = makeSubscriber();
    const plaintext = Buffer.from('x'.repeat(3000), 'utf8');
    const body = encryptPush({ plaintext, sub: sub.keys });
    const decrypted = decryptPush({ body, uaPrivateKey: sub.priv, uaPublicKey: sub.pub, auth: sub.auth });
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it('encrypt -> decrypt round-trips a small JSON payload (typical notification shape)', () => {
    const sub = makeSubscriber();
    const json = JSON.stringify({ v: 1, title: 'First open', body: 'a@example.com opened "Hi"', url: '/dashboard/messages/abc', tag: 'abc', ts: 123 });
    const plaintext = Buffer.from(json, 'utf8');
    const body = encryptPush({ plaintext, sub: sub.keys });
    const decrypted = decryptPush({ body, uaPrivateKey: sub.priv, uaPublicKey: sub.pub, auth: sub.auth });
    expect(JSON.parse(decrypted.toString('utf8'))).toEqual(JSON.parse(json));
  });

  it('393. body framing: salt(16) || rs=4096(be32) || idlen=0x41 || 65-byte point || ciphertext+tag', () => {
    const sub = makeSubscriber();
    const plaintext = Buffer.from('hello', 'utf8');
    const body = encryptPush({ plaintext, sub: sub.keys });
    expect(body.length).toBeGreaterThan(21 + 65 + 16);
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(body[20]).toBe(0x41);
    const point = body.subarray(21, 21 + 65);
    expect(point[0]).toBe(0x04);
  });

  it('394. a plaintext over MAX_PUSH_PLAINTEXT throws PushPayloadTooLargeError', () => {
    const sub = makeSubscriber();
    const plaintext = Buffer.alloc(MAX_PUSH_PLAINTEXT + 1, 0x61);
    expect(() => encryptPush({ plaintext, sub: sub.keys })).toThrow(PushPayloadTooLargeError);
  });

  it('395. a tampered ciphertext byte fails to decrypt (GCM tag)', () => {
    const sub = makeSubscriber();
    const plaintext = Buffer.from('tamper me', 'utf8');
    const body = encryptPush({ plaintext, sub: sub.keys });
    const tampered = Buffer.from(body);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 0xff;
    expect(() => decryptPush({ body: tampered, uaPrivateKey: sub.priv, uaPublicKey: sub.pub, auth: sub.auth })).toThrow();
  });

  it('396. two encryptions of the same plaintext differ (fresh salt and ephemeral key)', () => {
    const sub = makeSubscriber();
    const plaintext = Buffer.from('same message', 'utf8');
    const a = encryptPush({ plaintext, sub: sub.keys });
    const b = encryptPush({ plaintext, sub: sub.keys });
    expect(a.equals(b)).toBe(false);
  });
});
