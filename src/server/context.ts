import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/env.js';
import { classifyOpen } from '../core/classify.js';
import { geoForEvent, NULL_GEO, type GeoGranularity, type GeoLookup } from '../core/geo.js';
import { hashIp, hashNet, redactForMode } from '../core/privacy.js';
import { parseUserAgent } from '../core/ua.js';
import { EMPTY_RANGE_INDEX, type RangeIndex } from '../core/ranges.js';
import type { ClassifyConfig, ClassifyContext, OpenSignal, UaInfo } from '../types.js';
import type { DB } from '../db/index.js';
import {
  fanoutCount,
  hasCountedOpen as repoHasCountedOpen,
  isSuppressed,
  recentClickEventsForRecipient,
  recentEventsForRecipient,
} from '../db/repo.js';
import { correlationFanoutCount, correlationPriorEvents, type CorrelationKind } from './correlation.js';

const FANOUT_WINDOW_MS = 10 * 60 * 1000;

export function classifyConfigFrom(config: AppConfig): ClassifyConfig {
  return {
    openIgnoreSeconds: config.openIgnoreSeconds,
    proxyPrefetchSeconds: config.proxyPrefetchSeconds,
    mppWindowSeconds: config.mppWindowSeconds,
    dedupeSeconds: config.dedupeSeconds,
    scannerFanout: config.scannerFanout,
    respectDnt: config.respectDnt,
  };
}

export function readDnt(req: FastifyRequest): boolean {
  const dnt = req.headers['dnt'];
  const gpc = req.headers['sec-gpc'];
  return dnt === '1' || gpc === '1';
}

export function buildOpenSignal(
  req: FastifyRequest,
  method: 'GET' | 'HEAD',
  occurredAt: number,
): OpenSignal {
  const ua = req.headers['user-agent'];
  const accept = req.headers['accept'];
  return {
    occurredAt,
    ip: req.clientIp,
    ua: typeof ua === 'string' ? ua : null,
    method,
    accept: typeof accept === 'string' ? accept : null,
    dnt: readDnt(req),
  };
}

/**
 * Builds the ClassifyContext for one recipient. `ranges` (§4.1) supplies the shipped Apple relay /
 * Google proxy / datacentre CIDR sets; omitting it (or passing `EMPTY_RANGE_INDEX`) reproduces
 * Phase 1 behaviour (every IP-range flag false).
 */
export function buildClassifyContext(
  db: DB,
  config: AppConfig,
  recipientEmail: string,
  sentAt: number | null,
  uaInfo: UaInfo,
  signal: OpenSignal,
  recipientId: string,
  kind: CorrelationKind = 'open',
  ranges: RangeIndex = EMPTY_RANGE_INDEX,
): ClassifyContext {
  const ipHash = hashIp(signal.ip, config.ipSalt, signal.occurredAt);
  const ipNetHash = hashNet(signal.ip, config.ipSalt, signal.occurredAt);
  const strict = config.privacyMode === 'strict';
  // Finding #3: in strict mode the persisted rows have ip_net_hash/ua_family nulled, so R7/R8 must
  // instead read from the short-lived in-memory correlation window (never persisted) - see
  // correlation.ts. Off/balanced modes keep persisting these hashes, so the DB-backed lookups stay
  // correct and are used as-is.
  const priorEvents = strict
    ? correlationPriorEvents(db, kind, recipientId, signal.occurredAt, 50)
    : kind === 'click'
      ? recentClickEventsForRecipient(db, recipientId, 50)
      : recentEventsForRecipient(db, recipientId, 50);
  const fanout =
    ipNetHash === null
      ? 0
      : strict
        ? correlationFanoutCount(db, ipNetHash, signal.occurredAt - FANOUT_WINDOW_MS, signal.occurredAt)
        : fanoutCount(db, ipNetHash, signal.occurredAt - FANOUT_WINDOW_MS);

  return {
    sentAt,
    optedOut: isSuppressed(db, recipientEmail),
    priorEvents,
    ipHash,
    ipNetHash,
    uaInfo,
    fanoutCount: fanout,
    config: classifyConfigFrom(config),
    selfIpHashes: new Set(config.selfIpHashes),
    selfUaPatterns: config.selfUaPatterns,
    isAppleRelayIp: ranges.apple.contains(signal.ip),
    isGoogleProxyIp: ranges.googleProxy.contains(signal.ip),
    isDatacenterIp: ranges.datacenter.contains(signal.ip),
    hasCountedOpen: repoHasCountedOpen(db, recipientId),
  };
}

