import { and, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { supportCases, supportMessages, type SupportCase } from "@/db/schema";
import { describeError, log } from "@/lib/log";
import { notifyOpsOnce } from "@/lib/ops/notify";
import { replyByPassed } from "@/lib/reply-by";

import { closeSupportCase } from "./cases";
import { canMove, NEEDS_US_STATES, printRef, type SupportCaseState } from "./case-vocab";
import { currentReplyDraft } from "./send";
import { proposeAfterDraft } from "./wire";

/**
 * The support cases' clocks (ops automation Phase 7, lane P7e; design E5
 * §2.3 "support-watch" and S7, S9), run by the ops watch (lib/ops/watch.ts),
 * which is seeded on because it only alerts and moves cases nobody is
 * waiting on. It sends nothing to a clinic, ever.
 *
 *   - `support_case_past_due`: a case that still needs us (new, drafting,
 *     drafted, needs_edit) whose reply-by day has passed in New York with no
 *     reply sent. ONE alert per case, ever (notifyOpsOnce on the case's id).
 *     Hourly.
 *   - `support_case_now`: a case of urgency `now` that still needs us, ONE
 *     alert per case, ever, which the ops Slack sweep posts (lib/ops/slack.ts)
 *     and the ops address receives. Every minute, so "now" means now.
 *   - a snooze that has run out puts the case back where its draft says:
 *     `drafted` when its current, unapproved draft passed its checks (and the
 *     draft is proposed again, idempotently, in case its item expired while it
 *     slept), `needs_edit` when that draft failed or a reply had already gone,
 *     `new` when nothing was ever drafted, so the drafter takes it. Hourly.
 *   - a case waiting on the clinic for 14 days since our last reply closes,
 *     `no_further_reply`, silently: nothing is sent to anyone. Hourly.
 *
 * ## One alert per promise
 *
 * Every chat escalation since lane P7a is a case AND has its L25
 * acknowledgement in the outbox (`support_request`), which the old watch
 * (`support_reply_past_due`, lib/ops/support-replies.ts) chases until an
 * operator presses Mark replied. They are the same promise. The case is the
 * one that knows whether we replied (a reply sent moves it to
 * waiting_clinic), so it carries the alert: the old watch and the digest's
 * old count leave out every request whose id is on a case
 * (`requestIdsOnCases`), and keep working, Mark replied included, for the
 * requests that have none (before lane P7a, or a case that failed to
 * record).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** A case waiting on the clinic this long after our last reply is closed, silently. */
export const WAITING_CLINIC_CLOSE_DAYS = 14;
/** How far back the `now` alert looks: older cases have had their hourly past-due alert. */
const NOW_LOOKBACK_DAYS = 7;
/** Cases per run the watch reads, at most, for each rule. */
const BATCH = 500;

type CaseKey = Pick<SupportCase, "id" | "ref" | "subjectClinicId" | "replyByOn">;

function alertFields(c: CaseKey) {
  return {
    fields: { clinicId: c.subjectClinicId ?? null, requestId: c.id },
    display: { promisedOn: c.replyByOn, supportRef: printRef(c.ref) },
  };
}

/** The request ids of these chat escalations that are recorded on a case: the case carries their alert. */
export async function requestIdsOnCases(requestIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(requestIds)].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (ids.length === 0) return new Set();
  const rows = await unsafeDb
    .select({ requestId: supportMessages.requestId })
    .from(supportMessages)
    .where(and(eq(supportMessages.kind, "chat_escalation"), inArray(supportMessages.requestId, ids)));
  return new Set(rows.map((r) => r.requestId).filter((id): id is string => id !== null));
}

/** Every case that still needs us and is past its reply-by day, told to ops once each. */
export async function alertPastDueCases(now: Date): Promise<number> {
  const open = await unsafeDb
    .select({ id: supportCases.id, ref: supportCases.ref, subjectClinicId: supportCases.subjectClinicId, replyByOn: supportCases.replyByOn })
    .from(supportCases)
    // New York's day is never ahead of UTC's: a day not before UTC's today cannot have passed there.
    .where(and(inArray(supportCases.state, [...NEEDS_US_STATES]), sql`${supportCases.replyByOn} < ${now.toISOString().slice(0, 10)}::date`))
    .orderBy(supportCases.replyByOn)
    .limit(BATCH);
  let raised = 0;
  for (const c of open) {
    if (!replyByPassed(c.replyByOn, now)) continue;
    const { fields, display } = alertFields(c);
    await notifyOpsOnce("support_case_past_due", fields, display);
    raised += 1;
  }
  return raised;
}

