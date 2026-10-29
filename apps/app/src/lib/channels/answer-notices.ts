import type { Channel } from "@healdesk/catalog";
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";

import { unsafeDb, type Transaction } from "@/db";
import {
  answerOutages,
  clinicChannels,
  clinics,
  clinicSettings,
  missCases,
  missedContacts,
  routedInteractions,
  type AnswerOutage,
} from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { clinicLocalDate } from "@/lib/clinic/closures";
import type { GuaranteeMissPayload } from "@/lib/email/templates/guarantee_miss";
import type { OutageEndedPayload, OutageStartedPayload } from "@/lib/email/templates/outage";
import { describeError, log } from "@/lib/log";
import { enqueuePlanNotice } from "@/lib/notices/plan-notices";
import { notifyOpsOnce } from "@/lib/ops/notify";
import { publicOriginProblem, publicUrl } from "@/lib/public-url";
import { replyByDay } from "@/lib/reply-by";
import { newSupportRef } from "@/lib/support/cases";
import { purgeMissedContacts } from "@/lib/portal/missed-contacts";
import { withTenant } from "@/lib/tenant";
import { usableLine } from "@/lib/voice/fallback-line";

import { recordMissedContact } from "./routed-answered";
import { OUTAGE_MISSED_REASONS } from "./routed-words";

/**
 * The routed/answered counter's minute sweep (Gate B), and the workflows
 * behind its three notices (owner, 29 October 2026: "the notices must be
 * backed by real backend workflows that actually happen once they are
 * sent"; docs/design/launch-readiness-2026-10-27/gate-b-notice-workflows.md).
 * Every notice goes through F0's outbox (billing_notices) under a dedupe key,
 * in the same transaction as the record it promises, so a sweep that runs
 * twice, or two that overlap, do each once; the outbox retries a send that
 * fails, and tells ops of a critical one still unsent (the minute sender's
 * critical_notice_undelivered).
 *
 *   1. **Unsettled is missed.** A row still `pending` ROUTED_PENDING_GRACE_MS
 *      after it reached us belongs to a process that stopped before it said
 *      what happened: Terms §5 counts that as missed (`no_outcome`).
 *
 *   2. **L17 and the outage incident.** An outage is the run of calls and
 *      conversations our side failed to answer (every miss but a late answer,
 *      OUTAGE_MISSED_REASONS) since the last one AYA answered, across the
 *      clinic's channels. Once that run has lasted OUTAGE_AFTER_MS (its first
 *      and latest failure at least ten minutes apart, nothing answered
 *      between), one transaction opens the incident (answer_outages, status
 *      open, its channels and start) and queues L17 under
 *      `outage_started:<incident id>`; after it commits, ops is alerted
 *      (`aya_outage_started`, once per incident). A failure with no traffic
 *      after it is no evidence of an outage, and sends nothing.
 *
 *   3. **L18 and recovery.** The open incident takes in each later failure
 *      (its latest failure and channels move on). It has recovered once AYA
 *      has answered something after its latest failure and RECOVERY_QUIET_MS
 *      have passed since that first answer with no failure on any channel:
 *      a failure inside the quiet time moves the latest failure on, so the
 *      clock starts again (no flapping). One transaction then closes the
 *      incident, with when she answered again and the calls and chats the
 *      counter shows unanswered from its start until then, and queues L18
 *      under `outage_ended:<incident id>`, so L18 goes once, only for an
 *      incident L17 opened. One still open OUTAGE_ESCALATE_AFTER_MS after it
 *      opened, and every OUTAGE_ESCALATE_EVERY_MS after, is escalated to the
 *      owner (`aya_outage_unresolved`), so "we will keep you updated" cannot
 *      go quiet.
 *
 *   4. **L21 and the miss investigation.** A miss counts when it falls in the
 *      practice's first month (its first channel's go-live day and the 29
 *      after it, in the practice's own calendar, firstMonthOf) on a channel
 *      live when it reached us. The collapse rule: one case and one email per
 *      channel and practice-local day (miss_cases, unique on both), opened on
 *      the practice's billing clinic once that day has ended and
 *      MISS_NOTICE_SETTLE_MS more have passed, so the case counts every miss
 *      of the day and step 1's settled ones with it: within a day of the
 *      miss, inside Terms §5's seven. The transaction that opens the case
 *      queues L21 under `guarantee_miss:<case id>`, naming the day's first
 *      miss; the email's subject carries the channel's noun and the day, by
 *      which, with the clinic's own address, the clinic's reply joins one
 *      support case (lib/channels/miss-cases.ts, missReplyOf;
 *      lib/support/inbound/handle.ts);
 *      after it commits, ops is alerted (`aya_miss_case_opened`, once per
 *      case) with the case's reply-by day.
 *
 * A notice that could not be queued (the transaction failed) leaves its
 * incident or case unopened, so the next minute tries again, and ops hears
 * of it once per clinic and kind (`answer_notice_not_queued`).
 *
 * Unswitched, like the redial sweep: the notices are promises of the Terms
 * and of the emails, and settling a pending row is a pure function of the
 * clock. What reaches a clinic is still gated by the outbox's own switch.
 */

