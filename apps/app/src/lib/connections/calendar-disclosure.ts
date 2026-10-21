import {
  audienceFor,
  googleCalendarDisclosureFor,
  renderGoogleCalendarDisclosure,
  type GoogleCalendarDisclosure,
} from "@healdesk/catalog";
import { eq } from "drizzle-orm";

import { clinics } from "@/db/schema";
import type { TenantTx } from "@/lib/tenant";

/**
 * The Google Calendar notice one practice is shown, ticks and has recorded
 * (packages/catalog/src/google-calendar-disclosure.ts): the BAA's wording, or
 * since the Data Protection Agreement's release on 20 October 2026, the DPA's
 * for a practice under it, which calls the person offered times a client at a
 * veterinary practice and names the agreement the practice actually signed.
 *
 * Read from the clinic's own row inside its tenant, by every surface that
 * shows the notice (setup's calendar step, Settings → Calendar, the
 * /calendar/<token> page) and by beginGoogleSignIn, which refuses any other
 * version and stores this one's version and hash with the acceptance. One
 * reader, so a practice can never be shown one wording and recorded under
 * another. `agreement_kind` is a gate column only provisioning and the
 * re-sign move; a null one is read as the BAA, as the PHI gate reads it.
 */
export async function practiceCalendarDisclosure(tx: TenantTx): Promise<GoogleCalendarDisclosure> {
  const [row] = await tx.db
    .select({ agreementKind: clinics.agreementKind, specialty: clinics.specialty })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  return googleCalendarDisclosureFor({
    agreementKind: row?.agreementKind ?? null,
    audience: audienceFor(row?.specialty),
  });
}

/** The practice's notice with its name filled in, as the page shows it. */
export async function renderPracticeCalendarDisclosure(
  tx: TenantTx,
  clinicName: string,
): Promise<GoogleCalendarDisclosure> {
  return renderGoogleCalendarDisclosure({ clinicName }, await practiceCalendarDisclosure(tx));
}
