import { and, desc, eq, isNotNull, sql } from "drizzle-orm";

import { auditReviewQueue, billingNotices, clinicChannels, clinics, type LifecycleStage } from "@/db/schema";
import type { ActorContext, RequestContext } from "@/lib/audit";
import { agreementInEffect } from "@/lib/agreements/in-effect";
import { chaseBlocked, resignFactsIn } from "@/lib/agreements/open-resigns";
import { openResign } from "@/lib/agreements/resign";
import { setupLastDay } from "@/lib/clinic/setup-window";
import type { Recommendation } from "@/lib/lifecycle/recommend";
import { readLifecycleViews } from "@/lib/ops/lifecycle-ops";
import { SETUP_REMINDER_COUNT } from "@/lib/setup/reminders";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { extendedLastDay, renderContactDraft } from "./contact-drafts";
import {
  EDITABLE,
  fieldsOf,
  isDraftKind,
  parseContactPayload,
  type ContactPayloads,
  type EditableField,
} from "./contact-payloads";
import { reminderPlanIn, type ReminderBlock } from "./contact-reminders";
import { parseDraft, type Draft } from "./drafts";
import type { ContactKind } from "./kinds";

/**
 * The clinic-contact kinds' packets (ops automation lane P6f): the facts the
 * owner decides on, read live, as ids, versions, dates, counts, closed words
 * and our own fixed sentences; the draft as the clinic would read it; the
 * fields he may change, and their current values. Never a person's name,
 * never a link, never anything a clinic or a patient typed.
 *
 * For the setup notices the lifecycle watch's own recommendation
 * (lib/lifecycle/recommend.ts, through lib/ops/lifecycle-ops.ts
 * readLifecycleViews) is carried beside the draft, as computed there, never
 * recomputed here.
 */

export type ChaseFacts = {
  kind: "baa_resign_chase";
  resignId: string;
  fromVersion: string | null;
  toVersion: string;
  startedAt: string;
  daysOpen: number;
  lastL22SentAt: string | null;
  linkExpiresAt: string | null;
  lastChaseAt: string | null;
  belowFloor: boolean;
  fromVersionAcceptable: boolean;
  isAnswering: boolean;
  /** Why a chase cannot go now, or null when it can (open-resigns.ts chaseBlocked). */
  blocked: "not_baa_version" | "switched_off" | "too_early" | "chased_recently" | null;
  /** Below the floor: phone the practice as well, on its published number. */
  callFirst: boolean;
  publishedPhoneE164: string | null;
};

export type QuestionFacts = {
  kind: "agreement_question";
  reviewId: string;
  reviewStatus: "open" | "passed" | "failed" | "superseded" | null;
  /** The review's internal day, never quoted to the clinic. */
  reviewDueOn: string | null;
  agreementKind: "dpa" | "baa" | null;
  agreementVersion: string | null;
  signedAt: string | null;
  /** The covered-entity answer given at checkout: false is "No". */
  coveredAnswer: "yes" | "no" | "unknown";
  /** What the website says about insurance, as last read. */
  siteAcceptsInsurance: "yes" | "no" | "unknown";
  /** Earlier agreement-kind reviews of this clinic, decided. */
  earlierDecisions: number;
  openResign: boolean;
  /** Where AYA pauses until the BAA is signed if the answer is Yes or Not sure: every location. */
  locationsToPause: number;
  /** Whether AYA answers on any channel yet: a practice not yet live has nothing to pause. */
  isAnswering: boolean;
};

export type SetupNoticeFacts = {
  kind: "setup_extended" | "setup_waiting_on_us" | "setup_help_offer";
  stage: LifecycleStage | null;
  stageSince: string | null;
  /** Days left in the setup window, or null when it no longer closes the account. */
  remainingDays: number | null;
  /** The window's last day now. */
  lastDay: string | null;
  /** For an extension: the last day once approved. */
  newLastDay: string | null;
  stepsLeft: number | null;
  /** For the once-only notices: one has already gone for this stage entry. */
  alreadySent: boolean;
  /**
   * For the waiting-on-us note and the call offer: the clinic is no longer in
   * the stage entry the item was proposed for (the stage moved, we finished
   * the step, or a channel went live since), so approving sends nothing.
   */
  stageMoved: boolean;
  recommendation: Recommendation | null;
};

export type ReminderNowFacts = {
  kind: "setup_reminder_now";
  reminderNumber: number;
  ofTotal: number;
  normallyDueOn: string;
  sentSoFar: number | null;
  /** Why it would send nothing now, or null when it would send. */
  blocked: ReminderBlock | "already_queued" | null;
  recommendation: Recommendation | null;
};