const ACTOR: ActorContext = { type: "service", serviceName: "answer-notices" };

/** A row still pending this long after it reached us is missed (`no_outcome`). */
export const ROUTED_PENDING_GRACE_MS = 10 * 60_000;
/** Annex X5's L17: our side has failed to answer for ten minutes. */
export const OUTAGE_AFTER_MS = 10 * 60_000;
/** Recovery: AYA has answered, and nothing has failed, for this long. */
export const RECOVERY_QUIET_MS = 10 * 60_000;
/** An incident still open this long after it opened is escalated to the owner. */
export const OUTAGE_ESCALATE_AFTER_MS = 2 * 60 * 60_000;
/** And again this often while it stays open. */
export const OUTAGE_ESCALATE_EVERY_MS = 12 * 60 * 60_000;
/** The guarantee's first month: 30 days from the practice's first go-live (Terms §5). */
export const GUARANTEE_FIRST_MONTH_DAYS = 30;
/** A claim may be made within 30 days after the first month ends (Terms §5). */
export const GUARANTEE_CLAIM_DAYS = 30;
/** Terms §5: the miss is told within 7 days of recording it. */
export const GUARANTEE_MISS_NOTICE_DAYS = 7;
/** After a day ends, how long the sweep waits before counting its misses: past the pending grace. */
export const MISS_NOTICE_SETTLE_MS = 15 * 60_000;
/** How far back the sweep looks for rows: past the seven days, with a day to spare. */
export const SWEEP_LOOKBACK_DAYS = GUARANTEE_MISS_NOTICE_DAYS + 1;

const DAY_MS = 86_400_000;
const CHANNEL_ORDER: readonly Channel[] = ["voice", "web", "meta"];

export type AnswerNoticesOutcome = {
  status: "ok" | "failed";
  note: string;
  settled: number;
  /** Missed contacts deleted at their 30 days. */
  missedContactsDeleted: number;
  outagesStarted: number;
  outagesEnded: number;
  outagesEscalated: number;
  missCases: number;
};

/** An ops alert to raise once the transaction that made it true has committed. */
type After = () => Promise<void>;

type Work = { clinicId: string; practiceId: string; practiceFirstLiveAt: Date | null };

async function workSince(since: Date): Promise<Work[]> {
  const result = await unsafeDb.execute<{
    clinic_id: string;
    practice_id: string;
    practice_first_live_at: Date | string | null;
  }>(sql`select clinic_id, practice_id, practice_first_live_at from app_routed_answered_work(${since.toISOString()}::timestamptz)`);
  return result.rows.map((row) => ({
    clinicId: String(row.clinic_id),
    practiceId: String(row.practice_id),
    practiceFirstLiveAt: row.practice_first_live_at === null ? null : new Date(row.practice_first_live_at),
  }));
}

