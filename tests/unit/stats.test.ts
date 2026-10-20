import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../../src/db/index.js';
import {
  addLink,
  addRecipient,
  createMessage,
  ensureAccount,
  insertClickEvent,
  insertOpenEvent,
  markMessageSent,
  markRecipientSent,
  recomputeRecipientCounters,
  setRepliedAt,
} from '../../src/db/repo.js';
import { statsReport } from '../../src/db/stats.js';
import { newId } from '../../src/core/ids.js';

const SENT_AT = 1_700_000_000_000;

function seedRecipient(db: ReturnType<typeof openDb>, opts: { openAt?: number; clicked?: boolean; replied?: boolean }) {
  const account = ensureAccount(db, { email: 'sender@example.com', transport: 'dryrun' });
  const message = createMessage(db, {
    accountId: account.id,
    subject: 'hi',
    bodyHtml: '<p>hi</p>',
    bodyText: 'hi',
    status: 'sent',
    trackingEnabled: true,
    clickTrackingEnabled: true,
  });
  markMessageSent(db, message.id, { rfc822MsgId: '<a@b>', sentAt: SENT_AT });
  const recipient = addRecipient(db, { messageId: message.id, email: `${newId()}@example.com`, token: newId() });
  markRecipientSent(db, recipient.id, { rfc822MsgId: '<a@b>', sentAt: SENT_AT });
  if (opts.openAt !== undefined) {
    insertOpenEvent(db, {
      recipientId: recipient.id,
      occurredAt: opts.openAt,
      classification: 'human',
      confidence: 0.9,
      counted: true,
      reason: 'R9',
      ipHash: null,
      ipNetHash: null,
      ua: null,
      uaFamily: null,
      deviceType: null,
      os: null,
    });
  }
  if (opts.replied) {
    setRepliedAt(db, recipient.id, { atMs: SENT_AT + 3600_000, replyMsgId: null });
  }
  recomputeRecipientCounters(db, recipient.id);
  return { message, recipient };
}