export type ContactFacts = ChaseFacts | QuestionFacts | SetupNoticeFacts | ReminderNowFacts;

export type ContactPacketExtra = {
  /** The email as the clinic would read it, the chase's link shown as a placeholder; null for the reminder (its wording is fixed). */
  draft: { subject: string; body: string } | null;
  /** What the owner may change, as the screen offers it; empty for the reminder. */
  editable: readonly EditableField[];
  /** The fields' current values. */
  fields: Readonly<Record<string, unknown>> | null;
};

type Ctx = { actor: ActorContext; request?: RequestContext };

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/** How many locations an organisation's agreement covers, this clinic included. */
export async function locationCount(tx: TenantTx): Promise<number> {
  const rows = await tx.db.execute<{ clinic_id: string }>(
    sql`select clinic_id from app_organisation_clinics(${tx.clinicId}::uuid)`,
  );
  const ids = new Set(rows.rows.map((r) => r.clinic_id));
  ids.add(tx.clinicId);
  return ids.size;
}

async function lifecycleOf(clinicId: string, ctx: Ctx, now: Date) {
  const { views } = await readLifecycleViews({ actor: ctx.actor, request: ctx.request, now, clinicId, partial: true });
  return views[0] ?? null;
}

/** Whether a once-only notice has already been queued for its dedupe key. */
async function noticeQueued(tx: TenantTx, kind: "setup_waiting_on_us" | "setup_help_offer", dedupeKey: string) {
  const [row] = await tx.db
    .select({ id: billingNotices.id })
    .from(billingNotices)
    .where(and(eq(billingNotices.clinicId, tx.clinicId), eq(billingNotices.kind, kind), eq(billingNotices.dedupeKey, dedupeKey)))
    .limit(1);
  return row !== undefined;
}

/**
 * Whether a setup notice's stage entry has passed since it was proposed: the
 * lifecycle row's stage or its stage_since differs from the proposal's, or a
 * channel went live after it. The waiting-on-us note must be about the wait
 * the clinic is in now, and the call offer is once per stage entry.
 */
export async function noticeStageMoved(
  kind: "setup_waiting_on_us" | "setup_help_offer",
  p: ContactPayloads["setup_waiting_on_us"] | ContactPayloads["setup_help_offer"],
  ctx: Ctx,
  now: Date,
): Promise<boolean> {
  const seen = await lifecycleOf(p.clinicId, ctx, now);
  if (!seen) return true;
  const stage = kind === "setup_waiting_on_us" ? "waiting_on_us" : (p as ContactPayloads["setup_help_offer"]).stage;
  if (seen.view.stage !== stage || seen.view.stageSince.toISOString() !== p.stageSince) return true;
  const since = new Date(p.stageSince);
  const liveSince = await withTenant({ clinicId: p.clinicId, actor: ctx.actor, request: ctx.request }, (tx) =>
    tx.db
      .select({ channel: clinicChannels.channel })
      .from(clinicChannels)
      .where(and(eq(clinicChannels.clinicId, tx.clinicId), sql`${clinicChannels.liveAt} > ${since}`))
      .limit(1),
  );
  return liveSince.length > 0;
}

/** The outbox key a once-only setup notice is queued under (lib/notices/plan-notices.ts). */
export function noticeDedupeKey(
  kind: "setup_waiting_on_us" | "setup_help_offer",
  p: { stage?: string; stageSince: string },
): string {
  return kind === "setup_waiting_on_us" ? `setup_waiting_on_us:${p.stageSince}` : `setup_help_offer:${p.stage}:${p.stageSince}`;
}

