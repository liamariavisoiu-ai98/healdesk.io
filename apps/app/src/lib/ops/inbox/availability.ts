import { and, eq, isNull, lt, sql } from "drizzle-orm";

import { clinicChangeEvents } from "@/db/schema";
import { describeError, log } from "@/lib/log";
import { withTenant } from "@/lib/tenant";

import { auditOverall, clinicAuditsOn, readClinicAuditFacts, type AuditOverall } from "../audit-ops";
import { listClinics } from "../clinics";

import type { InboxRow, InboxSource } from "./types";

/**
 * Availability that needs a look (design E3; lane A4): one row per clinic
 * whose latest audit says warn or fail, whose changes wait with nobody
 * checking them (the clinic-audits job switched off), or whose changes have
 * gone more than a day without anyone marking them seen. The audit state is
 * the console's own rule (auditOverall), so Home, the Clinics table and the
 * clinic's Setup page agree. One row per clinic, the most serious reason
 * first; the button opens the clinic's Setup page at its Availability card.
 *
 * Each clinic is read in its own tenant; one that cannot be read makes this
 * source partial, never a clinic left out in silence. Closed, destroyed and
 * offboarding clinics have nothing left to fix and are not read.
 */

/** A change nobody has marked seen for this long is owed a look. */
export const UNSEEN_AFTER_MS = 24 * 60 * 60 * 1000;

export const AVAILABILITY_WORDS = {
  fail: "The latest audit failed; the failing check is listed on the Setup page.",
  warn: "The latest audit found a check to look at on the Setup page.",
  audits_off: "Availability changed while the audits are switched off, so nobody has checked it.",
  unseen: "Availability changes older than a day are not yet marked as seen.",
} as const;

export function availabilityHref(clinicId: string): string {
  return `/admin/clinics/${clinicId.toLowerCase()}/setup#availability`;
}

/** The row's reason, the most serious first, or null when nothing is owed. */
export function availabilityReason(
  overall: AuditOverall,
  unseen: number,
): keyof typeof AVAILABILITY_WORDS | null {
  if (overall === "fail" || overall === "warn" || overall === "audits_off") return overall;
  return unseen > 0 ? "unseen" : null;
}

export const availabilitySource: InboxSource = {
  name: "the availability audits",
  async read(ctx) {
    const clinics = (await listClinics()).filter(
      (c) => c.destroyedAt === null && c.offboardingStartedAt === null,
    );
    const auditsOn = await clinicAuditsOn();
    const cutoff = new Date(ctx.now.getTime() - UNSEEN_AFTER_MS);
    const rows: InboxRow[] = [];
    let failed = 0;
    for (const clinic of clinics) {
      try {
        const read = await withTenant(
          { clinicId: clinic.id, actor: ctx.actor, request: ctx.request },
          async (tx) => {
            const facts = await readClinicAuditFacts(tx);
            const [unseen] = await tx.db
              .select({ n: sql<number>`count(*)::int` })
              .from(clinicChangeEvents)
              .where(
                and(
                  eq(clinicChangeEvents.clinicId, tx.clinicId),
                  isNull(clinicChangeEvents.opsAcknowledgedAt),
                  lt(clinicChangeEvents.changedAt, cutoff),
                ),
              );
            return { facts, unseen: Number(unseen?.n ?? 0) };
          },
        );
        const overall = auditOverall({
          pending: read.facts.pending,
          auditsOn,
          latest: read.facts.latest.map((r) => r.result),
        });
        const reason = availabilityReason(overall, read.unseen);
        if (!reason) continue;
        rows.push({
          id: `availability:${clinic.id}`,
          kind: "availability",
          count: reason === "unseen" ? read.unseen : 1,
          sentence: AVAILABILITY_WORDS[reason],
          clinic: { id: clinic.id, name: clinic.name },
          button: { label: "Open availability", kind: "link", href: availabilityHref(clinic.id) },
          tone: "warn",
          dueAt: null,
        });
      } catch (error) {
        failed += 1;
        log.warn("ops inbox availability not read", { clinicId: clinic.id, error: describeError(error) });
      }
    }
    return { rows, partial: failed > 0 ? `${failed} clinic(s) could not be read.` : undefined };
  },
};
