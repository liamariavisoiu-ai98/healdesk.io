import { eq } from "drizzle-orm";

import { clinics, clinicSettings } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { getDepositSettings } from "@/lib/billing/deposits";
import { getBillingSummary } from "@/lib/billing/summary";
import { getCalendarConnection } from "@/lib/connections/google-calendar";
import { isUndeliverable } from "@/lib/email/events";
import { readPracticeState } from "@/lib/engine/practice/store";
import { readSetupState, type SetupState } from "@/lib/setup/state";
import { withTenant } from "@/lib/tenant";

import { accountStateFrom, type AccountState } from "./account-state";

/**
 * get_account_state's reader: the clinic's setup state, where its practice
 * questions stand (readPracticeState, the reader Home and Talk to your AYA
 * ask, so the chat's tracker is Home's), its pause, its carrier and phone
 * system, its deposit switch and payment account, and whether its address
 * takes mail, in one tenant transaction; then its
 * calendar connection and billing summary, each through its own reader. A
 * reader that fails leaves its facts out (a calendar or a summary of null)
 * rather than failing the chat. Business data only.
 */

/** What the support chat and the escalation read for clinic `clinicId`. Null for a clinic that is not there. */
export async function readAccountState(input: {
  clinicId: string;
  userId: string;
  actor: ActorContext;
  now?: Date;
}): Promise<{ account: AccountState; state: SetupState } | null> {
  const now = input.now ?? new Date();
  const read = await withTenant({ clinicId: input.clinicId, actor: input.actor }, async (tx) => {
    const state = await readSetupState(tx, { userId: input.userId, now });
    if (!state) return null;
    const [clinic] = await tx.db
      .select({ carrier: clinics.carrier, phoneSystem: clinics.phoneSystemType })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    const [pause] = await tx.db
      .select({ pausedAt: clinicSettings.aiPausedAt, pausedUntil: clinicSettings.aiPausedUntil })
      .from(clinicSettings)
      .where(eq(clinicSettings.clinicId, tx.clinicId))
      .limit(1);
    const deposits = await getDepositSettings(tx);
    const undeliverable = state.address ? await isUndeliverable(tx, state.address) : false;
    const practice = await readPracticeState(tx);
    return { state, clinic, pause, deposits, undeliverable, practice };
  });
  if (!read) return null;

  const calendar = await getCalendarConnection(input.clinicId, { actor: input.actor }).catch(
    () => null,
  );
  const summary = read.state.billing
    ? await getBillingSummary(input.clinicId, { now }).catch(() => null)
    : null;
  const account = accountStateFrom({
    state: read.state,
    carrier: read.clinic?.carrier ?? null,
    phoneSystem: read.clinic?.phoneSystem ?? null,
    pausedAt: read.pause?.pausedAt ?? null,
    pausedUntil: read.pause?.pausedUntil ?? null,
    depositsOn: read.deposits.depositsEnabled,
    paymentConnected: read.deposits.isConnected,
    calendar,
    practice: read.practice,
    summary,
    addressUndeliverable: read.undeliverable,
    now,
  });
  return { account, state: read.state };
}
