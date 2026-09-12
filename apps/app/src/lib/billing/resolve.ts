import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";

/**
 * Which clinic a Stripe event belongs to.
 *
 * This is one of the few legitimate uses of `unsafeDb` outside auth and
 * migrations, and it exists for the same reason provisioning's does: there is
 * no tenant yet. A webhook arrives holding a customer id and a subscription
 * id, and the tenant is exactly what it needs to find out. `entitlements` is
 * under RLS, so a query through withTenant() would need the answer before it
 * could ask the question.
 *
 * The lookup is therefore a SECURITY DEFINER function (drizzle/0028) that
 * returns one uuid and nothing else. Nothing about the clinic reaches the
 * caller; the returned id is then used to open a proper tenant transaction
 * and every subsequent read and write is filtered as usual.
 */
export async function clinicIdForStripe(
  customerId?: string | null,
  subscriptionId?: string | null,
): Promise<string | null> {
  if (!customerId && !subscriptionId) return null;

  const result = await unsafeDb.execute<{ clinic_id: string | null }>(
    sql`select app_clinic_for_stripe(${customerId ?? null}::text, ${subscriptionId ?? null}::text) as clinic_id`,
  );
  return result.rows[0]?.clinic_id ?? null;
}