/** Step 1: every row still pending past its grace becomes missed. Returns how many. */
export async function settlePending(db: Transaction, clinicId: string, now: Date): Promise<number> {
  const rows = await db
    .update(routedInteractions)
    .set({ outcome: "missed", reason: "no_outcome", resolvedAt: now })
    .where(
      and(
        eq(routedInteractions.clinicId, clinicId),
        eq(routedInteractions.outcome, "pending"),
        lt(routedInteractions.routedAt, new Date(now.getTime() - ROUTED_PENDING_GRACE_MS)),
      ),
    )
    .returning({ channel: routedInteractions.channel, refHash: routedInteractions.refHash, routedAt: routedInteractions.routedAt });
  // Each is an unanswered call or conversation: its missed-contact record,
  // with nothing known of where it went or who it was.
  for (const row of rows) {
    await recordMissedContact(db, clinicId, {
      channel: row.channel as Channel,
      refHash: row.refHash,
      missedAt: row.routedAt,
      wentTo: "unknown",
      callerPhone: null,
    });
  }
  return rows.length;
}

const isOutageMiss = sql`${routedInteractions.outcome} = 'missed' and ${routedInteractions.reason} in (${sql.join(
  OUTAGE_MISSED_REASONS.map((r) => sql`${r}`),
  sql`, `,
)})`;
/**
 * AYA answered it, if late: an answer ends a run of failures. Not a
 * conversation answered once and then failed (a miss with a first answer
 * kept), which is part of the outage.
 */
const isAnswer = sql`(${routedInteractions.outcome} = 'answered' or (${routedInteractions.outcome} = 'missed' and ${routedInteractions.reason} = 'late'))`;

function channelsOf(rows: readonly { channel: string }[]): Channel[] {
  const seen = new Set(rows.map((r) => r.channel));
  return CHANNEL_ORDER.filter((c) => seen.has(c));
}

/** The portal's missed-contact list (app/c/[slug]/missed), and one contact on it. */
export function missedPath(slug: string, missedContactId?: string): string {
  return missedContactId ? `/c/${slug}/missed/${missedContactId}` : `/c/${slug}/missed`;
}

type ClinicLinks = { slug: string; homeUrl: string; missedUrl: string; canReachDirectLine: boolean };

async function linksOf(db: Transaction, clinicId: string): Promise<ClinicLinks | null> {
  const [clinic] = await db
    .select({
      slug: clinics.slug,
      published: clinics.publishedPhoneE164,
      assistant: clinics.assistantNumberE164,
      directLine: clinicSettings.directLineE164,
    })
    .from(clinics)
    .leftJoin(clinicSettings, eq(clinicSettings.clinicId, clinics.id))
    .where(eq(clinics.id, clinicId))
    .limit(1);
  if (!clinic) return null;
  return {
    slug: clinic.slug,
    homeUrl: publicUrl(`/c/${clinic.slug}`),
    missedUrl: publicUrl(missedPath(clinic.slug)),
    // A line that forwards back to us is no line (lib/voice/fallback-line.ts).
    canReachDirectLine: usableLine(clinic.directLine, [clinic.published, clinic.assistant]) !== null,
  };
}

function notQueued(clinicId: string, kind: "outage_started" | "outage_ended" | "guarantee_miss"): After {
  return () => notifyOpsOnce("answer_notice_not_queued", { clinicId, kind });
}

export type OutageStep = { started: number; ended: number; escalated: number; after: After[] };

/**
 * Steps 2 and 3 for one clinic, in its own tenant: open the incident and
 * queue L17 once ten minutes of failures say so; take later failures into an
 * open incident; close it and queue L18 once recovered; escalate one that
 * stays open. Returns what it did and the alerts to raise after commit.
 */
