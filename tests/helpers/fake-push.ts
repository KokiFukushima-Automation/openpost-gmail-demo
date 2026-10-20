/** docs/09_phase5_spec.md §4.7: a real subscriber keypair plus a scripted fake push service, so
 *  Web Push tests exercise the wire bytes end to end without any network. */
import { createECDH, randomBytes } from 'node:crypto';
import { decryptPush } from '../../src/core/webpush.js';
import type { FetchLike } from '../../src/notify/types.js';

export interface FakeSubscriber {
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  decrypt(body: Uint8Array): Buffer;
}

/** Generates a real P-256 keypair + 16 random auth bytes and returns a subscriber that can decrypt
 *  anything encrypted to its public key - proving the bytes on the wire are decryptable by something
 *  that is not our own `encryptPush` inverted. */
export function makeSubscriber(endpoint: string): FakeSubscriber {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const privateKey = ecdh.getPrivateKey();
  const publicKey = ecdh.getPublicKey();
  const auth = randomBytes(16);

  return {
    subscription: {
      endpoint,
      keys: { p256dh: publicKey.toString('base64url'), auth: auth.toString('base64url') },
    },
    decrypt(body: Uint8Array): Buffer {
      return decryptPush({ body, uaPrivateKey: privateKey, uaPublicKey: publicKey, auth });
    },
  };
}

export interface RecordedPushRequest {
  url: string;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
}

export type ScriptedResponse =
  | { status: number; retryAfter?: string }
  | { throw: true; message?: string };

export interface FakePushService {
  fetch: FetchLike;
  requests: RecordedPushRequest[];
}

/** Builds a `FetchLike` that records every call and replies per-endpoint with a scripted response,
 *  falling back to 201 for any endpoint not explicitly scripted. `responses.get(url)` may be a
 *  single response or an array consumed in order (for tests that need a sequence per endpoint). */
export function makeFakePushService(responses: Map<string, ScriptedResponse | ScriptedResponse[]>): FakePushService {
  const requests: RecordedPushRequest[] = [];
  const cursors = new Map<string, number>();

  const fetchImpl: FetchLike = async (url, init) => {
    requests.push({ url, headers: init.headers, body: init.body });
    const scripted = responses.get(url);
    let resp: ScriptedResponse = { status: 201 };
    if (Array.isArray(scripted)) {
      const idx = cursors.get(url) ?? 0;
      resp = scripted[Math.min(idx, scripted.length - 1)] as ScriptedResponse;
      cursors.set(url, idx + 1);
    } else if (scripted) {
      resp = scripted;
    }
    if ('throw' in resp) {
      throw new Error(resp.message ?? 'network error');
    }
    const headers: Record<string, string> = {};
    if (resp.retryAfter) headers['retry-after'] = resp.retryAfter;
    return {
      status: resp.status,
      ok: resp.status >= 200 && resp.status < 300,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      text: async () => '',
    };
  };

  return { fetch: fetchImpl, requests };
}
