import { eq } from "drizzle-orm";

import { clinics } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { withTenant, type TenantTx } from "@/lib/tenant";

/**
 * Which clinic pays for this one (owner decision 2, design §3.12).
 *
 * A clinic bought at checkout is its own billing clinic. A location added
 * later is a clinic of its own (its own calendar, number, transcripts) whose
 * `billing_clinic_id` points at the clinic holding the subscription: its usage
 * counts against that clinic's pooled allowance, its billing state is that
 * clinic's entitlements row, and its billing emails go to that clinic's
 * owners. Everything that touches money therefore starts by resolving the
 * billing clinic, and this module is the one place that does it.
 */

/**
 * The billing clinic of the tenant `tx` is open on. Reads the tenant's own
 * clinics row (visible under the clinics policy), so it needs no definer
 * function. A clinic with no row visible (deleted mid-request) resolves to
 * itself, which makes every later read come back empty rather than wrong.
 */
export async function resolveBillingClinicId(tx: TenantTx): Promise<string> {
  const [row] = await tx.db
    .select({ billingClinicId: clinics.billingClinicId })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  return row?.billingClinicId ?? tx.clinicId;
}

/**
 * Run `fn` inside the tenant of the clinic that pays for `clinicId`.
 *
 * Two transactions, not one: the tenant setting is per transaction, and
 * switching it mid-transaction would let one block read two clinics' rows.
 * The first transaction only reads the location's own clinics row; `fn` runs
 * entirely inside the billing clinic's tenant.
 */
export async function withBillingTenant<T>(
  clinicId: string,
  actor: ActorContext,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  const billingClinicId = await withTenant({ clinicId, actor }, (tx) => resolveBillingClinicId(tx));
  return withTenant({ clinicId: billingClinicId, actor }, fn);
}
