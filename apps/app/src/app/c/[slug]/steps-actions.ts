"use server";

import { readPhoneStepsNumber } from "@/lib/channels/state";
import { sendStepsOn } from "@/lib/notices/steps-sent";
import { requirePortal } from "@/lib/portal/access";
import { portalActor } from "@/lib/portal/actor";
import { withTenant } from "@/lib/tenant";

/**
 * O11 from the portal (spec, "The forwarding step, treated properly" and
 * "send this to my web person"; Annex X5): a channel's one step, to the one
 * address typed, from Settings → Channels and the wizard's channel screen.
 *
 *   - phone, "Email these steps to my office manager": the clinic's
 *     call-forwarding steps, with AYA's number, read here because it exists
 *     only once phone is ready on our side;
 *   - website chat, "Email to my web person": the line to paste, which
 *     lib/notices/steps-sent.ts sends only once the channel is open.
 *
 * lib/notices/steps-sent.ts words both, limits them to three a day per clinic
 * and honours each address's stop link; this checks the sign-in.
 *
 * Business contact data only: an address the clinic chose, and the
 * practice's own phone steps or website line.
 */

export type StepsActionResult = { ok: boolean; message: string };

/** The channels with a step someone else can take. */
export type StepsChannel = "voice" | "web";

export async function sendStepsAction(
  slug: string,
  channel: StepsChannel,
  to: string,
): Promise<StepsActionResult> {
  const portal = await requirePortal(String(slug));
  // A server action's arguments come from the browser: anything else is refused.
  if (channel !== "voice" && channel !== "web") {
    return { ok: false, message: "There's nothing to send for that." };
  }
  return sendFor(portal, channel, to);
}

/** "Email these steps to my office manager": phone's, as the forwarding screens call it. */
export async function sendPhoneStepsAction(slug: string, to: string): Promise<StepsActionResult> {
  return sendFor(await requirePortal(String(slug)), "voice", to);
}

async function sendFor(
  portal: Awaited<ReturnType<typeof requirePortal>>,
  channel: StepsChannel,
  to: string,
): Promise<StepsActionResult> {
  const actor = await portalActor(portal);
  const context = { type: "user" as const, userId: portal.userId, label: actor.label };
  const ayaNumberE164 =
    channel === "voice"
      ? await withTenant({ clinicId: portal.clinicId, actor: context }, (tx) =>
          readPhoneStepsNumber(tx.db, tx.clinicId),
        )
      : null;
  const result = await sendStepsOn({
    clinicId: portal.clinicId,
    channel,
    to: String(to ?? ""),
    actor: context,
    ayaNumberE164,
  });
  return result.status === "sent"
    ? { ok: true, message: `Sent to ${result.to}.` }
    : { ok: false, message: result.message };
}
