import { and, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import { user } from "@/db/auth-schema";
import { clinicMemberships, clinics, reportRecipients } from "@/db/schema";
import type { NoticeKind } from "@/lib/email/kinds";
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
 *
 * And one for a closed account (lib/offboarding/account-closure.ts), which
 * has no live grant and no report recipient left: the agreement's notice
 * address the closure kept (clinics.notice_address), so a notice still owed
 * after termination reaches the practice in writing through the outbox and
 * its ledger. Only for the kinds on OWED_AFTER_CLOSURE, named by the caller,
 * and only while the address is kept: its end (notice_address_until) is read
 * by the database's clock here, so an expired address is never used even
 * before the hourly job clears it. Any other kind, and a call that names
 * none, finds no one for a closed account.
 */

/**
 * The notices still owed to a practice after its account has closed, and the
 * only ones its kept notice address receives:
 *   - incident_report: the BAA's breach and incident reports (clause 12),
 *     which clause 17 keeps owing while backups and Anthropic's retained
 *     copies hold the practice's information, sent to the notice address
 *     clause 20 defines;
 *   - refund_issued: a refund the Terms still owe after the end (sections 5
 *     and 15, which survive termination), returned to the card it came from;
 *   - receipt: a payment taken after the end, a final invoice settled late:
 *     the billing record the Terms keep (section 7), told to the practice.
 * Nothing else is owed after the end: the Terms' later changes take effect
 * at a renewal a closed account never has (section 16), dunning and usage
 * mail end with the service (sections 3 and 6 do not survive), and every
 * product or marketing kind ended with the account.
 */
export const OWED_AFTER_CLOSURE: ReadonlySet<NoticeKind> = new Set<NoticeKind>([
  "incident_report",
  "refund_issued",
  "receipt",
]);

export type BillingRecipient = {
  email: string;
  role: "owner" | "billing";
  /** Null only for the provisioning fallback, which has no user row. */
  userId: string | null;
};

export async function billingRecipients(
  tx: TenantTx,
  kind?: NoticeKind,
): Promise<BillingRecipient[]> {
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
  if (seeded.length > 0) {
    return seeded.map((row) => ({
      email: row.email.trim().toLowerCase(),
      role: "owner" as const,
      userId: null,
    }));
  }

  if (!kind || !OWED_AFTER_CLOSURE.has(kind)) return [];
  const [closed] = await tx.db
    .select({ address: clinics.noticeAddress })
    .from(clinics)
    .where(
      and(
        eq(clinics.id, tx.clinicId),
        isNotNull(clinics.accountClosedAt),
        gt(clinics.noticeAddressUntil, sql`clock_timestamp()`),
      ),
    )
    .limit(1);
  return closed?.address ? [{ email: closed.address, role: "owner" as const, userId: null }] : [];
}
