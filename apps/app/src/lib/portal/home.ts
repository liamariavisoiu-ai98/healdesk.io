import { eq } from "drizzle-orm";

import { clinics } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { isUndeliverable } from "@/lib/email/events";
import type { PracticeState } from "@/lib/engine/practice/state";
import { readPracticeState } from "@/lib/engine/practice/store";
import { withTenant } from "@/lib/tenant";

/**
 * The facts Home's "Needs attention" reads beyond the setup state, in one
 * tenant transaction: whether the clinic's one address has bounced (Annex
 * X3), whether its Stripe account was disconnected and nothing replaced
 * it, and where its practice questions stand (lib/engine/practice). All are
 * about the practice's account; none touches a patient.
 */
export type HomeFacts = {
  addressUndeliverable: boolean;
  paymentAccountDisconnected: boolean;
  /** The drift check's unconfirmed website changes (M7); always 0 until it exists. */
  websiteChanges: number;
  /** Where the practice questions stand: the tracker's last two stages and "double-checking". */
  practice: PracticeState;
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
      practice: await readPracticeState(tx),
    };
  });
}
