import { and, eq, inArray, isNull } from "drizzle-orm";

import { user } from "@/db/auth-schema";
import { clinicMemberships, reportRecipients } from "@/db/schema";
import type { TenantTx } from "@/lib/tenant";

/**
 * Who receives a clinic's billing email (design D12).
 *
 * The spec: dunning goes to the owner and the billing contact, never to the
 * clinic's public inbox. So billing mail is addressed to PEOPLE with a grant
 * — active clinic_memberships rows with role 'owner' or 'billing' — and never
 * to report_recipients, which is the front-desk list the weekly recap goes
 * to and may well be info@.
 *
 * `tx` must be open on the BILLING clinic (lib/billing/billing-clinic.ts,
 * withBillingTenant): memberships are tenant rows, and a location's own list
 * is not who pays.
 *
 * One fallback, for clinics provisioned before identities were created at
 * provisioning (design D3): when there is no owner or billing grant at all,
 * the buyer the provisioning step seeded into report_recipients
 * (added_by 'provisioning'). That address IS the person who paid, which is
 * why it is the one exception; any other report recipient is not.
 */

export type BillingRecipient = {
  email: string;
  role: "owner" | "billing";
  /** Null only for the provisioning fallback, which has no user row. */
  userId: string | null;
};

export async function billingRecipients(tx: TenantTx): Promise<BillingRecipient[]> {
  const rows = await tx.db
    .select({ email: user.email, role: clinicMemberships.role, userId: user.id })
    .from(clinicMemberships)
    .innerJoin(user, eq(user.id, clinicMemberships.userId))
    .where(
      and(
        eq(clinicMemberships.clinicId, tx.clinicId),
        isNull(clinicMemberships.revokedAt),
        inArray(clinicMemberships.role, ["owner", "billing"]),
      ),
    );

  // One email per address; an owner who is also listed as billing contact is
  // mailed once, as owner. Owners first so a capped sender reaches them.
  const byEmail = new Map<string, BillingRecipient>();
  for (const row of rows) {
    const email = row.email.trim().toLowerCase();
    if (!email) continue;
    const role = row.role === "owner" ? "owner" : "billing";
    const existing = byEmail.get(email);
    if (!existing || (existing.role === "billing" && role === "owner")) {
      byEmail.set(email, { email, role, userId: row.userId });
    }
  }
  const people = [...byEmail.values()].sort((a, b) =>
    a.role === b.role ? a.email.localeCompare(b.email) : a.role === "owner" ? -1 : 1,
  );
  if (people.length > 0) return people;

  const seeded = await tx.db
    .select({ email: reportRecipients.email })
    .from(reportRecipients)
    .where(
      and(
        eq(reportRecipients.clinicId, tx.clinicId),
        eq(reportRecipients.addedBy, "provisioning"),
        isNull(reportRecipients.unsubscribedAt),
      ),
    );
  return seeded.map((row) => ({
    email: row.email.trim().toLowerCase(),
    role: "owner" as const,
    userId: null,
  }));
}
