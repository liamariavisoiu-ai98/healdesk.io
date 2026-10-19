import { sql } from "drizzle-orm";

import type { AgreementResignReason } from "@/db/schema";
import type { TenantTx } from "@/lib/tenant";

/**
 * Whether a re-sign holds AYA paused (lib/agreements/resign.ts): the one rule
 * the header's switch (lib/channels/pause.ts), L22, Billing and the re-sign
 * screen all read, so none of them can say AYA is paused while the header
 * lets her answer, or the reverse. The rule is `resignHoldsPause`, a pure
 * function, and the one place it is decided.
 *
 * A re-sign is the organisation's, since the agreement is, so the rule is
 * asked of every open re-sign of the clinic's organisation, read through a
 * definer (app_organisation_open_resigns, drizzle/0098): a location cannot
 * see its account's re-sign under the tenant policy, and its own header and
 * answer gate must hold to it as the account's do.
 */

/** An open re-sign of the clinic's organisation, any location's. */
export type OrganisationResign = {
  resignId: string;
  clinicId: string;
  reason: AgreementResignReason;
  pausedAt: Date | null;
  startedAt: Date;
  /** The version of the agreement it replaces, and whether go-live still accepts it. */
  fromVersion: string | null;
  fromVersionAcceptable: boolean;
};

/**
 * The rule. A re-sign holds AYA paused when it replaces a Data Protection
 * Agreement (`now_covered`, `not_sure`): from the answer that opened it no
 * agreement covers the practice, and app_clinic_accepts_phi() refuses its
 * data, so a practice that now bills insurance electronically has its BAA
 * before AYA answers again (WP9). It does so at every location of the
 * organisation, whose answer gate each reads its own pause.
 *
 * A re-sign of a newer BAA over an older one (`baa_version`) never pauses AYA
 * (owner, 19 October 2026). The version signed governs until the newer one
 * is signed (the BAA's Notices and interpretation clause: the later version
 * "replaces any earlier version of it ... from the effective date forward",
 * and healdesk cannot amend it alone), so the practice keeps AYA answering
 * under it. The signature is chased instead, while BAA-version re-signs are
 * switched on (BAA_VERSION_RESIGNS_READY): L22 and its reminders at 3 and 7
 * days, and ops told at 7 days, separately when the version is below the
 * floor go-live accepts, to phone the practice (lib/agreements/resign.ts).
 */
export function resignHoldsPause(resign: Pick<OrganisationResign, "reason">): boolean {
  return resign.reason !== "baa_version";
}

/** The open re-signs of the clinic's organisation, through app_organisation_open_resigns. */
export async function organisationOpenResigns(tx: TenantTx): Promise<OrganisationResign[]> {
  const result = await tx.db.execute<{
    resign_id: string;
    clinic_id: string;
    reason: AgreementResignReason;
    paused_at: Date | string | null;
    started_at: Date | string;
    from_version: string | null;
    from_version_acceptable: boolean;
  }>(sql`select * from app_organisation_open_resigns(${tx.clinicId}::uuid)`);
  return result.rows.map((r) => ({
    resignId: r.resign_id,
    clinicId: r.clinic_id,
    reason: r.reason,
    pausedAt: r.paused_at === null ? null : new Date(r.paused_at),
    startedAt: new Date(r.started_at),
    fromVersion: r.from_version,
    fromVersionAcceptable: r.from_version_acceptable === true,
  }));
}

/** Whether any open re-sign of the clinic's organisation holds AYA paused at this clinic. */
export async function openResignHoldsPause(tx: TenantTx): Promise<boolean> {
  return (await organisationOpenResigns(tx)).some(resignHoldsPause);
}
