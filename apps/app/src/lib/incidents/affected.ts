import { and, eq, inArray, sql } from "drizzle-orm";

import { contacts, incidentAffectedContacts, incidents } from "@/db/schema";
import type { TenantTx } from "@/lib/tenant";

/**
 * Who an incident affected (plan Annex X5, L29: "The list of individuals is
 * never emailed. It sits on a page behind step-up."; wave 2 R11).
 *
 * The agreements' Safeguards clause promises the list "travels by secure
 * transfer, never in the email itself", and the Reporting clause that a
 * breach report identifies each individual (45 CFR 164.410(c)(1)). The
 * report (L29, lib/notices/operator-notices.ts) is built from fixed fields
 * and names no one; for a breach it points to the incident's page in the
 * clinic portal (app/c/[slug]/incidents/[id]), which reads the list through
 * lib/portal/incidents.ts. The page is the secure transfer: TLS to the practice's own sign-in,
 * a passkey step-up, and an access row naming every contact shown.
 *
 * The operator records the list from the app's own shell, by contact id only
 * (scripts/ops-incident-affected.ts; lib/incidents/affected-entry.ts), never
 * through apps/web: a list of who a breach affected is patient information.
 * What the page shows for each is the contact's id and the contact fields
 * healdesk holds (a name, a number, an address, each where healdesk has it),
 * and nothing more: no conversation, no booking, no words. A contact deleted
 * since (an erasure, the record clock, destruction) is gone from the list
 * with it, through the foreign key's cascade: healdesk then holds nothing of
 * them to give.
 *
 * The practice sees the list only once a report about the incident has gone
 * (`reported_at`): nothing reaches a clinic unless ops sends it.
 */

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AffectedListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AffectedListError";
  }
}

/** The incident, in the caller's tenant, if an agreement reports it. */
async function reportableIncident(tx: TenantTx, incidentId: string) {
  const [row] = await tx.db
    .select({ id: incidents.id, class: incidents.class, reportedAt: incidents.reportedAt })
    .from(incidents)
    .where(and(eq(incidents.id, incidentId), eq(incidents.clinicId, tx.clinicId)))
    .limit(1);
  return row ?? null;
}

export type AffectedChange = {
  /** Contacts put on the list (adding), or taken off it (removing). */
  changed: number;
  /** Contacts already on it (adding), or not on it (removing): nothing changed for them. */
  unchanged: number;
  /** How many the list names now. */
  total: number;
};

/**
 * Put contacts on an incident's list, or take ones named in error off it,
 * inside the clinic's tenant. Every id must be a contact of this clinic, and
 * the incident one an agreement reports (not a service complaint), or
 * nothing is written. Writes one audit row with the counts.
 */
export async function changeAffectedContacts(
  tx: TenantTx,
  input: {
    incidentId: string;
    contactIds: readonly string[];
    action: "add" | "remove";
    recordedBy: string;
  },
): Promise<AffectedChange> {
  if (!UUID.test(input.incidentId)) throw new AffectedListError("An incident's id is a uuid.");
  const ids = [...new Set(input.contactIds.map((id) => id.trim().toLowerCase()))];
  if (ids.length === 0) throw new AffectedListError("Name at least one contact, by its id.");
  if (!ids.every((id) => UUID.test(id))) throw new AffectedListError("A contact's id is a uuid.");
  const incident = await reportableIncident(tx, input.incidentId);
  if (!incident) throw new AffectedListError("No such incident at this clinic.");
  if (incident.class === "service_complaint") {
    throw new AffectedListError(
      "A service complaint is no agreement's to report: it affects no one on this list.",
    );
  }

  let added = 0;
  if (input.action === "add") {
    const known = await tx.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.clinicId, tx.clinicId), inArray(contacts.id, ids)));
    if (known.length !== ids.length) {
      throw new AffectedListError(
        `${ids.length - known.length} of those ids ${ids.length - known.length === 1 ? "is" : "are"} not a contact of this clinic. Nothing was recorded.`,
      );
    }
    const inserted = await tx.db
      .insert(incidentAffectedContacts)
      .values(
        ids.map((contactId) => ({
          clinicId: tx.clinicId,
          incidentId: incident.id,
          contactId,
          recordedBy: input.recordedBy.slice(0, 320),
        })),
      )
      .onConflictDoNothing()
      .returning({ contactId: incidentAffectedContacts.contactId });
    added = inserted.length;
  } else {
    const removed = await tx.db
      .delete(incidentAffectedContacts)
      .where(
        and(
          eq(incidentAffectedContacts.clinicId, tx.clinicId),
          eq(incidentAffectedContacts.incidentId, incident.id),
          inArray(incidentAffectedContacts.contactId, ids),
        ),
      )
      .returning({ contactId: incidentAffectedContacts.contactId });
    added = -removed.length;
  }
  const total = await countAffected(tx, incident.id);
  const changed = Math.abs(added);
  tx.audit.record({
    action: input.action === "add" ? "create" : "delete",
    resourceType: "incident_affected_contacts",
    resourceId: incident.id,
    resultCount: changed,
    metadata: { action: input.action, changed, unchanged: ids.length - changed, total },
  });
  return { changed, unchanged: ids.length - changed, total };
}

/** How many contacts an incident's list names. */
export async function countAffected(tx: TenantTx, incidentId: string): Promise<number> {
  const [row] = await tx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(incidentAffectedContacts)
    .where(
      and(
        eq(incidentAffectedContacts.clinicId, tx.clinicId),
        eq(incidentAffectedContacts.incidentId, incidentId),
      ),
    );
  return row?.n ?? 0;
}

/** The incident page's path in the portal: what L29 points to. */
export function incidentPagePath(slug: string, incidentId: string): string {
  return `/c/${slug}/incidents/${incidentId}`;
}
