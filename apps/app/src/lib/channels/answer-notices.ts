import type { Channel } from "@healdesk/catalog";
import { and, asc, eq, gt, gte, inArray, isNotNull, lt, lte, sql } from "drizzle-orm";

import { unsafeDb, type Transaction } from "@/db";
import { billingNotices, clinicChannels, clinics, clinicSettings, routedInteractions } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { clinicLocalDate } from "@/lib/clinic/closures";
import type {
  GuaranteeMissPayload,
  OutageEndedPayload,
  OutageStartedPayload,
} from "@/lib/email/templates/registry";
import { describeError, log } from "@/lib/log";
import { enqueuePlanNotice } from "@/lib/notices/plan-notices";
import { publicOriginProblem, publicUrl } from "@/lib/public-url";
import { withTenant } from "@/lib/tenant";
import { usableLine } from "@/lib/voice/fallback-line";

import { OUTAGE_MISSED_REASONS } from "./routed-words";

/**
 * The routed/answered counter's minute sweep (Gate B): it settles what the
 * runtime left unsettled, and decides when the counter's three notices are
 * owed, queueing each through F0's outbox (billing_notices) under its dedupe
 * key, so a sweep that runs twice, or two that overlap, queue each once.
 *
 *   1. **Unsettled is missed.** A row still `pending` ROUTED_PENDING_GRACE_MS
 *      after it reached us belongs to a process that stopped before it said
 *      what happened: Terms §5 counts that as missed (`no_outcome`), "whatever
 *      the cause of that failure".
 *   2. **L17, "Calls are going to your direct line"** (plan, Annex X5: "Our
 *      system or a vendor has failed for 10 minutes"). An incident is the run
 *      of calls and conversations our side failed to answer (every miss but a
 *      late answer, OUTAGE_MISSED_REASONS) since the last one AYA answered. It
 *      is owed once that run has lasted OUTAGE_AFTER_MS: its first and latest
 *      failure at least ten minutes apart with nothing answered between, which
 *      is the evidence that the failure went on, not a single blip. Dedupe
 *      `outage_started:<the incident's first failure>`, so one per incident.
 *      With no traffic after a first failure there is no evidence, and nothing
 *      is sent: nothing is going to the direct line either.
 *   3. **L18, "AYA is answering again"**: an incident L17 told of has ended
 *      once a call or conversation routed after its start is answered. It
 *      gives how many calls and chats went unanswered meanwhile. Dedupe
 *      `outage_ended:<the same start>`, so it pairs with its L17 and goes once.
 *      An incident that ended before L17 was owed sends neither.
 *   4. **L21, "We missed a {call or message}"** (Terms §5: "If our own records
 *      show a miss, we tell the account owner by email within 7 days of
 *      recording it"). A miss counts when it falls in the practice's first
 *      month (its first channel's go-live day and the 29 after it, in the
 *      practice's own calendar, firstMonthOf) on a channel that
 *      was live when it reached us ("A channel that goes live later is covered
 *      from the day it goes live"). One notice per practice-local day with a
 *      miss, queued on the practice's billing clinic (the account owner, as
 *      L30 goes) once that day has ended and MISS_NOTICE_SETTLE_MS more have
 *      passed, so its count includes the misses step 1 settles: within a day
 *      of the miss, inside the seven. Dedupe `guarantee_miss:<missedOn>`.
 *
 * The notices carry counts, dates, channel ids, the clinic's own direct line
 * and its Home link (registry.ts, the payloads), never a caller, their
 * number, a time of a call or any words. Their templates are owed (the
 * registry's PENDING_TEMPLATES): until they ship the sender holds the rows,
 * and the outbox's own switch governs sending as for every notice.
 *
 * Unswitched, like the redial sweep: the notices are a promise the Terms
 * make (the miss notice's seven days), and settling a pending row is a pure
 * function of the clock. What reaches a clinic is still gated by the outbox.
 */

const ACTOR: ActorContext = { type: "service", serviceName: "answer-notices" };

/** A row still pending this long after it reached us is missed (`no_outcome`). */
export const ROUTED_PENDING_GRACE_MS = 10 * 60_000;
/** Annex X5's L17: our side has failed to answer for ten minutes. */
export const OUTAGE_AFTER_MS = 10 * 60_000;
/** The guarantee's first month: 30 days from the practice's first go-live (Terms §5). */
export const GUARANTEE_FIRST_MONTH_DAYS = 30;
/** A claim may be made within 30 days after the first month ends (Terms §5). */
export const GUARANTEE_CLAIM_DAYS = 30;
/** Terms §5: the miss is told within 7 days of recording it. */
export const GUARANTEE_MISS_NOTICE_DAYS = 7;
/** After a day ends, how long the sweep waits before counting its misses: past the pending grace. */
export const MISS_NOTICE_SETTLE_MS = 15 * 60_000;
/** How far back the sweep looks for rows and notices: past the seven days, with a day to spare. */
export const SWEEP_LOOKBACK_DAYS = GUARANTEE_MISS_NOTICE_DAYS + 1;