/** The facts of one contact item, read now; null when its payload cannot be read. */
export async function contactFacts(kind: ContactKind, rawPayload: unknown, ctx: Ctx, now: Date): Promise<ContactFacts | null> {
  switch (kind) {
    case "baa_resign_chase": {
      const p = parseContactPayload(kind, rawPayload);
      if (!p) return null;
      return withTenant({ clinicId: p.clinicId, actor: ctx.actor, request: ctx.request }, async (tx) => {
        const facts = await resignFactsIn(tx, p.resignId, now);
        const [clinic] = await tx.db
          .select({ phone: clinics.publishedPhoneE164 })
          .from(clinics)
          .where(eq(clinics.id, tx.clinicId))
          .limit(1);
        return {
          kind,
          resignId: p.resignId,
          fromVersion: facts?.fromVersion ?? p.fromVersion,
          toVersion: facts?.toVersion ?? p.toVersion,
          startedAt: iso(facts?.startedAt) ?? "",
          daysOpen: facts?.daysOpen ?? 0,
          lastL22SentAt: iso(facts?.lastL22SentAt),
          linkExpiresAt: iso(facts?.linkExpiresAt),
          lastChaseAt: iso(facts?.lastChaseAt),
          belowFloor: facts?.belowFloor ?? false,
          fromVersionAcceptable: facts?.fromVersionAcceptable ?? false,
          isAnswering: facts?.isAnswering ?? p.isAnswering,
          blocked: facts ? chaseBlocked(facts, now) : "not_baa_version",
          callFirst: facts?.belowFloor === true,
          publishedPhoneE164: facts?.belowFloor === true ? (clinic?.phone ?? null) : null,
        } satisfies ChaseFacts;
      });
    }
    case "agreement_question": {
      const p = parseContactPayload(kind, rawPayload);
      if (!p) return null;
      return withTenant({ clinicId: p.clinicId, actor: ctx.actor, request: ctx.request }, async (tx) => {
        const [review] = await tx.db
          .select({ status: auditReviewQueue.status, dueOn: auditReviewQueue.dueOn })
          .from(auditReviewQueue)
          .where(and(eq(auditReviewQueue.id, p.reviewId), eq(auditReviewQueue.clinicId, tx.clinicId)))
          .limit(1);
        const decided = await tx.db
          .select({ id: auditReviewQueue.id })
          .from(auditReviewQueue)
          .where(
            and(
              eq(auditReviewQueue.clinicId, tx.clinicId),
              eq(auditReviewQueue.kind, "agreement_kind"),
              sql`${auditReviewQueue.status} in ('passed', 'failed')`,
            ),
          )
          .orderBy(desc(auditReviewQueue.createdAt));
        const [clinic] = await tx.db
          .select({
            isCoveredEntity: clinics.isCoveredEntity,
            siteProfile: clinics.siteProfile,
          })
          .from(clinics)
          .where(eq(clinics.id, tx.clinicId))
          .limit(1);
        const agreement = await agreementInEffect(tx);
        const accepts = clinic?.siteProfile?.acceptsInsurance;
        return {
          kind,
          reviewId: p.reviewId,
          reviewStatus: (review?.status as QuestionFacts["reviewStatus"]) ?? null,
          reviewDueOn: review?.dueOn ?? null,
          agreementKind: agreement?.agreementKind ?? null,
          agreementVersion: agreement?.documentVersion ?? null,
          signedAt: iso(agreement?.acceptedAt),
          coveredAnswer: clinic?.isCoveredEntity === false ? "no" : clinic?.isCoveredEntity === true ? "yes" : "unknown",
          siteAcceptsInsurance: accepts === "yes" || accepts === "no" ? accepts : "unknown",
          earlierDecisions: decided.length,
          openResign: (await openResign(tx)) !== null,
          locationsToPause: await locationCount(tx),
          isAnswering:
            (
              await tx.db
                .select({ channel: clinicChannels.channel })
                .from(clinicChannels)
                .where(and(eq(clinicChannels.clinicId, tx.clinicId), eq(clinicChannels.enabled, true), isNotNull(clinicChannels.liveAt)))
                .limit(1)
            ).length > 0,
        } satisfies QuestionFacts;
      });
    }
    case "setup_extended":
    case "setup_waiting_on_us":
    case "setup_help_offer": {
      const p = parseContactPayload(kind, rawPayload);
      if (!p) return null;
      const seen = await lifecycleOf(p.clinicId, ctx, now);
      let alreadySent = false;
      if (kind !== "setup_extended") {
        const n = p as ContactPayloads["setup_waiting_on_us"] | ContactPayloads["setup_help_offer"];
        alreadySent = await withTenant({ clinicId: p.clinicId, actor: ctx.actor, request: ctx.request }, (tx) =>
          noticeQueued(tx, kind, noticeDedupeKey(kind, n)),
        );
      }
      const tz = p.timeZone;
      const stageMoved =
        kind === "setup_extended"
          ? false
          : await noticeStageMoved(kind, p as ContactPayloads["setup_waiting_on_us"] | ContactPayloads["setup_help_offer"], ctx, now);
      return {
        kind,
        stage: seen?.view.stage ?? null,
        stageSince: iso(seen?.view.stageSince),
        remainingDays: seen?.view.remainingDays ?? null,
        lastDay: seen?.view.deadlineAt ? setupLastDay(seen.view.deadlineAt, tz) : null,
        newLastDay: kind === "setup_extended" ? extendedLastDay(p as ContactPayloads["setup_extended"]) : null,
        stepsLeft: seen?.view.stepsLeft ?? null,
        alreadySent,
        stageMoved,
        recommendation: seen ? { ...seen.view.recommendation } : null,
      } satisfies SetupNoticeFacts;
    }
    case "setup_reminder_now": {
      const p = parseContactPayload(kind, rawPayload);
      if (!p) return null;
      const seen = await lifecycleOf(p.clinicId, ctx, now);
      const plan = await withTenant({ clinicId: p.clinicId, actor: ctx.actor, request: ctx.request }, (tx) =>
        reminderPlanIn(tx, now),
      );
      return {
        kind,
        reminderNumber: p.reminderNumber,
        ofTotal: SETUP_REMINDER_COUNT,
        normallyDueOn: p.normallyDueOn,
        sentSoFar: plan.ok ? plan.sentSoFar : null,
        blocked: plan.ok ? (plan.reminderNumber === p.reminderNumber ? null : "already_queued") : plan.reason,
        recommendation: seen ? { ...seen.view.recommendation } : null,
      } satisfies ReminderNowFacts;
    }
  }
}