/** Every recent case of urgency `now` that still needs us, told to ops (and so to Slack) once each. */
export async function alertNowCases(now: Date): Promise<number> {
  const urgent = await unsafeDb
    .select({ id: supportCases.id, ref: supportCases.ref, subjectClinicId: supportCases.subjectClinicId, replyByOn: supportCases.replyByOn })
    .from(supportCases)
    .where(
      and(
        eq(supportCases.urgency, "now"),
        inArray(supportCases.state, [...NEEDS_US_STATES]),
        gte(supportCases.lastInboundAt, new Date(now.getTime() - NOW_LOOKBACK_DAYS * DAY_MS)),
      ),
    )
    .limit(BATCH);
  for (const c of urgent) {
    const { fields, display } = alertFields(c);
    await notifyOpsOnce("support_case_now", fields, display);
  }
  return urgent.length;
}

/** Where a case whose snooze ran out goes back to, from its drafts. */
export async function stateAfterSnooze(c: Pick<SupportCase, "id" | "lastOutboundAt">): Promise<SupportCaseState> {
  const current = await currentReplyDraft(c.id);
  if (current && current.approvedAt === null) {
    return (current.checksJson as { ok?: unknown } | null)?.ok === true ? "drafted" : "needs_edit";
  }
  if (current || c.lastOutboundAt) return "needs_edit";
  const [anyRun] = await unsafeDb
    .select({ id: supportMessages.id })
    .from(supportMessages)
    .where(and(eq(supportMessages.caseId, c.id), eq(supportMessages.kind, "reply")))
    .limit(1);
  return anyRun ? "needs_edit" : "new";
}

/** Every snooze that has run out, ended. Returns how many cases came back. */
export async function endSnoozes(now: Date): Promise<number> {
  const due = await unsafeDb
    .select({ id: supportCases.id, lastOutboundAt: supportCases.lastOutboundAt })
    .from(supportCases)
    .where(and(eq(supportCases.state, "snoozed"), isNotNull(supportCases.snoozedUntil), lte(supportCases.snoozedUntil, now)))
    .limit(BATCH);
  let woke = 0;
  for (const c of due) {
    const to = await stateAfterSnooze(c);
    if (!canMove("snoozed", to)) continue;
    // Compare-and-set: an operator who snoozed it again, or closed it, meanwhile wins.
    const moved = await unsafeDb
      .update(supportCases)
      .set({ state: to, snoozedUntil: null, updatedAt: now })
      .where(and(eq(supportCases.id, c.id), eq(supportCases.state, "snoozed"), lte(supportCases.snoozedUntil, now)))
      .returning({ id: supportCases.id });
    if (moved.length === 0) continue;
    woke += 1;
    if (to === "drafted") await proposeAfterDraft(c.id, now);
  }
  return woke;
}

/** Every case waiting on the clinic for 14 days since our last reply, closed without a word to anyone. */
export async function closeQuietCases(now: Date): Promise<number> {
  const before = new Date(now.getTime() - WAITING_CLINIC_CLOSE_DAYS * DAY_MS);
  const quiet = await unsafeDb
    .select({ id: supportCases.id })
    .from(supportCases)
    .where(
      and(
        eq(supportCases.state, "waiting_clinic"),
        sql`coalesce(${supportCases.lastOutboundAt}, ${supportCases.updatedAt}) <= ${before}`,
      ),
    )
    .limit(BATCH);
  let closed = 0;
  for (const c of quiet) {
    if ((await closeSupportCase(c.id, "no_further_reply", now)).outcome === "done") closed += 1;
  }
  return closed;
}

export type SupportCaseWatch = { pastDue: number; now: number; woke: number; closed: number; failures: number };

/** The hourly run: snoozes first, so a case back in needs-us this hour is judged this hour. Never throws. */
export async function watchSupportCases(now: Date): Promise<SupportCaseWatch> {
  const out: SupportCaseWatch = { pastDue: 0, now: 0, woke: 0, closed: 0, failures: 0 };
  const step = async (name: string, run: () => Promise<number>, into: "pastDue" | "now" | "woke" | "closed") => {
    try {
      out[into] = await run();
    } catch (error) {
      out.failures += 1;
      log.error("support case watch step failed", { op: name, error: describeError(error) });
    }
  };
  await step("snoozes", () => endSnoozes(now), "woke");
  await step("quiet", () => closeQuietCases(now), "closed");
  await step("past_due", () => alertPastDueCases(now), "pastDue");
  await step("now", () => alertNowCases(now), "now");
  return out;
}

/** The morning digest's support line: N need you, M of them past their day, K waiting on a clinic. */
export async function supportCaseCounts(now: Date): Promise<{ needYou: number; pastDue: number; waitingClinic: number }> {
  const rows = await unsafeDb
    .select({ state: supportCases.state, replyByOn: supportCases.replyByOn })
    .from(supportCases)
    .where(inArray(supportCases.state, [...NEEDS_US_STATES, "waiting_clinic"]));
  let needYou = 0;
  let pastDue = 0;
  let waitingClinic = 0;
  for (const r of rows) {
    if (r.state === "waiting_clinic") waitingClinic += 1;
    else {
      needYou += 1;
      if (replyByPassed(r.replyByOn, now)) pastDue += 1;
    }
  }
  return { needYou, pastDue, waitingClinic };
}
