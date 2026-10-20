export type PrivacyMode = 'off' | 'balanced' | 'strict';
export type TransportName = 'dryrun' | 'smtp' | 'gmail' | 'gmail-smtp';
export type TokenPurpose = 'o' | 'c' | 'u';

/** §3.3/§6.1 of docs/07_recipient_semantics.md - re-exported here (rather than only from
 *  `src/mail/recipients.ts`) so every module that needs the type doesn't have to reach into `mail/`. */
export type { RecipientMode, RecipientModeOption } from './mail/recipients.js';

export type OpenClassificationKind =
  | 'human'
  | 'google_proxy_prefetch'
  | 'apple_mpp'
  | 'self_open'
  | 'bot'
  | 'duplicate'
  | 'opt_out'
  | 'dnt'
  | 'unknown';

export type ClickClassificationKind = 'human' | 'scanner' | 'duplicate' | 'opt_out' | 'dnt';

/** Runtime mirrors of the two classification unions, for validating a manual reclassification's
 *  `--to <classification>` value at runtime (§4.4) - TS unions have no runtime representation. */
export const OPEN_CLASSIFICATIONS: readonly OpenClassificationKind[] = [
  'human',
  'google_proxy_prefetch',
  'apple_mpp',
  'self_open',
  'bot',
  'duplicate',
  'opt_out',
  'dnt',
  'unknown',
];
export const CLICK_CLASSIFICATIONS: readonly ClickClassificationKind[] = [
  'human',
  'scanner',
  'duplicate',
  'opt_out',
  'dnt',
];

export interface OpenSignal {
  occurredAt: number; // epoch ms
  ip: string | null; // remote address, already un-proxied
  ua: string | null;
  method: 'GET' | 'HEAD';
  accept: string | null;
  dnt: boolean; // DNT:1 or Sec-GPC:1
}

export interface PriorEventSummary {
  occurredAt: number;
  ipNetHash: string | null;
  uaFamily: string | null;
  counted: boolean;
  classification: OpenClassificationKind;
}

export interface ClassifyConfig {
  openIgnoreSeconds: number;
  proxyPrefetchSeconds: number;
  mppWindowSeconds: number;
  dedupeSeconds: number;
  scannerFanout: number;
  respectDnt: boolean;
}

export interface ClassifyContext {
  sentAt: number | null;
  optedOut: boolean;
  priorEvents: PriorEventSummary[]; // newest first, max 50
  ipHash: string | null;
  ipNetHash: string | null;
  uaInfo: UaInfo;
  fanoutCount: number; // distinct recipients seen from this ipNetHash in 10 min
  config: ClassifyConfig;
  selfIpHashes: Set<string>;
  selfUaPatterns: RegExp[];
  isAppleRelayIp: boolean;
  /** Phase 2 (§4.1): the request IP falls in a shipped Google egress-proxy CIDR range. */
  isGoogleProxyIp: boolean;
  /** Phase 2 (§4.1): the request IP falls in the shipped datacentre CIDR set (click-scanner R6b). */
  isDatacenterIp: boolean;
  /** Phase 2 (§4.1): the recipient already has at least one counted (human) open. */
  hasCountedOpen: boolean;
}

export interface OpenClassification {
  classification: OpenClassificationKind;
  confidence: number; // 0..1
  counted: boolean;
  reasons: string[]; // e.g. ['R2']
}

export interface ClickClassification {
  classification: ClickClassificationKind;
  confidence: number;
  counted: boolean;
  reasons: string[];
}

export type DeviceType = 'desktop' | 'mobile' | 'tablet' | 'proxy' | 'bot' | 'unknown';

export interface UaInfo {
  family: string | null; // 'GoogleImageProxy' | 'AppleMail' | 'Chrome' | ...
  deviceType: DeviceType;
  os: string | null;
  isGoogleProxy: boolean;
  isBot: boolean;
  isAppleMail: boolean;
}

export interface RecipientCounters {
  openCount: number; // counted human opens
  machineOpenCount: number; // non-counted / machine-classified events
  clickCount: number; // counted clicks
  firstOpenAt: number | null;
  lastOpenAt: number | null;
}

export type RecipientState = 'not_opened' | 'prefetched' | 'opened' | 'read_confirmed' | 'replied';

/** Runtime mirror of `RecipientState`, for validating a dashboard/CLI `state=` filter value at
 *  runtime (Phase 3 §2.6) - TS unions have no runtime representation. */
export const RECIPIENT_STATES: readonly RecipientState[] = [
  'not_opened',
  'prefetched',
  'opened',
  'read_confirmed',
  'replied',
];
