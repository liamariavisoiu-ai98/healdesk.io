import { sql } from "drizzle-orm";

import { describeError, log } from "@/lib/log";
import { withTenant } from "@/lib/tenant";

import { availabilityAttention, clinicAuditsOn, readClinicAuditFacts } from "../audit-ops";
import { listClinics } from "../clinics";

import type { InboxRow, InboxSource } from "./types";

/**
 * Availability that needs a look (design E3; lane A4): one row per clinic
 * when, of the availability packs only (AVAILABILITY_PACKS; go-live fails for
 * every clinic not yet in production and is not about availability):
 *   - a change was made that nobody will audit (written while the
 *     clinic-audits job was off, after the last availability audit);
 *   - the latest result failed, or warned about something a change brought
 *     (a warning setup itself leaves, with no change since the last pass, is
 *     not one);
 *   - changes have gone more than a day without anyone marking them seen.
 * The rule is audit-ops.ts's availabilityAttention, which the Clinics
 * column's level shares. The most serious reason wins; the button opens the
 * clinic's Setup page at its Availability card.
 *
 * Each clinic is read in its own tenant; one that cannot be read makes this
 * source partial. healdesk's demo clinic, and clinics closed, destroyed or
 * offboarding, have nothing for ops to fix and get no row.
 */

/** A change nobody has marked seen for this long is owed a look. */
export const UNSEEN_AFTER_MS = 24 * 60 * 60 * 1000;

export const AVAILABILITY_WORDS = {
  fail: "The latest availability audit failed; the failing check is listed on the Setup page.",
  warn: "A change brought an availability audit warning; the check is listed on the Setup page.",
  audits_off: "Availability changed while the audits are switched off, so nobody has checked it.",
  unseen: "Availability changes older than a day are not yet marked as seen.",
} as const;

export function availabilityHref(clinicId: string): string {
  return `/admin/clinics/${clinicId.toLowerCase()}/setup#availability`;
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
            const own = await tx.db.execute<{ demo: boolean; closed: boolean; unseen: number }>(sql`
              select app_clinic_is_demo(${tx.clinicId}) as demo,
                     exists (select 1 from clinics c where c.id = ${tx.clinicId} and c.account_closed_at is not null) as closed,
                     (select count(*)::int from clinic_change_events e
                       where e.clinic_id = ${tx.clinicId} and e.ops_acknowledged_at is null
                         and e.kind <> 'setting'
                         and e.changed_at < ${cutoff}) as unseen
            `);
            const flags = own.rows[0];
            if (!flags || flags.demo || flags.closed) return null;
            return { facts: await readClinicAuditFacts(tx, auditsOn), unseen: Number(flags.unseen ?? 0) };
          },
        );
        if (!read) continue;
        const reason = availabilityAttention(read.facts) ?? (read.unseen > 0 ? "unseen" : null);
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