/** Whether the item would still do something if approved now. */
export function contactStillNeeded(facts: ContactFacts): boolean {
  switch (facts.kind) {
    case "baa_resign_chase":
      return facts.blocked === null;
    case "agreement_question":
      return facts.reviewStatus === "open" && !facts.openResign;
    case "setup_extended":
      return facts.stage === "not_started" || facts.stage === "in_setup" || facts.stage === "waiting_on_us";
    case "setup_waiting_on_us":
    case "setup_help_offer":
      return !facts.alreadySent && !facts.stageMoved && facts.stage !== "live" && facts.stage !== "closed";
    case "setup_reminder_now":
      return facts.blocked === null;
  }
}

/** What approving does, in plain words: one fixed sentence per kind, with its numbers. */
export function contactEffect(facts: ContactFacts): string {
  switch (facts.kind) {
    case "baa_resign_chase":
      return (
        `Emails the clinic a fresh link to sign version ${facts.toVersion} of the business associate agreement, made when it is sent. It names no pause, suspension or date: AYA keeps answering under version ${facts.fromVersion ?? "in force"} until it is signed.` +
        (facts.callFirst ? " The version in force is below the one go-live accepts: phone the practice as well." : "")
      );
    case "agreement_question":
      return `Emails the clinic the question: does it send insurance claims or eligibility checks electronically? Nothing changes until you record the answer you hear. If the answer is Yes or Not sure, the business associate agreement goes to sign and ${
        facts.isAnswering
          ? `AYA pauses at ${facts.locationsToPause === 1 ? "its 1 location" : `all ${facts.locationsToPause} of its locations`} until it is signed`
          : `AYA, not answering anywhere yet, starts only once it is signed (${facts.locationsToPause === 1 ? "1 location" : `${facts.locationsToPause} locations`})`
      }. If it is No, nothing changes.`;
    case "setup_extended":
      return `Extends the setup deadline${facts.newLastDay ? ` to the end of ${facts.newLastDay}` : ""}, then emails the clinic that it has more time. The email goes only if the extension went through.`;
    case "setup_waiting_on_us":
      return "Emails the clinic that it has done its part and the next step is ours. It extends nothing: days waiting on us never move the deadline by themselves.";
    case "setup_help_offer":
      return "Emails the clinic an offer of a five-minute call to finish the step together. Sent once per stage.";
    case "setup_reminder_now":
      return `Sends setup reminder ${facts.reminderNumber} of ${facts.ofTotal} now instead of on ${facts.normallyDueOn}, with its usual wording. It adds no reminder: that one is not sent again on its day.`;
  }
}

/** The draft, the fields and what may change, for a contact item. */
export function contactExtra(kind: ContactKind, rawPayload: unknown, storedDraft: string | null): ContactPacketExtra {
  if (!isDraftKind(kind)) return { draft: null, editable: [], fields: null };
  const p = parseContactPayload(kind, rawPayload);
  const stored: Draft | null = parseDraft(storedDraft);
  const draft = stored ?? (p ? renderContactDraft(kind, p) : null);
  return {
    draft: draft ? { subject: draft.subject, body: draft.body } : null,
    editable: EDITABLE[kind],
    fields: p ? { ...fieldsOf(kind, p) } : null,
  };
}