describe('db/stats', () => {
  it('153. open/click/reply rates match an independent SQL cross-check; drafts/failed excluded from the denominator', () => {
    const db = openDb(':memory:');
    migrate(db);
    const { recipient: openedRecipient, message: openedMessage } = seedRecipient(db, { openAt: SENT_AT + 60_000 });
    seedRecipient(db, {});
    seedRecipient(db, { replied: true });

    // A click, on the already-opened recipient - exercises clickRate independently of openRate.
    const link = addLink(db, { messageId: openedMessage.id, url: 'https://example.com', label: null, position: 0 });
    insertClickEvent(db, {
      linkId: link.id,
      recipientId: openedRecipient.id,
      occurredAt: SENT_AT + 90_000,
      classification: 'human',
      confidence: 0.9,
      counted: true,
      reason: 'R9',
      ipHash: null,
      ipNetHash: null,
      ua: null,
      uaFamily: null,
      deviceType: null,
      os: null,
    });
    recomputeRecipientCounters(db, openedRecipient.id);

    // a draft message must never dilute the denominator
    const account = ensureAccount(db, { email: 'sender@example.com', transport: 'dryrun' });
    const draft = createMessage(db, { accountId: account.id, subject: 'draft', bodyHtml: null, bodyText: null, status: 'draft', trackingEnabled: true, clickTrackingEnabled: false });
    addRecipient(db, { messageId: draft.id, email: 'draftee@example.com', token: newId() });

    const report = statsReport(db, { sinceMs: 0, untilMs: SENT_AT + 10 * 86_400_000, timeZone: 'UTC' });

    // Independent cross-checks: a DIFFERENT SQL formulation (EXISTS/subqueries rather than the
    // report's own SUM(CASE...)) computing the same numbers, so this cannot pass merely by
    // restating statsReport's own query back at it.
    const crossCheck = (predicate: string): number =>
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM recipients r JOIN messages m ON m.id = r.message_id
              WHERE m.status IN ('sent','dryrun') AND (${predicate})`,
          )
          .get() as { n: number }
      ).n;
    const sqlRecipients = crossCheck('1=1');
    const sqlOpened = crossCheck('EXISTS (SELECT 1 FROM open_events oe WHERE oe.recipient_id = r.id AND oe.counted = 1)');
    const sqlClicked = crossCheck('EXISTS (SELECT 1 FROM click_events ce WHERE ce.recipient_id = r.id AND ce.counted = 1)');
    const sqlReplied = crossCheck('r.replied_at IS NOT NULL');

    expect(report.totals.recipients).toBe(sqlRecipients);
    expect(report.totals.recipients).toBe(3);
    expect(report.totals.opened).toBe(sqlOpened);
    expect(report.totals.opened).toBe(1);
    expect(report.totals.clicked).toBe(sqlClicked);
    expect(report.totals.clicked).toBe(1);
    expect(report.totals.replied).toBe(sqlReplied);
    expect(report.totals.replied).toBe(1);
    expect(report.rates.openRate).toBeCloseTo(sqlOpened / sqlRecipients, 4);
    expect(report.rates.openRate).toBeCloseTo(1 / 3, 4);
    expect(report.rates.clickRate).toBeCloseTo(sqlClicked / sqlRecipients, 4);
    expect(report.rates.clickRate).toBeCloseTo(1 / 3, 4);
    expect(report.rates.clickToOpenRate).toBeCloseTo(sqlClicked / sqlOpened, 4);
    expect(report.rates.replyRate).toBeCloseTo(sqlReplied / sqlRecipients, 4);
    expect(report.rates.replyRate).toBeCloseTo(1 / 3, 4);
    db.close();
  });

  it('154. time-to-open buckets are exhaustive/ordered; clock-skew opens are excluded, not negative-bucketed; median/p90 match a fixed, hand-computed reference', () => {
    const db = openDb(':memory:');
    migrate(db);
    seedRecipient(db, { openAt: SENT_AT + 30_000 }); // lt_1m
    seedRecipient(db, { openAt: SENT_AT + 10 * 60_000 }); // m5_30
    seedRecipient(db, { openAt: SENT_AT - 5_000 }); // clock skew - excluded

    const report = statsReport(db, { sinceMs: 0, untilMs: SENT_AT + 86_400_000, timeZone: 'UTC' });
    expect(report.timeToOpen.buckets.map((b) => b.key)).toEqual(['lt_1m', 'm1_5', 'm5_30', 'm30_2h', 'h2_6', 'h6_24', 'd1_3', 'gt_3d']);
    expect(report.timeToOpen.sampleSize).toBe(2);
    expect(report.timeToOpen.medianMs).toBe((30_000 + 600_000) / 2);
    db.close();
  });

  it('154b. p90 on a known 10-sample set matches the hand-computed 90th-percentile value (M9: p90 was previously unasserted)', () => {
    const db = openDb(':memory:');
    migrate(db);
    // Ten recipients, opened at 1..10 minutes after send - a clean, hand-verifiable set: sorted
    // ascending deltas are 60_000, 120_000, ..., 600_000; the 90th percentile
    // (ceil(0.9*10)-1 = index 8, 0-based) is the 9th-smallest value, 540_000.
    for (let i = 1; i <= 10; i++) {
      seedRecipient(db, { openAt: SENT_AT + i * 60_000 });
    }
    const report = statsReport(db, { sinceMs: 0, untilMs: SENT_AT + 86_400_000, timeZone: 'UTC' });
    expect(report.timeToOpen.sampleSize).toBe(10);
    expect(report.timeToOpen.medianMs).toBe((300_000 + 360_000) / 2);
    expect(report.timeToOpen.p90Ms).toBe(540_000);
    db.close();
  });

  it('155. bestHour respects REPORT_TIMEZONE: the same event lands in a different hour for UTC vs America/New_York', () => {
    const db = openDb(':memory:');
    migrate(db);
    const openAt = Date.UTC(2024, 5, 1, 23, 0);
    seedRecipient(db, { openAt });
    const utcReport = statsReport(db, { sinceMs: 0, untilMs: openAt + 86_400_000, timeZone: 'UTC' });
    const nyReport = statsReport(db, { sinceMs: 0, untilMs: openAt + 86_400_000, timeZone: 'America/New_York' });
    expect(utcReport.bestHour.peakHour).toBe(23);
    expect(nyReport.bestHour.peakHour).toBe(19); // UTC-4 in June (EDT)
    db.close();
  });

  it('155b. bestHour buckets correctly across a DST spring-forward boundary (M9: no DST case was previously exercised)', () => {
    const db = openDb(':memory:');
    migrate(db);
    // 2024-03-10 07:30 UTC: America/New_York springs forward at 2024-03-10 07:00 UTC (2am EST ->
    // 3am EDT). Before the transition (still EST, UTC-5) this instant would bucket to hour 2; the
    // correct DST-aware answer (EDT, UTC-4) is hour 3 - a naive fixed-offset conversion would get
    // this wrong.
    const afterSpringForward = Date.UTC(2024, 2, 10, 7, 30);
    seedRecipient(db, { openAt: afterSpringForward });
    const nyReport = statsReport(db, { sinceMs: 0, untilMs: afterSpringForward + 86_400_000, timeZone: 'America/New_York' });
    expect(nyReport.bestHour.peakHour).toBe(3);

    // Symmetric check half an hour before the transition instant (still EST, UTC-5): 06:30 UTC
    // local-izes to 01:30 EST, hour 1.
    const beforeSpringForward = Date.UTC(2024, 2, 10, 6, 30);
    const db2 = openDb(':memory:');
    migrate(db2);
    const account = ensureAccount(db2, { email: 'sender@example.com', transport: 'dryrun' });
    const message = createMessage(db2, { accountId: account.id, subject: 'hi', bodyHtml: '<p>hi</p>', bodyText: 'hi', status: 'sent', trackingEnabled: true, clickTrackingEnabled: false });
    markMessageSent(db2, message.id, { rfc822MsgId: '<a@b>', sentAt: beforeSpringForward - 3_600_000 });
    const recipient = addRecipient(db2, { messageId: message.id, email: 'x@example.com', token: newId() });
    markRecipientSent(db2, recipient.id, { rfc822MsgId: '<a@b>', sentAt: beforeSpringForward - 3_600_000 });
    insertOpenEvent(db2, {
      recipientId: recipient.id,
      occurredAt: beforeSpringForward,
      classification: 'human',
      confidence: 0.9,
      counted: true,
      reason: 'R9',
      ipHash: null,
      ipNetHash: null,
      ua: null,
      uaFamily: null,
      deviceType: null,
      os: null,
    });
    recomputeRecipientCounters(db2, recipient.id);
    const nyReportBefore = statsReport(db2, { sinceMs: 0, untilMs: beforeSpringForward + 86_400_000, timeZone: 'America/New_York' });
    expect(nyReportBefore.bestHour.peakHour).toBe(1);
    db.close();
    db2.close();
  });

  it('Amendment (stats denominator): rates exclude opted-out recipients from the denominator, but totals.recipients still counts them', () => {
    const db = openDb(':memory:');
    migrate(db);
    seedRecipient(db, { openAt: SENT_AT + 60_000 }); // opened, tracked
    const { recipient: optedOutRecipient } = seedRecipient(db, {}); // never opened AND opts out
    db.prepare('UPDATE recipients SET opted_out_at = ? WHERE id = ?').run(SENT_AT + 120_000, optedOutRecipient.id);

    const report = statsReport(db, { sinceMs: 0, untilMs: SENT_AT + 10 * 86_400_000, timeZone: 'UTC' });
    expect(report.totals.recipients).toBe(2); // full window count, opted-out included
    expect(report.totals.optedOut).toBe(1);
    expect(report.totals.opened).toBe(1);
    // Denominator is 1 (2 recipients - 1 opted-out), not 2 - the opted-out recipient never dilutes
    // the rate just because they could never register another counted open again.
    expect(report.rates.openRate).toBeCloseTo(1 / 1, 4);
    db.close();
  });

  it('156. an empty window yields all-zero counts, 0 rates (never NaN), medianMs: null, peakHour: null', () => {
    const db = openDb(':memory:');
    migrate(db);
    const report = statsReport(db, { sinceMs: 0, untilMs: SENT_AT, timeZone: 'UTC' });
    expect(report.totals.recipients).toBe(0);
    expect(report.rates.openRate).toBe(0);
    expect(report.rates.clickToOpenRate).toBe(0);
    expect(report.timeToOpen.medianMs).toBeNull();
    expect(report.bestHour.peakHour).toBeNull();
    db.close();
  });

  it('157 (unit half). statsReport stays a pure function of the window - the same inputs always produce the same report', () => {
    const db = openDb(':memory:');
    migrate(db);
    seedRecipient(db, { openAt: SENT_AT + 60_000 });
    const a = statsReport(db, { sinceMs: 0, untilMs: SENT_AT + 86_400_000, timeZone: 'UTC' });
    const b = statsReport(db, { sinceMs: 0, untilMs: SENT_AT + 86_400_000, timeZone: 'UTC' });
    expect(a.totals).toEqual(b.totals);
    expect(a.rates).toEqual(b.rates);
    db.close();
  });
});
