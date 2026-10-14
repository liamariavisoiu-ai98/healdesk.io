"use server";

import { readPhoneStepsNumber } from "@/lib/channels/state";
import { sendStepsOn } from "@/lib/notices/steps-sent";
import { requirePortal } from "@/lib/portal/access";
import { portalActor } from "@/lib/portal/actor";
import { withTenant } from "@/lib/tenant";

/**
 * "Email these steps to my office manager" (spec, "The forwarding step,
 * treated properly"; Annex X5, O11), from Settings → Channels and the
 * wizard's channel screen: the clinic's call-forwarding steps, with AYA's
 * number, to the one address typed. lib/notices/steps-sent.ts words it,
 * limits it to three a day and honours the address's stop link; this checks
 * the sign-in and reads AYA's number, which exists only once phone is ready
 * on our side. Website chat's line joins when the widget's snippet exists.
 *
 * Business contact data only: an address the clinic chose, and the
 * practice's own phone steps.
 */

export type StepsActionResult = { ok: boolean; message: string };

export async function sendPhoneStepsAction(slug: string, to: string): Promise<StepsActionResult> {
  const portal = await requirePortal(String(slug));
  const actor = await portalActor(portal);
  const context = { type: "user" as const, userId: portal.userId, label: actor.label };
  const ayaNumberE164 = await withTenant({ clinicId: portal.clinicId, actor: context }, (tx) =>
    readPhoneStepsNumber(tx.db, tx.clinicId),
  );
  const result = await sendStepsOn({
    clinicId: portal.clinicId,
    channel: "voice",
    to: String(to ?? ""),
    actor: context,
    ayaNumberE164,
  });
  return result.status === "sent"
    ? { ok: true, message: `Sent to ${result.to}.` }
    : { ok: false, message: result.message };
}
