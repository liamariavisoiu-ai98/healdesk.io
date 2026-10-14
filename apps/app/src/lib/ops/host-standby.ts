import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { baaAcceptances, transcriptEmails } from "@/db/schema";
import type { ActorContext, RequestContext } from "@/lib/audit";
import { listClinics } from "@/lib/ops/clinics";
import { withTenant } from "@/lib/tenant";

/**
 * Whether this host holds anything real, asked before it goes into standby.
 *
 * Standby (infra/aws, README "Standby") deletes the database after a final
 * snapshot and stops every task: no call is answered, no chat, no transcript
 * sent, no clock run. /admin/host asks this first and dispatches nothing
 * unless every count is 0; .github/workflows/host.yml cannot sign an ops
 * call, so it has a coarser guard of its own.
 *
 *   productionClinics  clinics classified production (the BAA gate,
 *                      drizzle/0004) and not yet destroyed: their patients'
 *                      calls and chats run here.
 *   boundAgreements    agreements bound to a paid organisation and still in
 *                      effect, of either kind: a clinic that has paid is owed
 *                      the service, whatever its data classification. A
 *                      terminated agreement no longer binds (the test
 *                      purchase on Stripe's test keys ends that way), and its
 *                      record stays in the snapshot.
 *   openTranscripts    transcripts not yet accepted by SES (open, pending, or
 *                      bounced and waiting to go again): the outbox would
 *                      stop with the worker, and the clinic would not get
 *                      them until the host came back.
 *
 * Counts only, across every clinic. The clinic list comes from the SECURITY
 * DEFINER overview the console already uses; agreements are read in service
 * context, where their policy shows every row; transcripts sit behind FORCE
 * RLS, so they are counted one clinic at a time inside its tenant. No name,
 * id, address or date crosses, and nothing is written: the per-clinic reads
 * touch the count of a status column, which records no PHI access.
 */
export type HostStandbyCheck = {
  ok: boolean;
  productionClinics: number;
  boundAgreements: number;
  openTranscripts: number;
};

/** The statuses of a transcript SES has not taken yet (drizzle/0069, 0071). */
const NOT_YET_SENT = ["open", "pending", "bounced"] as const;

export async function hostStandbyCheck(
  actor: ActorContext,
  request: RequestContext,
): Promise<HostStandbyCheck> {
  const clinics = await listClinics();

  const productionClinics = clinics.filter(
    (clinic) => clinic.dataClassification === "production" && clinic.destroyedAt === null,
  ).length;

  const [agreements] = await unsafeDb
    .select({ n: sql<number>`count(*)::int` })
    .from(baaAcceptances)
    .where(and(isNotNull(baaAcceptances.boundAt), isNull(baaAcceptances.terminatedAt)));
  const boundAgreements = agreements?.n ?? 0;

  let openTranscripts = 0;
  for (const clinic of clinics) {
    openTranscripts += await withTenant({ clinicId: clinic.id, actor, request }, async (tx) => {
      const [row] = await tx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(transcriptEmails)
        .where(and(eq(transcriptEmails.clinicId, tx.clinicId), inArray(transcriptEmails.status, [...NOT_YET_SENT])));
      return row?.n ?? 0;
    });
  }

  return {
    ok: productionClinics === 0 && boundAgreements === 0 && openTranscripts === 0,
    productionClinics,
    boundAgreements,
    openTranscripts,
  };
}
