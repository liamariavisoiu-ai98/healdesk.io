import { eq, sql } from "drizzle-orm";

import { baaAcceptances, clinics } from "@/db/schema";
import { renderAgreementPdf } from "@/lib/agreements/pdf";
import { describeError, log } from "@/lib/log";
import { requirePortal } from "@/lib/portal/access";
import { portalActor } from "@/lib/portal/actor";
import { withTenant } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /c/<slug>/billing/agreement: the clinic's signed agreement, as a PDF,
 * for Billing's "Download" (plan Part F6). The agreement in effect for the
 * clinic's organisation (app_agreement_in_effect, 0048), read inside the
 * clinic's tenant, where baa_acceptances shows only its own organisation's,
 * and rendered by the same code that renders the copy sent at signing.
 *
 * The sign-in must be on this clinic (requirePortal, which answers by
 * Next's own redirect or not-found signals, so it is never caught here). The
 * document holds the practice's legal name and its signatory's business
 * contact details, never a patient's, so it needs no step-up, as the signed
 * copy emailed at signing needed none.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const portal = await requirePortal(slug);
  const actor = await portalActor(portal);

  const record = await withTenant(
    {
      clinicId: portal.clinicId,
      actor: { type: "user", userId: portal.userId, label: actor.label },
    },
    async (tx) => {
      const [clinic] = await tx.db
        .select({ organizationId: clinics.organizationId })
        .from(clinics)
        .where(eq(clinics.id, tx.clinicId))
        .limit(1);
      if (!clinic) return null;
      const found = await tx.db.execute<{ agreement_id: string }>(
        sql`select agreement_id from app_agreement_in_effect(${clinic.organizationId})`,
      );
      const id = found.rows[0]?.agreement_id;
      if (!id) return null;
      const [row] = await tx.db
        .select()
        .from(baaAcceptances)
        .where(eq(baaAcceptances.id, id))
        .limit(1);
      if (row) {
        tx.audit.record({
          action: "export",
          resourceType: "baa_acceptance",
          resourceId: row.id,
          metadata: { via: "portal_billing" },
        });
      }
      return row ?? null;
    },
  );
  if (!record) {
    return new Response("No signed agreement is on file for this clinic yet.", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  try {
    const pdf = await renderAgreementPdf(record);
    return new Response(Buffer.from(pdf.bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${pdf.filename}"`,
        "Cache-Control": "no-store, private",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (error) {
    log.error("portal agreement download failed", {
      clinicId: portal.clinicId,
      error: describeError(error),
    });
    return new Response("The agreement couldn't be prepared. Email hello@healdesk.io for a copy.", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}
