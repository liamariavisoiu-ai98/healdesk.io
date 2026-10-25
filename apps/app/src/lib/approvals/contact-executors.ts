import { and, eq } from "drizzle-orm";

import { auditReviewQueue, clinics, type OpsApproval } from "@/db/schema";
import { chaseBlocked, resignFactsIn } from "@/lib/agreements/open-resigns";
import { openResign, resignPath } from "@/lib/agreements/resign";
import { setupLastDay } from "@/lib/clinic/setup-window";
import { printableClinicName } from "@/lib/email/lint";
import { sendEmail, type SendEmailOptions } from "@/lib/email/send";
import { audienceFor } from "@/lib/email/templates/context";
import type { RenderedEmail } from "@/lib/email/templates/types";
import { describeError, log } from "@/lib/log";
import { enqueuePlanNotice } from "@/lib/notices/plan-notices";
import { actorFor, type Operator, type OpsOutcome } from "@/lib/ops/api";
import { opExtendSetupDeadline } from "@/lib/ops/billing";
import { publicOriginProblem, publicUrl } from "@/lib/public-url";
import { claimDelivery, recordDelivery } from "@/lib/reporting/recipients";
import { channelNextStep } from "@/lib/setup/channels";
import { queueSetupReminder } from "@/lib/setup/reminders";
import { stepsLeft, wizardFinished } from "@/lib/setup/screens";
import { readSetupState } from "@/lib/setup/state";
import { clinicSignIn } from "@/lib/sign-in/address-change";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { emailPayloadOf, LINK_PLACEHOLDER, renderContactEmail, sentDraft } from "./contact-drafts";
import { locationCount, noticeDedupeKey } from "./contact-packets";
import {
  parseContactPayload,
  parseFields,
  storableName,
  withFields,
  type ContactPayloads,
  type DraftKind,
  type RenderContext,
} from "./contact-payloads";
import { reminderPlanIn } from "./contact-reminders";
import { serialiseDraft } from "./drafts";
import type { ExecutionResult, Executor } from "./executors";
import { draftHash, type ContactKind } from "./kinds";

/**
 * What approving each clinic-contact kind runs (ops automation lane P6f),
 * through the sends that already exist: the outbox (enqueuePlanNotice, the
 * one path for a clinic's account email), the direct sender and its ledger
 * for the one link email (sendEmail, claimDelivery, as L22 sends), the
 * console's own extendSetupDeadline, and the setup reminders' own
 * queueSetupReminder. No second send path.
 *
 * Each sends with the owner's fields (the draft's `fields`, checked again
 * here), re-checks that the item still applies before anything goes, and
 * returns the hash of what was sent beside its outcome: the email's subject
 * and plain text (for the chase, with its link swapped for the placeholder
 * the draft shows, so the two hashes are equal exactly when the words sent
 * are the words approved).
 */

/** A contact executor's result, with the hash of what it sent when it sent. */
export type ContactResult = ExecutionResult & { draftHashSent?: string | null };

function fail(outcomeCode: string, message: string): ContactResult {
  return { ok: false, outcomeCode, message, auditRecorded: null };
}

const MALFORMED = fail("malformed_item", "This item's details could not be read, so nothing was sent.");

/** The approval's payload with the owner's fields, both checked again. */
function effectivePayload<K extends DraftKind>(kind: K, approval: OpsApproval, fields: unknown): ContactPayloads[K] | null {
  const stored = parseContactPayload(kind, approval.payload);
  if (!stored) return null;
  if (fields === undefined || fields === null) return stored;
  const parsed = parseFields(kind, fields);
  return parsed.ok ? withFields(kind, stored, parsed.fields) : null;
}

function hashOf(rendered: RenderedEmail, link?: string): string {
  const draft = sentDraft(rendered);
  const body = link ? draft.body.split(link).join(LINK_PLACEHOLDER) : draft.body;
  return draftHash(serialiseDraft({ subject: draft.subject, body }));
}

/** The clinic as an email renders it now, from its own row. */
async function renderContextIn(tx: TenantTx): Promise<RenderContext | null> {
  const [clinic] = await tx.db
    .select({ name: clinics.name, specialty: clinics.specialty, timezone: clinics.timezone })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!clinic) return null;
  return { clinicName: printableClinicName(clinic.name), audience: audienceFor(clinic.specialty), timeZone: clinic.timezone };
}

