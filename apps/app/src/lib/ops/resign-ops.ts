import { isCoveredAnswer } from "@healdesk/catalog";
import { and, eq, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { auditReviewQueue, clinics } from "@/db/schema";
import { renderContactDraft } from "@/lib/approvals/contact-drafts";
import { locationCount } from "@/lib/approvals/contact-packets";
import { storableName, type ContactPayloads } from "@/lib/approvals/contact-payloads";
import { serialiseDraft } from "@/lib/approvals/drafts";
import { CONSOLE_PROPOSER, UUID } from "@/lib/approvals/kinds";
import { propose, subjectAfterRejections } from "@/lib/approvals/store";
import { chaseBlocked, organisationAnswering, readOpenResigns } from "@/lib/agreements/open-resigns";
import { openResign } from "@/lib/agreements/resign";
import { printableClinicName } from "@/lib/email/lint";
import { audienceFor } from "@/lib/email/templates/context";
import { describeError, log } from "@/lib/log";
import { withTenant } from "@/lib/tenant";

// api.ts imports this module for its dispatch, and this module borrows its
// helpers: safe, because nothing here touches them while the modules load.
import { actorFor, audit, booleanArg, clinicById, ok, opsProblem, stringArg, type Operator, type OpsOutcome } from "./api";
import { opDecideAgreementReview } from "./account-ops";
import { codeFactor } from "./code-factor";

/**
 * The agreement side of the clinic-contact approvals (ops automation lane
 * P6f; design E6 §3 items 13 and 14):
 *
 *   - `listOpenResigns` (read): every open re-sign across clinics, below the
 *     floor first, then the longest open: the re-sign's id, the clinic, why,
 *     from version to version, when it opened, the last L22 sent (from the
 *     ledger), days open, when the latest link stops working, `belowFloor`,
 *     `fromVersionAcceptable`, the last chase and whether one may be
 *     proposed now. Ids, versions, dates and closed words.
 *   - `proposeAgreementQuestion {clinicId, reviewId}` (write): puts the
 *     question for an open agreement-kind review in the approval inbox, with
 *     its draft. Sends nothing.
 *   - `recordAgreementAnswer {clinicId, reviewId, answer, codeChecked}`
 *     (write): the answer the OWNER heard (yes, no or not_sure), never one
 *     inferred from the website or a reply, recorded through the console's
 *     own decideAgreementReview, which on Yes or Not sure opens the BAA
 *     re-sign and pauses AYA at every location. Only behind apps/web's
 *     fresh-code wrapper (`codeChecked`, as decideApproval).
 *
 * Each write records a security event naming the operator.
 */

const SORT_LIMIT = 500;

async function clinicNames(): Promise<Map<string, string>> {
  const result = await unsafeDb.execute<{ id: string; name: string | null }>(sql`select id, name from app_clinics_overview()`);
  const names = new Map<string, string>();
  for (const row of result.rows) {
    const name = printableClinicName(row.name);
    if (name) names.set(row.id, name);
  }
  return names;
}

export type OpenResignRow = {
  resignId: string;
  clinic: { id: string; name: string | null };
  reason: "now_covered" | "not_sure" | "baa_version";
  fromVersion: string | null;
  toVersion: string;
  startedAt: string;
  lastL22SentAt: string | null;
  daysOpen: number;
  linkExpiresAt: string | null;
  belowFloor: boolean;
  fromVersionAcceptable: boolean;
  /** Whether it holds AYA paused: a DPA re-sign does, a BAA version re-sign never. */
  holdsPause: boolean;
  lastChaseAt: string | null;
  /** Why the owner cannot chase it now, or null when a chase may go. */
  chaseBlocked: "not_baa_version" | "switched_off" | "too_early" | "chased_recently" | null;
};

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function opListOpenResigns(operator: Operator, now: Date = new Date()): Promise<OpsOutcome> {
  try {
    const { resigns, unread } = await readOpenResigns({ actor: actorFor(operator), request: operator.request, now });
    const names = await clinicNames();
    const rows: OpenResignRow[] = resigns
      .map((r) => ({
        resignId: r.resignId,
        clinic: { id: r.clinicId, name: names.get(r.clinicId) ?? null },
        reason: r.reason,
        fromVersion: r.fromVersion,
        toVersion: r.toVersion,
        startedAt: r.startedAt.toISOString(),
        lastL22SentAt: iso(r.lastL22SentAt),
        daysOpen: r.daysOpen,
        linkExpiresAt: iso(r.linkExpiresAt),
        belowFloor: r.belowFloor,
        fromVersionAcceptable: r.fromVersionAcceptable,
        holdsPause: r.reason !== "baa_version",
        lastChaseAt: iso(r.lastChaseAt),
        chaseBlocked: chaseBlocked(r, now),
      }))
      .sort((a, b) => Number(b.belowFloor) - Number(a.belowFloor) || b.daysOpen - a.daysOpen)
      .slice(0, SORT_LIMIT);
    return ok({ resigns: rows, unread });
  } catch (error) {
    log.error("open re-signs not listed", { error: describeError(error) });
    return opsProblem("The open re-signs could not be read.", 500, "failed");
  }
}

export type ProposeOutcome = { status: "proposed"; approvalId: string } | { status: "refused"; message: string };

function refused(message: string): OpsOutcome {
  return ok({ status: "refused", message } satisfies ProposeOutcome);
}

export function operatorEventActor(operator: Operator) {
  return { label: operator.email, ip: operator.request.ipAddress ?? null, userAgent: operator.request.userAgent ?? null };
}

/** Whether the clinic is healdesk's demo clinic or a closed account: nothing is sent to either. */
async function outOfService(clinicId: string, operator: Operator): Promise<boolean> {
  // In the clinic's own tenant: clinics is a forced row-level-security table.
  const result = await withTenant({ clinicId, actor: actorFor(operator), request: operator.request }, (tx) =>
    tx.db.execute<{ out: boolean }>(
      sql`select (app_clinic_is_demo(id) or account_closed_at is not null or destroyed_at is not null) as out
            from clinics where id = ${clinicId}::uuid`,
    ),
  );
  return result.rows[0]?.out !== false;
}

export async function opProposeAgreementQuestion(
  args: Record<string, unknown>,
  operator: Operator,
  now: Date = new Date(),
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return refused("No such clinic.");
  const reviewId = stringArg(args, "reviewId") ?? "";
  if (!UUID.test(reviewId)) return refused("No such review at this clinic.");
  if (await outOfService(clinic.id, operator)) return refused("This is the demo clinic or a closed account, so nothing is sent to it.");
  const facts = await withTenant({ clinicId: clinic.id, actor: actorFor(operator), request: operator.request }, async (tx) => {
    const [review] = await tx.db
      .select({ status: auditReviewQueue.status })
      .from(auditReviewQueue)
      .where(
        and(eq(auditReviewQueue.id, reviewId), eq(auditReviewQueue.clinicId, tx.clinicId), eq(auditReviewQueue.kind, "agreement_kind")),
      )
      .limit(1);
    const [row] = await tx.db.select({ timezone: clinics.timezone }).from(clinics).where(eq(clinics.id, tx.clinicId)).limit(1);
    return {
      status: review?.status ?? null,
      resignOpen: (await openResign(tx)) !== null,
      locations: await locationCount(tx),
      isAnswering: await organisationAnswering(tx),
      timeZone: row?.timezone ?? clinic.timezone,
    };
  });
  if (facts.status !== "open") return refused(facts.status === null ? "No such review at this clinic." : "This review has been decided already.");
  if (facts.resignOpen) return refused("A re-sign is already open for this practice, so there is nothing to ask.");
  const payload: ContactPayloads["agreement_question"] = {
    clinicId: clinic.id,
    reviewId,
    locations: facts.locations,
    isAnswering: facts.isAnswering,
    note: null,
    clinicName: storableName(printableClinicName(clinic.name)),
    audience: audienceFor(clinic.specialty),
    timeZone: facts.timeZone,
  };
  const draft = serialiseDraft(renderContactDraft("agreement_question", payload));
  const approvalId = await propose(
    { kind: "agreement_question", subjectClinicId: clinic.id, subjectRef: await subjectAfterRejections("agreement_question", reviewId), payload },
    now,
    { proposedBy: CONSOLE_PROPOSER, actor: operatorEventActor(operator), draft },
  );
  if (!approvalId) {
    return refused("This question is already waiting in Approvals, or was rejected there: nothing new was proposed.");
  }
  await audit(operator, "approval_proposed", { approvalId, kind: "agreement_question", clinicId: clinic.id });
  return ok({ status: "proposed", approvalId } satisfies ProposeOutcome);
}

export async function opRecordAgreementAnswer(args: Record<string, unknown>, operator: Operator): Promise<OpsOutcome> {
  // The fresh code is checked on apps/web, which holds the secret; only its
  // wrapper sets the mark (lib/admin/agreement-answer.ts).
  if (booleanArg(args, "codeChecked") !== true) {
    return ok({ status: "refused", message: "This needs the approval passcode or the code from your authenticator. Nothing was changed." });
  }
  if (!isCoveredAnswer(args.answer)) return ok({ status: "refused", message: "The answer is yes, no or not_sure." });
  const clinicId = stringArg(args, "clinicId");
  const reviewId = stringArg(args, "reviewId");
  const outcome = await opDecideAgreementReview({ clinicId, reviewId, answer: args.answer }, operator);
  const data = outcome.status === 200 && "data" in outcome.body ? (outcome.body.data as Record<string, unknown>) : null;
  await audit(operator, "agreement_answer_recorded", {
    answer: args.answer,
    reviewId: reviewId ?? null,
    freshCode: true,
    factor: codeFactor(args),
    outcome: typeof data?.status === "string" ? data.status : "error",
    ...(clinicId ? { clinicId } : {}),
  });
  return outcome;
}