/** Finding #7 (docs/reports/phase4_review.md): `geoForEvent` was fully written and unit-tested but
 *  never actually called from the pixel/click path, so `open_events.country`/`region`/`city` stayed
 *  NULL forever regardless of GEOIP_DB_PATH. `geo` is optional so every existing caller (and every
 *  test that builds a ClassifyContext without one) keeps behaving exactly as before - geo simply
 *  never fires without it, same as `geoLookup: null`. */
export interface GeoInput {
  classification: string;
  /** §5.2 (spec) / finding #7: geo is only ever computed for a COUNTED event - an uncounted
   *  (bot/proxy/duplicate/etc.) hit gets no geo tag even before geoForEvent's own classification
   *  gate runs, matching "non-proxied counted opens/clicks" exactly. */
  counted: boolean;
  lookup: GeoLookup | null;
  granularity: GeoGranularity;
}

function resolveGeo(signal: OpenSignal, ctx: ClassifyContext, privacyMode: AppConfig['privacyMode'], geo: GeoInput | undefined): ReturnType<typeof geoForEvent> {
  if (!geo || !geo.counted || geo.lookup === null) return NULL_GEO;
  return geoForEvent({
    ip: signal.ip,
    classification: geo.classification,
    privacyMode,
    granularity: geo.granularity,
    flags: { isAppleRelay: ctx.isAppleRelayIp, isGoogleProxy: ctx.isGoogleProxyIp, isDatacenter: ctx.isDatacenterIp },
    lookup: geo.lookup,
  });
}

/** Shared by both the pixel and click routes so click events get the same treatment (finding #1):
 *  raw UA, ip_hash/ip_net_hash, device_type and os are redacted per PRIVACY_MODE exactly like open
 *  events, instead of the click path storing them unconditionally. `geo` (finding #7), when passed,
 *  is resolved here (in-memory, before the raw IP is ever discarded) and then run back through the
 *  same `redactForMode` as everything else - PRIVACY_MODE caps geo granularity exactly like
 *  `geoForEvent`'s own gate does, so a mis-set GEOIP_GRANULARITY can never bypass PRIVACY_MODE via a
 *  second path. */
export function redactEventFields(
  signal: OpenSignal,
  ctx: ClassifyContext,
  privacyMode: AppConfig['privacyMode'],
  geo?: GeoInput,
): ReturnType<typeof redactForMode> {
  const geoResult = resolveGeo(signal, ctx, privacyMode, geo);
  return redactForMode(
    {
      ip_hash: ctx.ipHash,
      ip_net_hash: ctx.ipNetHash,
      ua: signal.ua,
      ua_family: ctx.uaInfo.family,
      device_type: ctx.uaInfo.deviceType,
      os: ctx.uaInfo.os,
      country: geoResult.country,
      region: geoResult.region,
      city: geoResult.city,
    },
    privacyMode,
  );
}

export function classifyAndRedact(
  signal: OpenSignal,
  ctx: ClassifyContext,
  privacyMode: AppConfig['privacyMode'],
  geo?: Pick<GeoInput, 'lookup' | 'granularity'>,
): {
  classification: ReturnType<typeof classifyOpen>;
  fields: ReturnType<typeof redactForMode>;
} {
  const classification = classifyOpen(signal, ctx);
  const fields = redactEventFields(
    signal,
    ctx,
    privacyMode,
    geo ? { classification: classification.classification, counted: classification.counted, ...geo } : undefined,
  );
  return { classification, fields };
}

export { parseUserAgent };