/** The rendered email as the outbox will send it: the template, the clinic's row as it stands. */
function asSent<K extends DraftKind>(kind: K, payload: ContactPayloads[K], ctx: RenderContext): RenderedEmail {
  return renderContactEmail(kind, { ...payload, ...ctx, clinicName: storableName(ctx.clinicName) });
}

// -----------------------------------------------------------------------------
// The BAA version re-sign chase: a link email, straight, on the ledger
// -----------------------------------------------------------------------------

const CHASE_BLOCKED_WORDS: Readonly<Record<NonNullable<ReturnType<typeof chaseBlocked>>, string>> = {
  not_baa_version: "This re-sign is no longer open, or is not a business associate agreement version re-sign, so nothing was sent.",
  switched_off: "BAA version re-signs are switched off, so the practice is not being asked to sign. Nothing was sent.",
  too_early: "L22's own reminders are not spent yet, so nothing was sent.",
  chased_recently: "The practice was chased less than 7 days ago, so nothing was sent.",
};

export async function sendResignChase(
  approval: OpsApproval,
  fields: unknown,
  now: Date = new Date(),
  options: SendEmailOptions = {},
): Promise<ContactResult> {
  const payload = effectivePayload("baa_resign_chase", approval, fields);
  if (!payload) return MALFORMED;
  if (publicOriginProblem()) return fail("no_public_origin", "BETTER_AUTH_URL is not set, so no signing link could be made. Nothing was sent.");
  const actor = { type: "service", serviceName: "approvals" } as const;
  const claim = await withTenant({ clinicId: payload.clinicId, actor }, async (tx) => {
    const facts = await resignFactsIn(tx, payload.resignId, now);
    if (!facts) return { state: "closed" as const, reason: "not_baa_version" as const };
    const blocked = chaseBlocked(facts, now);
    if (blocked) return { state: "closed" as const, reason: blocked };
    const signIn = await clinicSignIn(tx);
    const ctx = await renderContextIn(tx);
    if (!signIn || !ctx) return { state: "closed" as const, reason: "not_baa_version" as const };
    const deliveryId = await claimDelivery(tx, {
      kind: "baa_resign_chase",
      periodKey: `resign:${facts.resignId}:chase:${approval.id}`,
      recipient: signIn.email,
    });
    if (!deliveryId) return { state: "sent" as const };
    return {
      state: "claimed" as const,
      deliveryId,
      to: signIn.email,
      ctx,
      chase: { ...payload, fromVersion: facts.fromVersion ?? payload.fromVersion, toVersion: facts.toVersion, isAnswering: facts.isAnswering },
    };
  });
  if (claim.state === "closed") return fail("no_longer_needed", CHASE_BLOCKED_WORDS[claim.reason]);
  if (claim.state === "sent") return fail("already_sent", "This chase was already sent, so it was not sent again.");

  // Minted now, from BETTER_AUTH_URL: never stored, here or in the draft.
  const signUrl = publicUrl(resignPath({ id: payload.resignId, clinicId: payload.clinicId }, now));
  try {
    const ctx = { ...claim.ctx, clinicName: storableName(claim.ctx.clinicName) };
    const rendered = renderContactEmail("baa_resign_chase", { ...claim.chase, ...ctx }, signUrl);
    const result = await sendEmail(
      {
        to: claim.to,
        kind: "baa_resign_chase",
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        phiClass: "none",
        payload: emailPayloadOf("baa_resign_chase", claim.chase, signUrl),
        clinicName: claim.ctx.clinicName,
        clinicId: payload.clinicId,
        deliveryId: claim.deliveryId,
        // A fresh link per attempt, so a fresh key: Resend refuses a new body under an old key.
        idempotencyKey: `hd-baa_resign_chase-${claim.deliveryId}-${now.getTime().toString(36)}`,
      },
      { ...options, now },
    );
    await withTenant({ clinicId: payload.clinicId, actor }, (tx) =>
      recordDelivery(
        tx,
        claim.deliveryId,
        result.status === "sent" ? { status: "sent", messageId: result.messageId } : { status: result.status, reason: result.reason },
      ),
    );
    if (result.status !== "sent") {
      return fail("send_failed", `The email did not go (${result.status}). Nothing else was changed; propose the chase again once mail is working.`);
    }
    return { ok: true, outcomeCode: "sent", message: null, auditRecorded: null, draftHashSent: hashOf(rendered, signUrl) };
  } catch (error) {
    log.error("resign chase not sent", { clinicId: payload.clinicId, error: describeError(error) });
    await withTenant({ clinicId: payload.clinicId, actor }, (tx) =>
      recordDelivery(tx, claim.deliveryId, { status: "failed", reason: describeError(error) }),
    ).catch(() => undefined);
    return fail("send_failed", "The email could not be sent. Nothing else was changed.");
  }
}

