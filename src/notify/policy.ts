import type { ChannelName, NotifyTrigger, TrackingEvent } from './types.js';

export interface NotifyPolicyConfig {
  on: NotifyTrigger[];
  channels: ChannelName[];
  /** docs/08_phase4_spec.md §2.9 (P9): 'digest' (default) suppresses every per-open/per-click
   *  trigger for a campaign event - the digest job notifies instead. 'off' suppresses them with no
   *  digest either. 'per-open' restores Phase 2/3 behaviour exactly, ignoring campaignId. Optional
   *  so every existing non-campaign caller/test is unaffected. */
  campaignMode?: 'off' | 'digest' | 'per-open';
}

const SUPPRESSED_CLASSIFICATIONS = new Set(['opt_out', 'dnt', 'self_open', 'duplicate']);

/**
 * Transition-based notification policy (§2.4, rules P0-P6), evaluated in order. Non-terminal: a
 * single event can yield more than one trigger (e.g. `first_open` and `read_confirmed`), but never
 * `first_open` and `click` (an open event never satisfies P6, a click event never satisfies P4).
 *
 * Phase 2.1 amendment (finding #2): P6 supersedes P5 for the same event. A click that also flips
 * the recipient into `read_confirmed` (the common case for a click-triggered back-fill, since the
 * synthetic open is itself never a trigger - P2 below) must produce exactly one trigger, `click`,
 * not `[read_confirmed, click]` - the click already says everything `read_confirmed` would, and a
 * back-filling click must notify exactly once (DoD 8). An *open* event that flips the state still
 * gets its own `read_confirmed` trigger as before; only a click event's P5 is suppressed.
 */
const PROGRESSED_STATES = new Set(['read_confirmed', 'replied']);

export function decideTriggers(e: TrackingEvent, cfg: NotifyPolicyConfig): NotifyTrigger[] {
  // P7 (Phase 3 §3.6): evaluated *before* P0 - an operator who explicitly scheduled a reminder gets
  // it even on a muted message ("--mute silences tracking noise, not the operator's own alarm").
  if (e.kind === 'reminder') {
    return (['reminder'] as NotifyTrigger[]).filter((t) => cfg.on.includes(t));
  }

  // P0: muted, always - nothing, no exceptions.
  if (e.muted) return [];
  // P1: machine/suppressed classifications never notify.
  if (SUPPRESSED_CLASSIFICATIONS.has(e.classification)) return [];

  // P8 (Phase 3 §3.6): a detected reply, evaluated after P0/P1 so mute still applies.
  if (e.kind === 'reply') {
    return (['reply'] as NotifyTrigger[]).filter((t) => cfg.on.includes(t));
  }

  // P9 (docs/08_phase4_spec.md §2.9): a campaign event, evaluated after P0/P1 (mute and machine
  // classifications still win) and before P3-P6. Default 'digest' - the event is still recorded
  // (SSE still sees it), but no per-open notification fires; the campaign-digest job aggregates
  // instead. 'off' suppresses both. 'per-open' falls through to P3-P6 unchanged. Truthiness check
  // (not `!== null`): every pre-Phase-4 caller/test builds a `TrackingEvent` without `campaignId`
  // at all, so it is `undefined`, not `null`, there - both mean "not a campaign event".
  if (e.campaignId) {
    const mode = cfg.campaignMode ?? 'digest';
    if (mode === 'off') return [];
    if (mode === 'digest') return [];
  }

  // P2: the back-filled implied-open never notifies itself; the click that caused it does.
  if (e.backfilled) return [];

  const triggers: NotifyTrigger[] = [];

  // P3: an uncounted prefetch-only transition (off by default; only meaningful when explicitly
  // listed in NOTIFY_ON, filtered below).
  if (!e.counted && e.prevState === 'not_opened' && e.newState === 'prefetched') {
    triggers.push('prefetched');
  }
  // P4: the first counted open.
  if (e.kind === 'open' && e.counted && e.counters.openCount === 1) {
    triggers.push('first_open');
  }
  // P5: a transition into read_confirmed (Phase 3: or replied, though a reply itself is handled by
  // P8 above and never reaches here - this widening only prevents a *later* open/click on an
  // already-replied recipient from re-firing read_confirmed) - except on a click event, where P6
  // (below) supersedes it.
  if (
    e.counted &&
    PROGRESSED_STATES.has(e.newState) &&
    !PROGRESSED_STATES.has(e.prevState) &&
    e.kind !== 'click'
  ) {
    triggers.push('read_confirmed');
  }
  // P6: a counted click.
  if (e.kind === 'click' && e.counted) {
    triggers.push('click');
  }

  return triggers.filter((t) => cfg.on.includes(t));
}

/** Backed by `UNIQUE(dedupe_key)` so exactly-once delivery survives races and restarts (§2.4). */
export function dedupeKey(trigger: NotifyTrigger, e: TrackingEvent, channel: ChannelName): string {
  switch (trigger) {
    case 'first_open':
      return `${channel}:first_open:${e.recipientId}`;
    case 'read_confirmed':
      return `${channel}:read_confirmed:${e.recipientId}`;
    case 'prefetched':
      return `${channel}:prefetched:${e.recipientId}`;
    case 'click':
      return `${channel}:click:${e.eventId}`;
    // Phase 3 (§3.6): `e.eventId` is the reminder's own id for a `reminder` TrackingEvent.
    case 'reminder':
      return `${channel}:reminder:${e.eventId}`;
    case 'reply':
      return `${channel}:reply:${e.recipientId}`;
    case 'campaign_digest':
      // Never produced by decideTriggers itself (P9 always suppresses it here) - the digest job
      // computes its own dedupe key directly (`${channel}:campaign_digest:${campaignId}:${windowStartMs}`).
      // This arm exists only so the switch stays exhaustive.
      return `${channel}:campaign_digest:${e.recipientId}`;
    case 'daily_digest':
      // Never produced by decideTriggers itself either - src/jobs/daily-digest.ts computes its own
      // dedupe key directly (`${channel}:daily_digest:${yyyy-mm-dd}`). Exhaustiveness only.
      return `${channel}:daily_digest:${e.recipientId}`;
  }
}
