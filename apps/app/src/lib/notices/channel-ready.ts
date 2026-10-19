import { isCarrier, type Channel } from "@healdesk/catalog";
import { and, eq } from "drizzle-orm";

import { clinicChannels, clinics } from "@/db/schema";
import { isWaitingOnReadyStep } from "@/lib/email/superseded";
import type { ChannelReadyPayload } from "@/lib/email/templates/channel_ready";
import { describeError, log } from "@/lib/log";
import { publicOriginProblem, publicUrl } from "@/lib/public-url";
import { emailCallUrl, helpContacts } from "@/lib/setup/help";
import { readSetupSettings } from "@/lib/setup/settings";
import { widgetScriptUrl } from "@/lib/setup/snippet";
import type { TenantTx } from "@/lib/tenant";

import { enqueuePlanNotice } from "./plan-notices";

/**
 * O10, "{Channel} is ready: one step left" (Annex X5): queued for a channel
 * that is ready on our side and still waiting on the clinic an hour after it
 * became ready, keyed on the channel and its readiness, so each readiness is
 * one email however often this is asked. `ready_at` is set once and kept
 * (lib/channels/events.ts), so that is once per channel.
 *
 * Its caller is lib/channels/events.ts, in the transaction that records a
 * channel ready on our side and waiting on the clinic's own step: phone's
 * forwarding, with AYA's number, which readiness requires; website chat's
 * line, with the widget's script address and the clinic's slug, from which
 * the template builds the line exactly as the screens print it. It queues
 * the notice then, due an hour after readiness (`sendAfter`); the outbox
 * asks again when it is due whether the channel is still waiting on that
 * step (lib/email/superseded.ts), so a step done within the hour, or a line
 * already confirmed on the clinic's site, sends nothing. The Meta channels'
 * step is the Facebook login, which an email cannot carry.
 *
 * It returns whether a notice was queued: false for a channel that is not
 * waiting on the clinic any more (the step was done within the hour), one
 * the clinic did not buy, or a channel with no ready email. In the caller's
 * transaction; the insert runs in a savepoint, so a failure to queue never
 * undoes the caller's work, and is logged.
 *
 * The kind waits for daytime, so the same question is asked again when the
 * outbox would send it (lib/email/superseded.ts): a notice queued in the
 * evening is closed unsent if the clinic finished the step overnight.
 */
export async function queueChannelReady(
  tx: TenantTx,
  input: {
    channel: Channel;
    /** Phone's: AYA's number, which phone's readiness requires. Unused for website chat. */
    ayaNumberE164?: string | null;
    /** When it may go: an hour after readiness. Absent, as soon as quiet hours allow. */
    sendAfter?: Date;
  },
): Promise<boolean> {
  if (input.channel === "meta") return false;
  if (input.channel === "voice" && !input.ayaNumberE164) return false;
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
    const payload: ChannelReadyPayload =
      input.channel === "web"
        ? {
            channel: "web",
            scriptUrl: widgetScriptUrl(),
            clinicSlug: clinic.slug,
            settingsUrl: publicUrl(`/c/${clinic.slug}/settings#website-line`),
            helpPhoneE164: helpContacts().phoneE164,
          }
        : {
            channel: "voice",
            ayaNumberE164: input.ayaNumberE164!,
            carrier: isCarrier(clinic.carrier) ? clinic.carrier : null,
            phoneSystem:
              clinic.phoneSystem === "voip" || clinic.phoneSystem === "landline"
                ? clinic.phoneSystem
                : "unknown",
            routing: (await readSetupSettings(tx.db, tx.clinicId)).coverageMode,
            setupUrl: publicUrl(`/c/${clinic.slug}/setup?s=channels`),
            callUrl: emailCallUrl(),
            helpPhoneE164: helpContacts().phoneE164,
          };
    await tx.db.transaction(async (savepoint) => {
      await enqueuePlanNotice(
        savepoint,
        tx.clinicId,
        "channel_ready",
        `channel_ready:${input.channel}:${readyAt.toISOString()}`,
        payload,
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