// -----------------------------------------------------------------------------
// The outbox kinds
// -----------------------------------------------------------------------------

const ACTOR = { type: "service", serviceName: "approvals" } as const;

/** Queue one outbox notice in the clinic's tenant, and say what the outbox will send. */
async function queueNotice<K extends "agreement_question" | "setup_extended" | "setup_waiting_on_us" | "setup_help_offer">(
  tx: TenantTx,
  kind: K,
  dedupeKey: string,
  payload: ContactPayloads[K],
  emailPayload: Parameters<typeof enqueuePlanNotice<K>>[4],
): Promise<ContactResult> {
  const ctx = await renderContextIn(tx);
  if (!ctx) return fail("no_longer_needed", "The clinic could not be read, so nothing was sent.");
  const queued = await enqueuePlanNotice(tx.db, tx.clinicId, kind, dedupeKey, emailPayload);
  if (!queued) return fail("already_sent", "This email was already queued, so it was not queued again.");
  return { ok: true, outcomeCode: "queued", message: null, auditRecorded: null, draftHashSent: hashOf(asSent(kind, payload, ctx)) };
}

export async function sendAgreementQuestion(approval: OpsApproval, fields: unknown): Promise<ContactResult> {
  const payload = effectivePayload("agreement_question", approval, fields);
  if (!payload) return MALFORMED;
  return withTenant({ clinicId: payload.clinicId, actor: ACTOR }, async (tx) => {
    const [review] = await tx.db
      .select({ status: auditReviewQueue.status })
      .from(auditReviewQueue)
      .where(
        and(
          eq(auditReviewQueue.id, payload.reviewId),
          eq(auditReviewQueue.clinicId, tx.clinicId),
          eq(auditReviewQueue.kind, "agreement_kind"),
        ),
      )
      .limit(1);
    if (review?.status !== "open") return fail("no_longer_needed", "This review has been decided since, so nothing was sent.");
    if (await openResign(tx)) return fail("no_longer_needed", "A re-sign is already open for this practice, so nothing was sent.");
    // Counted again now: a location added since is a location that would pause.
    const live = (await readSetupState(tx, { userId: null }))?.channels.some((c) => c.liveAt !== null) ?? payload.isAnswering;
    const fresh = { ...payload, locations: await locationCount(tx), isAnswering: live };
    return queueNotice(tx, "agreement_question", `agreement_question:${approval.id}`, fresh, emailPayloadOf("agreement_question", fresh));
  });
}

/**
 * The extension, then the email. The order is the point: extendSetupDeadline
 * runs first, through the console's own operation (its guard on the deadline
 * the proposal read, its audit row, the lifecycle row stamped through
 * recordExtension), and the email is queued only once it answered
 * `extended`, with the last day it set. An extension refused or failed
 * queues nothing, so the clinic is never told "more time" it does not have.
 * An email that cannot be queued after the extension went through is a
 * failure of its own (`extended_email_not_queued`): the deadline has moved.
 */
