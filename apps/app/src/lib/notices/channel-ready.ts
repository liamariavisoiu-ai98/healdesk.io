import { isCarrier, type Channel } from "@healdesk/catalog";
import { and, eq } from "drizzle-orm";

import { clinicChannels, clinics } from "@/db/schema";
import { isWaitingOnReadyStep } from "@/lib/email/superseded";
import { describeError, log } from "@/lib/log";
import { publicOriginProblem, publicUrl } from "@/lib/public-url";
import { emailCallUrl, helpContacts } from "@/lib/setup/help";
import { readSetupSettings } from "@/lib/setup/settings";
import type { TenantTx } from "@/lib/tenant";

import { enqueuePlanNotice } from "./plan-notices";

/**
 * O10, "{Channel} is ready: one step left" (Annex X5): queued for a channel
 * that is ready on our side and still waiting on the clinic an hour after it
 * became ready, keyed on the channel and its readiness, so each readiness is
 * one email however often this is asked.
 *
 * Its caller is lib/channels/events.ts, in the transaction that records
 * phone ready on our side and waiting on the clinic's forwarding. It queues
 * the notice then, due an hour after readiness (`sendAfter`), with AYA's
 * number, which readiness requires; the outbox asks again when it is due
 * whether phone is still waiting on that step (lib/email/superseded.ts), so
 * a step done within the hour sends nothing. Website chat and the Meta
 * channels join when their step exists (lib/email/templates/channel_ready.ts).
 *
 * It returns whether a notice was queued: false for a channel that is not
 * waiting on the clinic any more (the step was done within the hour), one
 * the clinic did not buy, or a channel with no ready email yet. In the
 * caller's transaction; the insert runs in a savepoint, so a failure to
 * queue never undoes the caller's work, and is logged.
 *
 * The kind waits for daytime, so the same question is asked again when the
 * outbox would send it (lib/email/superseded.ts): a notice queued in the
 * evening is closed unsent if the clinic forwarded its line overnight.
 */
export async function queueChannelReady(
  tx: TenantTx,
  input: {
    channel: Channel;
    ayaNumberE164: string;
    /** When it may go: an hour after readiness. Absent, as soon as quiet hours allow. */
    sendAfter?: Date;
  },
): Promise<boolean> {
  if (input.channel !== "voice") return false;
  try {
    if (publicOriginProblem()) {
      log.error("channel-ready email not queued: no public origin", { clinicId: tx.clinicId });
      return false;
    }
    const [row] = await tx.db
      .select({
        readyAt: clinicChannels.readyAt,
        waitingOn: clinicChannels.waitingOn,
        liveAt: clinicChannels.liveAt,
      })
      .from(clinicChannels)
      .where(
        and(eq(clinicChannels.clinicId, tx.clinicId), eq(clinicChannels.channel, input.channel)),
      )
      .limit(1);
    if (!row?.readyAt || !isWaitingOnReadyStep(input.channel, row)) return false;
    const readyAt = row.readyAt;
    const [clinic] = await tx.db
      .select({
        slug: clinics.slug,
        carrier: clinics.carrier,
        phoneSystem: clinics.phoneSystemType,
      })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    if (!clinic) return false;
    const settings = await readSetupSettings(tx.db, tx.clinicId);
    await tx.db.transaction(async (savepoint) => {
      await enqueuePlanNotice(
        savepoint,
        tx.clinicId,
        "channel_ready",
        `channel_ready:${input.channel}:${readyAt.toISOString()}`,
        {
          channel: "voice",
          ayaNumberE164: input.ayaNumberE164,
          carrier: isCarrier(clinic.carrier) ? clinic.carrier : null,
          phoneSystem:
            clinic.phoneSystem === "voip" || clinic.phoneSystem === "landline"
              ? clinic.phoneSystem
              : "unknown",
          routing: settings.coverageMode,
          setupUrl: publicUrl(`/c/${clinic.slug}/setup?s=channels`),
          callUrl: emailCallUrl(),
          helpPhoneE164: helpContacts().phoneE164,
        },
        input.sendAfter ? { sendAfter: input.sendAfter } : {},
      );
    });
    return true;
  } catch (error) {
    log.error("channel-ready email not queued", {
      clinicId: tx.clinicId,
      error: describeError(error),
    });
    return false;
  }
}