export async function evaluateOutages(db: Transaction, clinicId: string, now: Date): Promise<OutageStep> {
  const step: OutageStep = { started: 0, ended: 0, escalated: 0, after: [] };
  // A clinic with no channel live answers no patient: its misses are setup, not an outage.
  const [live] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(clinicChannels)
    .where(and(eq(clinicChannels.clinicId, clinicId), isNotNull(clinicChannels.liveAt)));
  if (!live || Number(live.n) === 0) return step;
  if (publicOriginProblem()) {
    // L17 and L18 carry the clinic's Home link: nothing is opened that the sender would refuse.
    log.error("outage notices not queued: no public origin", { clinicId });
    return step;
  }

  const [open] = await db
    .select()
    .from(answerOutages)
    .where(and(eq(answerOutages.clinicId, clinicId), eq(answerOutages.status, "open")))
    .limit(1);
  if (open) {
    await followOpenIncident(db, clinicId, open, now, step);
    return step;
  }

  // No incident open: the failures since the last answer.
  const [last] = await db
    .select({ at: sql<Date | string | null>`max(${routedInteractions.routedAt})` })
    .from(routedInteractions)
    .where(and(eq(routedInteractions.clinicId, clinicId), isAnswer, lte(routedInteractions.routedAt, now)));
  const lastAnswer = last?.at ? new Date(last.at) : null;
  const failures = await db
    .select({ channel: routedInteractions.channel, routedAt: routedInteractions.routedAt })
    .from(routedInteractions)
    .where(
      and(
        eq(routedInteractions.clinicId, clinicId),
        isOutageMiss,
        lastAnswer ? gt(routedInteractions.routedAt, lastAnswer) : undefined,
        lte(routedInteractions.routedAt, now),
      ),
    )
    .orderBy(asc(routedInteractions.routedAt));
  if (failures.length === 0) return step;
  const first = failures[0]!.routedAt;
  const latest = failures[failures.length - 1]!.routedAt;
  if (latest.getTime() - first.getTime() < OUTAGE_AFTER_MS) return step;

  const links = await linksOf(db, clinicId);
  if (!links) return step;
  const channels = channelsOf(failures);
  try {
    const opened = await db.transaction(async (savepoint) => {
      const [incident] = await savepoint
        .insert(answerOutages)
        .values({
          clinicId,
          startedAt: first,
          lastFailureAt: latest,
          channels,
          openedAt: now,
          replyByAt: new Date(now.getTime() + OUTAGE_ESCALATE_AFTER_MS),
        })
        .onConflictDoNothing()
        .returning({ id: answerOutages.id });
      if (!incident) return null;
      const payload: OutageStartedPayload = {
        startedAt: first.toISOString(),
        homeUrl: links.homeUrl,
        canReachDirectLine: links.canReachDirectLine,
        // Website chat is among what failed: its visitors see the contact form.
        isChatAffected: channels.includes("web"),
      };
      await enqueuePlanNotice(savepoint, clinicId, "outage_started", `outage_started:${incident.id}`, payload);
      return incident.id;
    });
    if (opened) {
      step.started += 1;
      step.after.push(() =>
        notifyOpsOnce("aya_outage_started", {
          clinicId,
          eventId: opened,
          windowStart: first.toISOString(),
          code: channels.join("_"),
        }),
      );
    }
  } catch (error) {
    log.error("outage incident not opened", { clinicId, error: describeError(error) });
    step.after.push(notQueued(clinicId, "outage_started"));
  }
  return step;
}

