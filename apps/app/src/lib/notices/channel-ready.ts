import { isCarrier, type Channel } from "@healdesk/catalog";
import { and, eq } from "drizzle-orm";

import { clinicChannels, clinics } from "@/db/schema";
import { describeError, log } from "@/lib/log";
import { publicOriginProblem, publicUrl } from "@/lib/public-url";
import { emailCallUrl, helpContacts } from "@/lib/setup/help";
import { readSetupSettings, routingForCoverageMode } from "@/lib/setup/settings";
import type { TenantTx } from "@/lib/tenant";

import { enqueuePlanNotice } from "./plan-notices";

/**
 * O10, "{Channel} is ready: one step left" (Annex X5): queued for a channel
 * that is ready on our side and still waiting on the clinic an hour after it
 * became ready, keyed on the channel and its readiness, so each readiness is
 * one email however often this is asked.
 *
 * The seam. Nothing on main writes a channel's readiness yet
 * (`clinic_channels.ready_at` and `waiting_on` are read, never written), so
 * nothing calls this: the voice runtime does, an hour after it marks phone
 * ready and only while phone is still waiting on the clinic's forwarding, and
 * passes AYA's number, which is its to give. Website chat and the Meta
 * channels join when their step exists (lib/email/templates/channel_ready.ts).
 *
 * It returns whether a notice was queued: false for a channel that is not
 * waiting on the clinic any more (the step was done within the hour), one
 * the clinic did not buy, or a channel with no ready email yet. In the
 * caller's transaction; the insert runs in a savepoint, so a failure to
 * queue never undoes the caller's work, and is logged.
 */
export async function queueChannelReady(
  tx: TenantTx,
  input: { channel: Channel; ayaNumberE164: string },
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
    if (!row?.readyAt || row.liveAt || row.waitingOn !== "forwarding") return false;
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
        `channel_ready:${input.channel}:${row.readyAt!.toISOString()}`,
        {
          channel: "voice",
          ayaNumberE164: input.ayaNumberE164,
          carrier: isCarrier(clinic.carrier) ? clinic.carrier : null,
          phoneSystem:
            clinic.phoneSystem === "voip" || clinic.phoneSystem === "landline"
              ? clinic.phoneSystem
              : "unknown",
          routing: routingForCoverageMode(settings.coverageMode),
          setupUrl: publicUrl(`/c/${clinic.slug}/setup?s=channels`),
          callUrl: emailCallUrl(),
          helpPhoneE164: helpContacts().phoneE164,
        },
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