const DAY_MS = 86_400_000;

export type AnswerNoticesOutcome = {
  status: "ok" | "failed";
  note: string;
  settled: number;
  outagesStarted: number;
  outagesEnded: number;
  missNotices: number;
};

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
    .returning({ id: routedInteractions.id });
  return rows.length;
}

const isOutageMiss = sql`${routedInteractions.outcome} = 'missed' and ${routedInteractions.reason} in (${sql.join(
  OUTAGE_MISSED_REASONS.map((r) => sql`${r}`),
  sql`, `,
)})`;
/**
 * AYA answered it, if late: an answer ends an incident. Not a conversation
 * answered once and then failed (a miss with a first answer kept), which is
 * part of the outage.
 */
const isAnswer = sql`(${routedInteractions.outcome} = 'answered' or (${routedInteractions.outcome} = 'missed' and ${routedInteractions.reason} = 'late'))`;

type ClinicLinks = { homeUrl: string; directLineE164: string | null };

async function clinicLinks(db: Transaction, clinicId: string): Promise<ClinicLinks | null> {
  const [row] = await db
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
  if (!row) return null;
  return {
    homeUrl: publicUrl(`/c/${row.slug}`),
    directLineE164: usableLine(row.directLine, [row.published, row.assistant]),
  };
}

function channelsOf(rows: readonly { channel: string }[]): Channel[] {
  const order: Channel[] = ["voice", "web", "meta"];
  const seen = new Set(rows.map((r) => r.channel));
  return order.filter((c) => seen.has(c));
}

/**
 * Steps 2 and 3 for one clinic, in its own tenant: L17 for the incident
 * still open once it has lasted ten minutes, L18 for each incident L17 told
 * of that has since ended. Returns what it queued.
 */
export async function evaluateOutages(
  db: Transaction,
  clinicId: string,
  now: Date,
): Promise<{ started: number; ended: number }> {
  let started = 0;
  let ended = 0;
  // A clinic with no channel live answers no patient: its misses are setup, not an outage.
  const [live] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(clinicChannels)
    .where(and(eq(clinicChannels.clinicId, clinicId), isNotNull(clinicChannels.liveAt)));
  if (!live || Number(live.n) === 0) return { started, ended };

  let links: ClinicLinks | null | undefined;
  const linksOnce = async () => (links === undefined ? (links = await clinicLinks(db, clinicId)) : links);

  // The open incident: every failure since the last answer.
  const [last] = await db
    .select({ at: sql<Date | string | null>`max(${routedInteractions.routedAt})` })
    .from(routedInteractions)
    .where(and(eq(routedInteractions.clinicId, clinicId), isAnswer));
  const lastAnswer = last?.at ? new Date(last.at) : null;
  const open = await db
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
  if (open.length > 0) {
    const first = open[0]!.routedAt;
    const latest = open[open.length - 1]!.routedAt;
    if (latest.getTime() - first.getTime() >= OUTAGE_AFTER_MS) {
      const l = await linksOnce();
      if (l) {
        const payload: OutageStartedPayload = {
          startedAt: first.toISOString(),
          channels: channelsOf(open),
          directLineE164: l.directLineE164,
          homeUrl: l.homeUrl,
        };
        if (await enqueuePlanNotice(db, clinicId, "outage_started", `outage_started:${payload.startedAt}`, payload)) {
          started += 1;
        }
      }
    }
  }

  // The incidents L17 told of, in the lookback, whose L18 has not been queued.
  const since = new Date(now.getTime() - SWEEP_LOOKBACK_DAYS * DAY_MS);
  const told = await db
    .select({ kind: billingNotices.kind, dedupeKey: billingNotices.dedupeKey })
    .from(billingNotices)
    .where(
      and(
        eq(billingNotices.clinicId, clinicId),
        inArray(billingNotices.kind, ["outage_started", "outage_ended"]),
        gte(billingNotices.createdAt, since),
      ),
    );
  const endedKeys = new Set(
    told.filter((t) => t.kind === "outage_ended").map((t) => t.dedupeKey.slice("outage_ended:".length)),
  );
  for (const notice of told) {
    if (notice.kind !== "outage_started") continue;
    const startedAt = notice.dedupeKey.slice("outage_started:".length);
    if (endedKeys.has(startedAt)) continue;
    const start = new Date(startedAt);
    if (Number.isNaN(start.getTime())) continue;
    const [answer] = await db
      .select({ routedAt: routedInteractions.routedAt, answeredAt: routedInteractions.answeredAt })
      .from(routedInteractions)
      .where(and(eq(routedInteractions.clinicId, clinicId), isAnswer, gt(routedInteractions.routedAt, start)))
      .orderBy(asc(routedInteractions.routedAt))
      .limit(1);
    if (!answer) continue;
    const missed = await db
      .select({ channel: routedInteractions.channel })
      .from(routedInteractions)
      .where(
        and(
          eq(routedInteractions.clinicId, clinicId),
          isOutageMiss,
          gte(routedInteractions.routedAt, start),
          lt(routedInteractions.routedAt, answer.routedAt),
        ),
      );
    const l = await linksOnce();
    if (!l) continue;
    const payload: OutageEndedPayload = {
      startedAt,
      endedAt: (answer.answeredAt ?? answer.routedAt).toISOString(),
      callCount: missed.filter((m) => m.channel === "voice").length,
      chatCount: missed.filter((m) => m.channel !== "voice").length,
      channels: channelsOf(missed),
      homeUrl: l.homeUrl,
    };
    if (await enqueuePlanNotice(db, clinicId, "outage_ended", `outage_ended:${startedAt}`, payload)) ended += 1;
  }
  return { started, ended };
}