async function followOpenIncident(
  db: Transaction,
  clinicId: string,
  incident: AnswerOutage,
  now: Date,
  step: OutageStep,
): Promise<void> {
  // Later failures join it.
  const later = await db
    .select({ channel: routedInteractions.channel, routedAt: routedInteractions.routedAt })
    .from(routedInteractions)
    .where(
      and(
        eq(routedInteractions.clinicId, clinicId),
        isOutageMiss,
        gt(routedInteractions.routedAt, incident.lastFailureAt),
        lte(routedInteractions.routedAt, now),
      ),
    )
    .orderBy(asc(routedInteractions.routedAt));
  let lastFailureAt = incident.lastFailureAt;
  if (later.length > 0) {
    lastFailureAt = later[later.length - 1]!.routedAt;
    const channels = CHANNEL_ORDER.filter((c) => incident.channels.includes(c) || later.some((l) => l.channel === c));
    await db
      .update(answerOutages)
      .set({ lastFailureAt, channels })
      .where(and(eq(answerOutages.id, incident.id), eq(answerOutages.clinicId, clinicId)));
  }

  // Recovered: answered since the latest failure, and quiet for RECOVERY_QUIET_MS since that answer.
  const [answer] = await db
    .select({ routedAt: routedInteractions.routedAt, answeredAt: routedInteractions.answeredAt })
    .from(routedInteractions)
    .where(
      and(
        eq(routedInteractions.clinicId, clinicId),
        isAnswer,
        gt(routedInteractions.routedAt, lastFailureAt),
        lte(routedInteractions.routedAt, now),
      ),
    )
    .orderBy(asc(routedInteractions.routedAt))
    .limit(1);
  if (answer && now.getTime() - answer.routedAt.getTime() >= RECOVERY_QUIET_MS) {
    const endedAt = answer.answeredAt ?? answer.routedAt;
    const missed = await db
      .select({ channel: routedInteractions.channel })
      .from(routedInteractions)
      .where(
        and(
          eq(routedInteractions.clinicId, clinicId),
          isOutageMiss,
          gte(routedInteractions.routedAt, incident.startedAt),
          lt(routedInteractions.routedAt, answer.routedAt),
        ),
      );
    const callCount = missed.filter((m) => m.channel === "voice").length;
    const chatCount = missed.length - callCount;
    const links = await linksOf(db, clinicId);
    if (!links) return;
    try {
      await db.transaction(async (savepoint) => {
        const closed = await savepoint
          .update(answerOutages)
          .set({ status: "closed", endedAt, callCount, chatCount })
          .where(and(eq(answerOutages.id, incident.id), eq(answerOutages.status, "open")))
          .returning({ id: answerOutages.id });
        if (closed.length === 0) return;
        const payload: OutageEndedPayload = {
          endedAt: endedAt.toISOString(),
          callCount,
          chatCount,
          homeUrl: links.homeUrl,
          missedUrl: links.missedUrl,
        };
        if (await enqueuePlanNotice(savepoint, clinicId, "outage_ended", `outage_ended:${incident.id}`, payload)) {
          step.ended += 1;
        }
      });
    } catch (error) {
      log.error("outage incident not closed", { clinicId, error: describeError(error) });
      step.after.push(notQueued(clinicId, "outage_ended"));
    }
    return;
  }

  // Still open: escalate at the reply-by time, then every OUTAGE_ESCALATE_EVERY_MS.
  const due =
    incident.escalatedAt === null
      ? incident.replyByAt.getTime() <= now.getTime()
      : now.getTime() - incident.escalatedAt.getTime() >= OUTAGE_ESCALATE_EVERY_MS;
  if (due) {
    const escalations = incident.escalations + 1;
    await db
      .update(answerOutages)
      .set({ escalatedAt: now, escalations })
      .where(and(eq(answerOutages.id, incident.id), eq(answerOutages.clinicId, clinicId)));
    step.escalated += 1;
    step.after.push(() =>
      notifyOpsOnce("aya_outage_unresolved", {
        clinicId,
        eventId: incident.id,
        windowStart: incident.startedAt.toISOString(),
        count: escalations,
      }),
    );
  }
}

/** One channel's misses on one practice-local day, across the practice's locations. */
type ChannelDay = {
  first: Date;
  count: number;
  /** The first miss's missed-contact record, its location's slug, and where it went. */
  firstContact: { id: string; slug: string; wasRoutedToDirectLine: boolean } | null;
  /** Each location's missed-contact records of the day, to join to the case. */
  contacts: Map<string, string[]>;
};

/** Per practice-local day, each channel's misses that day. */
type DayMisses = Map<Channel, ChannelDay>;

/**
 * Step 4's reading for one location, in its own tenant: its first-month
 * misses on channels live when they reached us, by practice-local day, for
 * the days that have ended and settled. Added into `into`.
 */
