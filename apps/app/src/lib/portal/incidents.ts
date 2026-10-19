import { and, asc, eq, isNotNull } from "drizzle-orm";

import { contacts, incidentAffectedContacts, incidents } from "@/db/schema";
import { countAffected, UUID } from "@/lib/incidents/affected";

import {
  logPatientAccess,
  MAX_PATIENT_IDS_PER_ROW,
  withPatientPage,
  type PatientPage,
} from "./patient-page";

/**
 * The incident's page in the portal (app/c/[slug]/incidents/[id]; plan Annex
 * X5, L29; wave 2 R11): the list of who an incident affected, which the
 * report never carries (lib/incidents/affected.ts says why and how it is
 * recorded). A patient page: it reads only behind requirePatientPage, and
 * writes one access row naming every contact shown.
 */

/** The page shows this many people at a time: an access row names every one shown, at most 1,000. */
export const AFFECTED_PAGE_SIZE = 500;

/** One person on the list: the contact's id and what healdesk holds of them, nothing more. */
export type AffectedPerson = {
  contactId: string;
  fullName: string | null;
  phone: string | null;
  email: string | null;
};

export type AffectedListView = {
  incidentId: string;
  class: "breach" | "security_incident" | "improper_use_or_disclosure";
  discoveredAt: string;
  reportedAt: string;
  total: number;
  /** From 1. */
  page: number;
  pages: number;
  people: AffectedPerson[];
};

/**
 * The list for the incident's page, behind the passkey step-up: one access
 * row naming every contact shown (or the incident, when it names no one
 * yet), in the transaction that reads them. Null for an id this clinic does
 * not hold, an incident no agreement reports, or one no report has gone
 * about yet; the open is logged all the same.
 */
export async function readAffectedList(
  page: PatientPage,
  incidentId: string,
  pageNumber = 1,
): Promise<AffectedListView | null> {
  if (!UUID.test(incidentId)) return null;
  const at = Number.isInteger(pageNumber) && pageNumber >= 1 ? pageNumber : 1;
  return withPatientPage(page, async (tx) => {
    const [incident] = await tx.db
      .select({
        id: incidents.id,
        class: incidents.class,
        discoveredAt: incidents.discoveredAt,
        reportedAt: incidents.reportedAt,
      })
      .from(incidents)
      .where(
        and(
          eq(incidents.id, incidentId),
          eq(incidents.clinicId, tx.clinicId),
          isNotNull(incidents.reportedAt),
        ),
      )
      .limit(1);
    if (!incident || incident.class === "service_complaint" || !incident.reportedAt) {
      await logPatientAccess(tx, {
        action: "read",
        resourceType: "incident_affected",
        resourceId: incidentId,
      });
      return null;
    }
    const total = await countAffected(tx, incident.id);
    const pages = Math.max(1, Math.ceil(total / AFFECTED_PAGE_SIZE));
    const shown = Math.min(at, pages);
    const people = await tx.db
      .select({
        contactId: contacts.id,
        fullName: contacts.fullName,
        phone: contacts.phone,
        email: contacts.email,
      })
      .from(incidentAffectedContacts)
      .innerJoin(
        contacts,
        and(
          eq(contacts.id, incidentAffectedContacts.contactId),
          eq(contacts.clinicId, incidentAffectedContacts.clinicId),
        ),
      )
      .where(
        and(
          eq(incidentAffectedContacts.clinicId, tx.clinicId),
          eq(incidentAffectedContacts.incidentId, incident.id),
        ),
      )
      .orderBy(asc(incidentAffectedContacts.recordedAt), asc(contacts.id))
      .limit(Math.min(AFFECTED_PAGE_SIZE, MAX_PATIENT_IDS_PER_ROW))
      .offset((shown - 1) * AFFECTED_PAGE_SIZE);
    await logPatientAccess(
      tx,
      people.length > 0
        ? {
            action: "read",
            resourceType: "incident_affected",
            resourceIds: people.map((p) => p.contactId),
          }
        : { action: "read", resourceType: "incident_affected", resourceId: incident.id },
    );
    return {
      incidentId: incident.id,
      class: incident.class,
      discoveredAt: incident.discoveredAt.toISOString(),
      reportedAt: incident.reportedAt.toISOString(),
      total,
      page: shown,
      pages,
      people,
    };
  });
}
