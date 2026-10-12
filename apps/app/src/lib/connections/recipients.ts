import { and, eq, isNull } from "drizzle-orm";

import { user } from "@/db/auth-schema";
import { clinicMemberships, reportRecipients } from "@/db/schema";
import type { TenantTx } from "@/lib/tenant";

/**
 * Who receives a location's calendar mail: the links that connect its Google
 * Calendar, the owner's change and confirm links, and the notices about the
 * connection (plan §4.1, §9.4).
 *
 * A calendar link is a capability (plan risk 13), so it goes only to the
 * practice's own address, and never to an arbitrary one, a front-desk
 * report list or anything a caller passes in. And v1 has exactly one such
 * address: one email address per clinic, which is its only sign-in, its
 * billing address, the agreement's notice address and where every
 * notification goes (CLAUDE.md, "The clinic portal"; the funnel and portal
 * contract of 6 October 2026). So calendarRecipients() and ownerRecipients()
 * resolve to the same thing: the address of the location's active `owner`
 * membership, the one sign-in provisioning creates, which is the address
 * billingRecipients() resolves for a clinic bought at checkout. They stay two
 * functions because the plan's roles (owner, manager, billing contact) are
 * deferred, not dropped: when they return, calendar mail widens to the
 * managers and the owner's links stay the owner's.
 *
 * One fallback, as billingRecipients() has: a location provisioned before
 * provisioning created its sign-in has no membership, and then the buyer's
 * own address, which provisioning seeded into report_recipients
 * (`added_by = 'provisioning'`), is the practice's address. No other report
 * recipient ever is.
 *
 * Read in the location's own tenant: a location's memberships are its rows,
 * and one with none of its own gets nothing rather than another clinic's
 * address. Lower-cased and de-duplicated, which is the form a link's
 * `sent_to` records.
 */

export async function calendarRecipients(tx: TenantTx): Promise<string[]> {
  return practiceAddresses(tx);
}

export async function ownerRecipients(tx: TenantTx): Promise<string[]> {
  return practiceAddresses(tx);
}

async function practiceAddresses(tx: TenantTx): Promise<string[]> {
  const owners = await tx.db
    .select({ email: user.email })
    .from(clinicMemberships)
    .innerJoin(user, eq(user.id, clinicMemberships.userId))
    .where(
      and(
        eq(clinicMemberships.clinicId, tx.clinicId),
        eq(clinicMemberships.role, "owner"),
        isNull(clinicMemberships.revokedAt),
      ),
    );
  const fromOwners = normalised(owners.map((row) => row.email));
  if (fromOwners.length > 0) return fromOwners;

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
  return normalised(seeded.map((row) => row.email));
}

function normalised(addresses: readonly string[]): string[] {
  const out = new Set<string>();
  for (const address of addresses) {
    const email = address.trim().toLowerCase();
    if (email) out.add(email);
  }
  return [...out].sort();
}
