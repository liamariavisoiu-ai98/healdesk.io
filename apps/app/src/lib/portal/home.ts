import { eq } from "drizzle-orm";

import { clinics } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { isUndeliverable } from "@/lib/email/events";
import { withTenant } from "@/lib/tenant";

/**
 * The facts Home's "Needs attention" reads beyond the setup state, in one
 * tenant transaction: whether the clinic's one address has bounced (Annex
 * X3), and whether its Stripe account was disconnected and nothing replaced
 * it. Both are about the practice's account; neither touches a patient.
 */
export type HomeFacts = {
  addressUndeliverable: boolean;
  paymentAccountDisconnected: boolean;
  /** The drift check's unconfirmed website changes (M7); always 0 until it exists. */
  websiteChanges: number;
};

export async function readHomeFacts(input: {
  clinicId: string;
  address: string | null;
  actor: ActorContext;
}): Promise<HomeFacts> {
  return withTenant({ clinicId: input.clinicId, actor: input.actor }, async (tx) => {
    const undeliverable = input.address ? await isUndeliverable(tx, input.address) : false;
    const [clinic] = await tx.db
      .select({
        accountId: clinics.stripeConnectAccountId,
        disconnectedAt: clinics.stripeConnectDisconnectedAt,
      })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    return {
      addressUndeliverable: undeliverable,
      paymentAccountDisconnected: Boolean(clinic && !clinic.accountId && clinic.disconnectedAt),
      // M7 seam: the drift list (plan Part F3, "Changes on your website") is
      // read here once it exists.
      websiteChanges: 0,
    };
  });
}
