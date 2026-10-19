import type { ClinicProfile, CoveredAnswer } from "@healdesk/catalog";
import { and, desc, eq, gt, or } from "drizzle-orm";

import { auditReviewQueue, clinics } from "@/db/schema";
import type { ActorContext, RequestContext } from "@/lib/audit";
import { endOfDay } from "@/lib/engine/practice/store";
import { listClinics } from "@/lib/ops/clinics";
import { replyByDay } from "@/lib/reply-by";
import { withTenant, type TenantTx } from "@/lib/tenant";

/**
 * The misclassification signal (package WP9, plan Part L): a practice that
 * signed the Data Protection Agreement as billing no insurance electronically
 * ("No"), whose own website, read at checkout, says it accepts insurance.
 *
 * Accepting insurance is not billing it electronically: a practice can hand
 * patients a superbill, or be out of network. So the signal decides nothing.
 * It opens one review for ops in the practice questions' queue
 * (audit_review_queue, kind `agreement_kind`), and ops decides it by asking
 * the practice and recording its answer through setCoveredEntity, which on a
 * "Yes" or "Not sure" starts the re-sign to the BAA (lib/agreements/
 * resign.ts) and closes the review. A review is about the practice, so one is
 * open per clinic, a run of the practice questions never supersedes it, and
 * it has no day promised to the clinic, which never hears of it.
 *
 * Raised where the site profile is written: at provisioning, after the setup
 * seed (lib/provisioning.ts), and by any later re-read that replaces
 * clinics.site_profile (WP11's), which calls `flagInsuranceMismatch` too.
 * Business data only: the site's own claim and the practice's answer.
 */

/** Whether a clinic's facts are the signal's: a DPA "No" practice whose site takes insurance. */
export function insuranceMismatch(clinic: {
  regulatoryRegime: string | null;
  agreementKind: string | null;
  isCoveredEntity: boolean | null;
  siteProfile: Pick<ClinicProfile, "acceptsInsurance"> | null;
}): boolean {
  return (
    clinic.regulatoryRegime === "hipaa-if-covered" &&
    clinic.agreementKind === "dpa" &&
    clinic.isCoveredEntity === false &&
    clinic.siteProfile?.acceptsInsurance === "yes"
  );
}

/**
 * Open the clinic's agreement-kind review if its facts are the signal's and
 * none is open. Inside the tenant, in the caller's transaction. Returns
 * whether it opened one.
 */
export async function flagInsuranceMismatch(
  tx: TenantTx,
  now: Date = new Date(),
): Promise<boolean> {
  const [clinic] = await tx.db
    .select({
      regulatoryRegime: clinics.regulatoryRegime,
      agreementKind: clinics.agreementKind,
      isCoveredEntity: clinics.isCoveredEntity,
      siteProfile: clinics.siteProfile,
    })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!clinic || !insuranceMismatch(clinic)) return false;
  const dueOn = replyByDay(now);
  const opened = await tx.db
    .insert(auditReviewQueue)
    .values({
      clinicId: tx.clinicId,
      kind: "agreement_kind",
      runId: null,
      dueOn,
      dueAt: endOfDay(dueOn),
    })
    .onConflictDoNothing()
    .returning({ id: auditReviewQueue.id });
  if (opened.length === 0) return false;
  tx.audit.record({
    action: "create",
    resourceType: "audit_review",
    resourceId: opened[0]!.id,
    metadata: { kind: "agreement_kind", signal: "site_accepts_insurance" },
  });
  return true;
}

/**
 * Close the clinic's open agreement-kind review, if any, because its answer
 * has just been recorded (setCoveredEntity): `passed` when it stands at "No"
 * and the DPA covers it, `failed` when the practice is covered or unsure and
 * signs the BAA. Inside the tenant, in the caller's transaction.
 */
export async function closeAgreementKindReview(
  tx: TenantTx,
  input: { answer: CoveredAnswer; decidedBy: string; now?: Date },
): Promise<boolean> {
  const rows = await tx.db
    .update(auditReviewQueue)
    .set({
      status: input.answer === "no" ? "passed" : "failed",
      decidedAt: input.now ?? new Date(),
      decidedByLabel: input.decidedBy.slice(0, 200),
    })
    .where(
      and(
        eq(auditReviewQueue.clinicId, tx.clinicId),
        eq(auditReviewQueue.kind, "agreement_kind"),
        eq(auditReviewQueue.status, "open"),
      ),
    )
    .returning({ id: auditReviewQueue.id });
  return rows.length > 0;
}

// -----------------------------------------------------------------------------
// The operator's side (ops envelope: listAgreementReviews, decideAgreementReview)
// -----------------------------------------------------------------------------

const LIST_DECIDED_DAYS = 14;

export type AgreementReviewEntry = {
  id: string;
  clinicId: string;
  clinicSlug: string;
  clinicName: string;
  status: "open" | "passed" | "failed";
  /** Why it opened: the one signal there is. */
  signal: "site_accepts_insurance";
  createdAt: string;
  decidedAt: string | null;
  decidedByLabel: string | null;
};

/** Open reviews first, oldest first; then those decided in the last two weeks, newest first. */
export async function listAgreementReviews(input: {
  now?: Date;
  actor: ActorContext;
  request?: RequestContext;
}): Promise<AgreementReviewEntry[]> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - LIST_DECIDED_DAYS * 24 * 60 * 60 * 1000);
  const entries: AgreementReviewEntry[] = [];
  for (const clinic of await listClinics()) {
    const rows = await withTenant(
      { clinicId: clinic.id, actor: input.actor, request: input.request },
      (tx) =>
        tx.db
          .select()
          .from(auditReviewQueue)
          .where(
            and(
              eq(auditReviewQueue.clinicId, tx.clinicId),
              eq(auditReviewQueue.kind, "agreement_kind"),
              or(eq(auditReviewQueue.status, "open"), gt(auditReviewQueue.createdAt, since)),
            ),
          )
          .orderBy(desc(auditReviewQueue.createdAt))
          .limit(20),
    );
    for (const row of rows) {
      if (row.status === "superseded") continue;
      entries.push({
        id: row.id,
        clinicId: clinic.id,
        clinicSlug: clinic.slug,
        clinicName: clinic.name,
        status: row.status,
        signal: "site_accepts_insurance",
        createdAt: row.createdAt.toISOString(),
        decidedAt: row.decidedAt?.toISOString() ?? null,
        decidedByLabel: row.decidedByLabel,
      });
    }
  }
  return entries.sort((a, b) => {
    if ((a.status === "open") !== (b.status === "open")) return a.status === "open" ? -1 : 1;
    return a.status === "open"
      ? a.createdAt.localeCompare(b.createdAt)
      : b.createdAt.localeCompare(a.createdAt);
  });
}
