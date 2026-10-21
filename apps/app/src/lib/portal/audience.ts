import { audienceFor, type Audience } from "@healdesk/catalog";
import { eq } from "drizzle-orm";

import { clinics } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { withTenant } from "@/lib/tenant";

import type { PortalContext, PortalGrant } from "./access";

/**
 * Who a clinic's customers are, in its own word (`audienceFor`: "clients" at
 * a veterinary practice, whose patients are animals, "patients" everywhere
 * else), for the screens and emails that read nothing else of the clinic: the
 * passkey pages, which never load the portal page, and the sign-in's own
 * emails, which name no clinic because one address can open several. A
 * screen that has loaded the portal page has it already (`shell.audience`).
 */
export async function clinicAudience(clinicId: string, actor: ActorContext): Promise<Audience> {
  return withTenant({ clinicId, actor }, async (tx) => {
    const [row] = await tx.db
      .select({ specialty: clinics.specialty })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    return audienceFor(row?.specialty);
  });
}

/**
 * The clinic a portal page or action is for. The caller has already passed
 * requirePortal, so this is the clinic the sign-in opens; the read is the
 * clinic's own business data and writes no audit row.
 */
export async function portalAudience(portal: PortalContext): Promise<Audience> {
  return clinicAudience(portal.clinicId, { type: "service", serviceName: "portal-audience" });
}

/**
 * For mail about a sign-in rather than one clinic: "clients" only when every
 * clinic the sign-in opens is a veterinary practice, so a sign-in that also
 * opens a practice whose patients are people never reads that its patients
 * are clients. No clinic at all is "patients", audienceFor's own default.
 */
export async function signInAudience(grants: readonly PortalGrant[]): Promise<Audience> {
  if (grants.length === 0) return "patients";
  const actor: ActorContext = { type: "service", serviceName: "sign-in-audience" };
  for (const grant of grants) {
    if ((await clinicAudience(grant.clinicId, actor)) !== "clients") return "patients";
  }
  return "clients";
}