export async function extendThenNotify(approval: OpsApproval, operator: Operator, fields: unknown): Promise<ContactResult> {
  const payload = effectivePayload("setup_extended", approval, fields);
  if (!payload) return MALFORMED;
  const outcome: OpsOutcome = await opExtendSetupDeadline(
    { clinicId: payload.clinicId, days: payload.days, fromDeadline: payload.fromDeadline },
    operator,
  );
  const data =
    outcome.status === 200 && "data" in outcome.body && typeof outcome.body.data === "object" && outcome.body.data !== null
      ? (outcome.body.data as Record<string, unknown>)
      : null;
  if (!data || data.status !== "extended" || typeof data.setupDeadlineAt !== "string") {
    const said = data && typeof data.message === "string" ? data.message : "The extension did not go through.";
    return fail("extension_refused", `${said} Nothing was emailed.`);
  }
  const auditRecorded = data.auditRecorded === true;
  const deadline = new Date(data.setupDeadlineAt);
  try {
    const result = await withTenant({ clinicId: payload.clinicId, actor: actorFor(operator), request: operator.request }, async (tx) => {
      const state = await readSetupState(tx, { userId: null });
      const tz = state?.clinic.timezone ?? payload.timeZone;
      const finished = state ? wizardFinished(state.screens, state.progress) : false;
      const fresh: ContactPayloads["setup_extended"] = {
        ...payload,
        stepsLeftCount: state ? stepsLeft(state.screens, state.progress) : payload.stepsLeftCount,
        rows: state
          ? state.channels.filter((c) => c.liveAt === null).map((c) => ({ channel: c.channel, status: channelNextStep(c, finished) }))
          : payload.rows,
      };
      const closesOn = setupLastDay(deadline, tz);
      return queueNotice(
        tx,
        "setup_extended",
        `setup_extended:${approval.id}`,
        { ...fresh, fromDeadline: payload.fromDeadline },
        emailPayloadOf("setup_extended", fresh, closesOn),
      );
    });
    return { ...result, auditRecorded };
  } catch (error) {
    log.error("setup extension email not queued", { clinicId: payload.clinicId, error: describeError(error) });
    return {
      ...fail(
        "extended_email_not_queued",
        `The deadline was extended to the end of ${setupLastDay(deadline, payload.timeZone)}, but the email to the clinic could not be queued. Tell the clinic yourself.`,
      ),
      auditRecorded,
    };
  }
}

export async function sendSetupNotice(
  kind: "setup_waiting_on_us" | "setup_help_offer",
  approval: OpsApproval,
  fields: unknown,
): Promise<ContactResult> {
  const payload = effectivePayload(kind, approval, fields);
  if (!payload) return MALFORMED;
  return withTenant({ clinicId: payload.clinicId, actor: ACTOR }, async (tx) => {
    const state = await readSetupState(tx, { userId: null });
    if (!state?.billing || state.clinic.offboardingStartedAt) {
      return fail("no_longer_needed", "The account is no longer being set up, so nothing was sent.");
    }
    if (kind === "setup_waiting_on_us") {
      const p = payload as ContactPayloads["setup_waiting_on_us"];
      return queueNotice(tx, kind, noticeDedupeKey(kind, p), p, emailPayloadOf(kind, p));
    }
    const p = payload as ContactPayloads["setup_help_offer"];
    return queueNotice(tx, kind, noticeDedupeKey(kind, p), p, emailPayloadOf(kind, p));
  });
}

/** "Send reminder now": the existing sender, asked as of the reminder's own day (./contact-reminders.ts). */
export async function pullReminder(approval: OpsApproval, now: Date = new Date()): Promise<ContactResult> {
  const payload = parseContactPayload("setup_reminder_now", approval.payload);
  if (!payload) return MALFORMED;
  const plan = await withTenant({ clinicId: payload.clinicId, actor: ACTOR }, (tx) => reminderPlanIn(tx, now));
  if (!plan.ok || plan.reminderNumber !== payload.reminderNumber) {
    return fail("no_longer_needed", "That reminder is no longer the next one to send, so nothing was sent. Press Send reminder now again to see which is.");
  }
  const outcome = await queueSetupReminder(payload.clinicId, plan.asOf);
  if (outcome === "queued") return { ok: true, outcomeCode: "queued", message: null, auditRecorded: null, draftHashSent: null };
  if (outcome === "already_queued") return fail("already_sent", "That reminder was already queued, so it was not queued again.");
  return fail("reminder_not_queued", `The reminder was not queued (${outcome.replace(/_/g, " ")}).`);
}

/** One executor per contact kind. */
export const CONTACT_EXECUTORS: Readonly<Record<ContactKind, Executor>> = {
  baa_resign_chase: (approval, _operator, ctx) => sendResignChase(approval, ctx.draft?.fields),
  agreement_question: (approval, _operator, ctx) => sendAgreementQuestion(approval, ctx.draft?.fields),
  setup_extended: (approval, operator, ctx) => extendThenNotify(approval, operator, ctx.draft?.fields),
  setup_waiting_on_us: (approval, _operator, ctx) => sendSetupNotice("setup_waiting_on_us", approval, ctx.draft?.fields),
  setup_help_offer: (approval, _operator, ctx) => sendSetupNotice("setup_help_offer", approval, ctx.draft?.fields),
  setup_reminder_now: (approval) => pullReminder(approval),
};
