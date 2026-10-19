import { sql } from "drizzle-orm";

import type { TenantTx } from "@/lib/tenant";

/**
 * Whether the clinic's open re-sign holds AYA paused (lib/agreements/
 * resign.ts): the one rule the header's switch (lib/channels/pause.ts), L22
 * and the re-sign screen all read, so none of them can say AYA is paused
 * while the header lets her answer, or the reverse.
 *
 * It does when:
 *
 *   - the re-sign replaces a Data Protection Agreement (`now_covered`,
 *     `not_sure`): from the answer that opened it no agreement covers the
 *     practice, and app_clinic_accepts_phi() refuses its data;
 *   - or the re-sign put a pause on AYA (`paused_at`), opening or since;
 *   - or it replaces a BAA whose version go-live no longer accepts
 *     (app_baa_version_acceptable, below the floor a release raised) at a
 *     clinic AYA answers patients for (production). Under the BAA's own
 *     terms the version signed governs until a later one is signed ("This
 *     agreement replaces any earlier version of it ... from the effective
 *     date forward"; healdesk cannot amend it alone), and a release raises
 *     the floor only when the older text no longer says what the product
 *     does, so AYA does not answer under it. A pause the practice set itself
 *     before the re-sign opened (paused_at stays NULL) is held by this rule
 *     too, and stays the practice's own when the agreement is signed.
 *
 * A re-sign on a BAA version go-live still accepts (the broadcast's, during
 * a release overlap) holds nothing: the practice signs when it is ready, and
 * the header works as always. Inside the clinic's tenant: every table read
 * is the tenant's own.
 */
export async function openResignHoldsPause(tx: TenantTx): Promise<boolean> {
  const result = await tx.db.execute<{ holds: boolean }>(sql`
    select exists (
      select 1
        from agreement_resigns r
        join clinics c on c.id = r.clinic_id
        left join baa_acceptances b on b.id = r.from_agreement_id
       where r.clinic_id = ${tx.clinicId}
         and r.status = 'open'
         and (r.reason <> 'baa_version'
              or r.paused_at is not null
              or (c.data_classification = 'production'
                  and not coalesce(app_baa_version_acceptable(b.document_version), false)))
    ) as holds`);
  return result.rows[0]?.holds === true;
}