export async function firstMonthMisses(
  db: Transaction,
  clinicId: string,
  input: { firstLiveAt: Date; timeZone: string; now: Date },
  into: Map<string, DayMisses>,
): Promise<void> {
  const month = firstMonthOf(input.firstLiveAt, input.timeZone);
  // A loose bound for the query; the practice-local days decide below.
  const monthEnd = new Date(input.firstLiveAt.getTime() + (GUARANTEE_FIRST_MONTH_DAYS + 1) * DAY_MS);
  const since = new Date(input.now.getTime() - SWEEP_LOOKBACK_DAYS * DAY_MS);
  const [clinic] = await db.select({ slug: clinics.slug }).from(clinics).where(eq(clinics.id, clinicId)).limit(1);
  if (!clinic) return;
  const rows = await db
    .select({
      channel: routedInteractions.channel,
      routedAt: routedInteractions.routedAt,
      contactId: missedContacts.id,
      outcome: missedContacts.outcome,
    })
    .from(routedInteractions)
    .innerJoin(
      clinicChannels,
      and(eq(clinicChannels.clinicId, routedInteractions.clinicId), eq(clinicChannels.channel, routedInteractions.channel)),
    )
    .leftJoin(
      missedContacts,
      and(
        eq(missedContacts.clinicId, routedInteractions.clinicId),
        eq(missedContacts.channel, routedInteractions.channel),
        eq(missedContacts.refHash, routedInteractions.refHash),
      ),
    )
    .where(
      and(
        eq(routedInteractions.clinicId, clinicId),
        eq(routedInteractions.outcome, "missed"),
        gte(routedInteractions.routedAt, input.firstLiveAt),
        lt(routedInteractions.routedAt, monthEnd),
        gte(routedInteractions.routedAt, since),
        isNotNull(clinicChannels.liveAt),
        lte(clinicChannels.liveAt, routedInteractions.routedAt),
      ),
    );
  // Only days that have ended, and settled past the pending grace.
  const settledToday = clinicLocalDate(new Date(input.now.getTime() - MISS_NOTICE_SETTLE_MS), input.timeZone);
  for (const row of rows) {
    const day = clinicLocalDate(row.routedAt, input.timeZone);
    if (day >= settledToday || day < month.startsOn || day > month.endsOn) continue;
    const entry: DayMisses = into.get(day) ?? new Map();
    const channel = row.channel as Channel;
    const seen: ChannelDay = entry.get(channel) ?? { first: row.routedAt, count: 0, firstContact: null, contacts: new Map() };
    seen.count += 1;
    const contact = row.contactId
      ? {
          id: row.contactId,
          slug: clinic.slug,
          // A call put through to the direct line, or a chat shown the contact form instead.
          wasRoutedToDirectLine: row.outcome === "direct_line" || row.outcome === "contact_form",
        }
      : null;
    if (row.routedAt <= seen.first) {
      seen.first = row.routedAt;
      seen.firstContact = contact ?? seen.firstContact;
    } else if (!seen.firstContact && contact) {
      seen.firstContact = contact;
    }
    if (row.contactId) seen.contacts.set(clinicId, [...(seen.contacts.get(clinicId) ?? []), row.contactId]);
    entry.set(channel, seen);
    into.set(day, entry);
  }
}

