import type { DB } from '../../db/index.js';
import { withTx } from '../../db/index.js';
import {
  audit,
  deleteImpliedOpenForRecipient,
  getClickEvent,
  getOpenEvent,
  recomputeRecipientCounters,
  updateEventClassification,
} from '../../db/repo.js';
import { CLICK_CLASSIFICATIONS, OPEN_CLASSIFICATIONS, type RecipientState } from '../../types.js';

export class ReclassifyNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReclassifyNotFoundError';
  }
}

export class ReclassifyInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReclassifyInvalidError';
  }
}

export interface ReclassifyInput {
  kind: 'open' | 'click';
  eventId: string;
  classification: string;
  counted?: boolean;
  note?: string;
  actor: string;
  atMs: number;
}

export interface ReclassifyEventSnapshot {
  classification: string;
  counted: boolean;
  confidence: number;
  reason: string | null;
}

export interface ReclassifyResult {
  eventId: string;
  kind: 'open' | 'click';
  before: ReclassifyEventSnapshot;
  after: ReclassifyEventSnapshot;
  recipient: {
    id: string;
    openCount: number;
    machineOpenCount: number;
    clickCount: number;
    state: RecipientState;
  };
}

// counted defaults to true for `human`, false for every machine classification (§4.4).
const COUNTED_BY_DEFAULT = new Set(['human']);

/**
 * Manual override of a single event's classification (§4.4). Counters are recomputed from the
 * event tables (never patched by delta), and the override never emits a notification - the caller
 * (route/CLI) must not publish anything to the bus for this path.
 */
export function reclassify(db: DB, input: ReclassifyInput): ReclassifyResult {
  const validSet = input.kind === 'open' ? OPEN_CLASSIFICATIONS : CLICK_CLASSIFICATIONS;
  if (!validSet.includes(input.classification as never)) {
    throw new ReclassifyInvalidError(
      `"${input.classification}" is not a valid ${input.kind} classification (expected one of ${validSet.join(', ')})`,
    );
  }

  const existing = input.kind === 'open' ? getOpenEvent(db, input.eventId) : getClickEvent(db, input.eventId);
  if (!existing) {
    throw new ReclassifyNotFoundError(`${input.kind} event not found: ${input.eventId}`);
  }

  return withTx(db, () => {
    const before: ReclassifyEventSnapshot = {
      classification: existing.classification,
      counted: existing.counted === 1,
      confidence: existing.confidence,
      reason: existing.reason,
    };
    const counted = input.counted ?? COUNTED_BY_DEFAULT.has(input.classification);

    updateEventClassification(db, input.kind, input.eventId, {
      classification: input.classification,
      counted,
      confidence: 1,
      reason: 'manual',
      originalClassification: existing.original_classification ?? existing.classification,
      overriddenAt: input.atMs,
    });

    // Demoting a counted click away from human also removes a still-unused back-filled open, so
    // the two stay consistent (§4.4).
    let removedImpliedOpenId: string | null = null;
    if (input.kind === 'click' && before.counted && !counted) {
      removedImpliedOpenId = deleteImpliedOpenForRecipient(db, existing.recipient_id);
    }

    const counters = recomputeRecipientCounters(db, existing.recipient_id);
    const after: ReclassifyEventSnapshot = {
      classification: input.classification,
      counted,
      confidence: 1,
      reason: 'manual',
    };

    audit(db, {
      actor: input.actor,
      action: 'reclassify.override',
      subjectType: `${input.kind}_event`,
      subjectId: input.eventId,
      detail: { kind: input.kind, eventId: input.eventId, before, after, note: input.note ?? null, removedImpliedOpenId },
    });

    return {
      eventId: input.eventId,
      kind: input.kind,
      before,
      after,
      recipient: {
        id: existing.recipient_id,
        openCount: counters.openCount,
        machineOpenCount: counters.machineOpenCount,
        clickCount: counters.clickCount,
        state: counters.state,
      },
    };
  });
}