type DayMisses = { channels: Set<Channel>; calls: number; messages: number };

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
  const rows = await db
    .select({ channel: routedInteractions.channel, routedAt: routedInteractions.routedAt })
    .from(routedInteractions)
    .innerJoin(
      clinicChannels,
      and(eq(clinicChannels.clinicId, routedInteractions.clinicId), eq(clinicChannels.channel, routedInteractions.channel)),
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
    const entry = into.get(day) ?? { channels: new Set<Channel>(), calls: 0, messages: 0 };
    entry.channels.add(row.channel as Channel);
    if (row.channel === "voice") entry.calls += 1;
    else entry.messages += 1;
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

/** The run: settle, then each clinic's outages, then each practice's first-month misses. Never throws. */
export async function runAnswerNoticesSweep(now: Date = new Date()): Promise<AnswerNoticesOutcome> {
  const out: AnswerNoticesOutcome = {
    status: "ok",
    note: "",
    settled: 0,
    outagesStarted: 0,
    outagesEnded: 0,
    missNotices: 0,
  };
  let failures = 0;
  if (publicOriginProblem()) {
    // The notices carry the clinic's Home link: settle only, and say why.
    log.error("answer notices not queued: no public origin", { job: "answer-notices" });
  }
  const queueing = !publicOriginProblem();
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
        const outages = queueing ? await evaluateOutages(tx.db, tx.clinicId, now) : { started: 0, ended: 0 };
        return { settled, ...outages };
      });
      out.settled += r.settled;
      out.outagesStarted += r.started;
      out.outagesEnded += r.ended;
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

  if (queueing) {
    for (const [practiceId, practice] of practices) {
      // A first month that ended more than the lookback ago has nothing left to tell.
      const monthEnd = new Date(practice.firstLiveAt.getTime() + (GUARANTEE_FIRST_MONTH_DAYS + 1) * DAY_MS);
      if (now.getTime() - monthEnd.getTime() > SWEEP_LOOKBACK_DAYS * DAY_MS) continue;
      try {
        const practiceRow = await withTenant({ clinicId: practiceId, actor: ACTOR }, async (tx) => {
          const [row] = await tx.db
            .select({ timeZone: clinics.timezone })
            .from(clinics)
            .where(eq(clinics.id, tx.clinicId))
            .limit(1);
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
        // The first month's last day, and the claim window's, in the practice's own calendar.
        const { endsOn: firstMonthEndsOn, claimByOn } = firstMonthOf(practice.firstLiveAt, practiceRow.timeZone);
        const queued = await withTenant({ clinicId: practiceId, actor: ACTOR }, async (tx) => {
          const l = await clinicLinks(tx.db, tx.clinicId);
          if (!l) return 0;
          let n = 0;
          for (const [missedOn, day] of [...days.entries()].sort(([a], [b]) => a.localeCompare(b))) {
            const payload: GuaranteeMissPayload = {
              missedOn,
              channels: (["voice", "web", "meta"] as Channel[]).filter((c) => day.channels.has(c)),
              callCount: day.calls,
              messageCount: day.messages,
              firstMonthEndsOn,
              claimByOn,
              homeUrl: l.homeUrl,
            };
            if (await enqueuePlanNotice(tx.db, tx.clinicId, "guarantee_miss", `guarantee_miss:${missedOn}`, payload)) n += 1;
          }
          return n;
        });
        out.missNotices += queued;
      } catch (error) {
        failures += 1;
        log.error("guarantee miss notices failed for a practice", { clinicId: practiceId, error: describeError(error) });
      }
    }
  }

  out.status = failures > 0 ? "failed" : "ok";
  out.note =
    `${work.length} clinics, ${out.settled} settled, ${out.outagesStarted} outages started, ` +
    `${out.outagesEnded} ended, ${out.missNotices} miss notices${failures ? `, ${failures} failed` : ""}`;
  return out;
}
