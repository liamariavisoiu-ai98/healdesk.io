import { cleanWebsite } from "@healdesk/catalog";
import { eq } from "drizzle-orm";

import { clinics } from "@/db/schema";
import { withTenant } from "@/lib/tenant";
import { requestSiteReread as queueSiteReread } from "@/lib/website/queue";

import {
  actorFor,
  audit,
  clinicById,
  ok,
  opsProblem,
  stringArg,
  type Operator,
  type OpsOutcome,
} from "./api";

/**
 * requestSiteReread: an operator asks for a clinic's website to be read
 * again (plan Part B, "Re-reads"; Part K's site-read failures view). The
 * read is queued here and sent from the site-reads job to apps/web's signed
 * /api/clinic-site like any other (lib/website): for a clinic with no
 * profile it becomes the baseline and fills setup; for one with a profile it
 * is a drift check, today. What crosses back to the console is a status and
 * the read's id; never the website's content.
 */

export type SiteRereadRequestState =
  | { status: "queued"; rereadId: string; auditRecorded: boolean }
  | { status: "refused"; message: string };

export async function opRequestSiteReread(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return opsProblem("No such clinic.", 404, "invalid_args");

  const queued = await withTenant(
    { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
    async (tx): Promise<{ refused: string } | { id: string }> => {
      const [row] = await tx.db
        .select({
          website: clinics.website,
          offboardingStartedAt: clinics.offboardingStartedAt,
        })
        .from(clinics)
        .where(eq(clinics.id, tx.clinicId))
        .limit(1);
      if (!row || row.offboardingStartedAt) return { refused: "This clinic has left." };
      const website = cleanWebsite(row.website);
      if (!website) return { refused: "This clinic has no website to read." };
      return { id: await queueSiteReread(tx, { reason: "ops", website }) };
    },
  );
  if ("refused" in queued) {
    return ok({ status: "refused", message: queued.refused } satisfies SiteRereadRequestState);
  }
  const auditRecorded = await audit(operator, "site_reread_requested", {
    clinicSlug: clinic.slug,
    rereadId: queued.id,
  });
  return ok({
    status: "queued",
    rereadId: queued.id,
    auditRecorded,
  } satisfies SiteRereadRequestState);
}