/** A calendar day plus `days`, both YYYY-MM-DD: date arithmetic, clear of any clock change. */
function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The guarantee's first month in the practice's own calendar (Terms §5: "the
 * 30 days that start on the day your first channel goes live"): that day and
 * the 29 after it, and the last day a claim may be made, 30 days later.
 */
export function firstMonthOf(
  firstLiveAt: Date,
  timeZone: string,
): { startsOn: string; endsOn: string; claimByOn: string } {
  const startsOn = clinicLocalDate(firstLiveAt, timeZone);
  const endsOn = addDays(startsOn, GUARANTEE_FIRST_MONTH_DAYS - 1);
  return { startsOn, endsOn, claimByOn: addDays(endsOn, GUARANTEE_CLAIM_DAYS) };
}

/**
 * Step 4's writing for one practice, in its billing clinic's tenant: for each
 * channel and day, the case and its L21 once, or the day's count brought up
 * to date on a case already open. Returns the cases opened and the alerts to
 * raise after commit.
 */
export async function openMissCases(
  db: Transaction,
  clinicId: string,
  days: ReadonlyMap<string, DayMisses>,
  now: Date,
): Promise<{ opened: number; after: After[]; joins: { caseId: string; contacts: Map<string, string[]> }[] }> {
  const out = { opened: 0, after: [] as After[], joins: [] as { caseId: string; contacts: Map<string, string[]> }[] };
  const [clinic] = await db.select({ slug: clinics.slug }).from(clinics).where(eq(clinics.id, clinicId)).limit(1);
  if (!clinic) return out;
  const slug = clinic.slug;
  for (const [missedOn, day] of [...days.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    for (const channel of CHANNEL_ORDER.filter((c) => day.has(c))) {
      const { first, count, firstContact } = day.get(channel)!;
      const [existing] = await db
        .select({ id: missCases.id, missCount: missCases.missCount })
        .from(missCases)
        .where(and(eq(missCases.clinicId, clinicId), eq(missCases.channel, channel), eq(missCases.missedOn, missedOn)))
        .limit(1);
      if (existing) {
        if (count > existing.missCount) {
          await db
            .update(missCases)
            .set({ missCount: count, firstMissedAt: first })
            .where(and(eq(missCases.id, existing.id), eq(missCases.clinicId, clinicId)));
        }
        out.joins.push({ caseId: existing.id, contacts: day.get(channel)!.contacts });
        continue;
      }
      const replyByOn = replyByDay(now);
      try {
        const opened = await db.transaction(async (savepoint) => {
          // A ref taken by another case is drawn again; the day's key makes a race open one case.
          for (let attempt = 0; attempt < 5; attempt += 1) {
            const ref = newSupportRef();
            const rows = await savepoint
              .insert(missCases)
              .values({
                clinicId,
                ref,
                channel,
                missedOn,
                firstMissedAt: first,
                missCount: count,
                openedAt: now,
                replyByOn,
                statusAt: now,
              })
              .onConflictDoNothing()
              .returning({ id: missCases.id, ref: missCases.ref });
            const row = rows[0];
            if (row) {
              // The button opens the day's first missed contact; without its
              // record (deleted, or never written) the list of them.
              const payload: GuaranteeMissPayload = {
                channel,
                missedAt: first.toISOString(),
                wasRoutedToDirectLine: firstContact?.wasRoutedToDirectLine ?? false,
                missedUrl: publicUrl(firstContact ? missedPath(firstContact.slug, firstContact.id) : missedPath(slug)),
              };
              await enqueuePlanNotice(savepoint, clinicId, "guarantee_miss", `guarantee_miss:${row.id}`, payload);
              return row;
            }
            const [raced] = await savepoint
              .select({ id: missCases.id })
              .from(missCases)
              .where(and(eq(missCases.clinicId, clinicId), eq(missCases.channel, channel), eq(missCases.missedOn, missedOn)))
              .limit(1);
            if (raced) return null;
          }
          throw new Error("No free ref for a miss case.");
        });
        if (opened) {
          out.opened += 1;
          out.joins.push({ caseId: opened.id, contacts: day.get(channel)!.contacts });
          out.after.push(() =>
            notifyOpsOnce(
              "aya_miss_case_opened",
              { clinicId, channel, eventId: opened.id, count },
              { promisedOn: replyByOn },
            ),
          );
        }
      } catch (error) {
        log.error("miss case not opened", { clinicId, channel, error: describeError(error) });
        out.after.push(notQueued(clinicId, "guarantee_miss"));
      }
    }
  }
  return out;
}

async function runAfter(after: readonly After[]): Promise<void> {
  for (const raise of after) {
    try {
      await raise();
    } catch (error) {
      log.error("answer notices: an ops alert was not raised", { error: describeError(error) });
    }
  }
}

/** The run: settle, then each clinic's outages, then each practice's first-month misses. Never throws. */
export async function runAnswerNoticesSweep(now: Date = new Date()): Promise<AnswerNoticesOutcome> {
  const out: AnswerNoticesOutcome = {
    status: "ok",
    note: "",
    settled: 0,
    missedContactsDeleted: 0,
    outagesStarted: 0,
    outagesEnded: 0,
    outagesEscalated: 0,
    missCases: 0,
  };
  let failures = 0;
  let work: Work[];
  try {
    work = await workSince(new Date(now.getTime() - SWEEP_LOOKBACK_DAYS * DAY_MS));
  } catch (error) {
    log.error("answer notices sweep could not list clinics", { error: describeError(error) });
    return { ...out, status: "failed", note: "work list failed" };
  }

  const practices = new Map<string, { firstLiveAt: Date; locations: string[] }>();
  for (const w of work) {
    try {
      const r = await withTenant({ clinicId: w.clinicId, actor: ACTOR }, async (tx) => {
        const settled = await settlePending(tx.db, tx.clinicId, now);
        // The missed-contact record's 30 days, kept whatever any switch says.
        const purged = await purgeMissedContacts(tx, now);
        return { settled, purged, ...(await evaluateOutages(tx.db, tx.clinicId, now)) };
      });
      out.settled += r.settled;
      out.missedContactsDeleted += r.purged;
      out.outagesStarted += r.started;
      out.outagesEnded += r.ended;
      out.outagesEscalated += r.escalated;
      await runAfter(r.after);
    } catch (error) {
      failures += 1;
      log.error("answer notices sweep failed for a clinic", { clinicId: w.clinicId, error: describeError(error) });
    }
    if (w.practiceFirstLiveAt) {
      const p = practices.get(w.practiceId) ?? { firstLiveAt: w.practiceFirstLiveAt, locations: [] };
      p.locations.push(w.clinicId);
      practices.set(w.practiceId, p);
    }
  }

  for (const [practiceId, practice] of practices) {
    // A first month that ended more than the lookback ago has nothing left to tell.
    const monthEnd = new Date(practice.firstLiveAt.getTime() + (GUARANTEE_FIRST_MONTH_DAYS + 1) * DAY_MS);
    if (now.getTime() - monthEnd.getTime() > SWEEP_LOOKBACK_DAYS * DAY_MS) continue;
    try {
      const practiceRow = await withTenant({ clinicId: practiceId, actor: ACTOR }, async (tx) => {
        const [row] = await tx.db.select({ timeZone: clinics.timezone }).from(clinics).where(eq(clinics.id, tx.clinicId)).limit(1);
        return row ?? null;
      });
      if (!practiceRow?.timeZone) continue;
      const days = new Map<string, DayMisses>();
      for (const location of practice.locations) {
        await withTenant({ clinicId: location, actor: ACTOR }, (tx) =>
          firstMonthMisses(tx.db, tx.clinicId, { firstLiveAt: practice.firstLiveAt, timeZone: practiceRow.timeZone, now }, days),
        );
      }
      if (days.size === 0) continue;
      const r = await withTenant({ clinicId: practiceId, actor: ACTOR }, (tx) => openMissCases(tx.db, tx.clinicId, days, now));
      out.missCases += r.opened;
      // Each location's missed contacts of the day join their case, so the
      // owner's closing note reaches them (lib/channels/miss-cases.ts).
      for (const join of r.joins) {
        for (const [location, ids] of join.contacts) {
          await withTenant({ clinicId: location, actor: ACTOR }, (tx) =>
            tx.db
              .update(missedContacts)
              .set({ missCaseId: join.caseId })
              .where(and(eq(missedContacts.clinicId, tx.clinicId), inArray(missedContacts.id, ids), isNull(missedContacts.missCaseId))),
          );
        }
      }
      await runAfter(r.after);
    } catch (error) {
      failures += 1;
      log.error("guarantee miss cases failed for a practice", { clinicId: practiceId, error: describeError(error) });
    }
  }

  out.status = failures > 0 ? "failed" : "ok";
  out.note =
    `${work.length} clinics, ${out.settled} settled, ${out.missedContactsDeleted} missed contacts deleted, ${out.outagesStarted} outages opened, ` +
    `${out.outagesEnded} closed, ${out.outagesEscalated} escalated, ${out.missCases} miss cases` +
    (failures ? `, ${failures} failed` : "");
  return out;
}
