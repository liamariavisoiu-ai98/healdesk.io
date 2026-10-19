import { CHANNEL_NAMES, type Channel } from "@healdesk/catalog";

import type { ChannelWaitingOn } from "@/db/schema";
import type { ChannelState, ChannelStatus } from "@/lib/channels/state";

/**
 * What each bought channel is waiting for, in words a clinic acts on (plan
 * Part E step 4, the welcome email and the setup reminder). One reading,
 * shared by the wizard, the clinic's page and the emails, so a channel is
 * never "waiting on you" on one screen and "being prepared" in an email.
 *
 * Never a date (owner, 6 October 2026: a channel is sold only once it is
 * ready, so there are no opening dates), and never a channel shown as live
 * before it is (spec, "What the clinic sees at the end").
 *
 * Pure: no database, no clock. lib/channels/state.ts reads the rows.
 */

/**
 * The clinic's one outstanding action for a channel, or what is true when
 * there is none:
 *
 * - `finish_setup`: the wizard is not finished, which every channel needs;
 * - a `waiting_on` value: ready on our side, waiting for the clinic;
 * - `preparing`: setup is done and the channel is not ready on our side, so
 *   there is nothing for the clinic to do;
 * - `none`: live, paused or switched off, so there is no setup step left.
 */
export type ChannelNextStep = "finish_setup" | ChannelWaitingOn | "preparing" | "none";

/** The channel's next step from its state and whether the wizard is finished. */
export function channelNextStep(
  state: Pick<ChannelState, "status" | "waitingOn">,
  setupFinished: boolean,
): ChannelNextStep {
  if (state.status === "live" || state.status === "paused" || state.status === "off") return "none";
  if (!setupFinished) return "finish_setup";
  if (state.status === "waiting") {
    // A ready channel with no named action is still the clinic's to finish.
    return state.waitingOn && state.waitingOn !== "setup" ? state.waitingOn : "finish_setup";
  }
  return "preparing";
}

/** Whether a step is one the clinic can take, as opposed to one on our side. */
export function isClinicAction(step: ChannelNextStep): boolean {
  return step !== "preparing" && step !== "none";
}

/** The status word (plan Part E step 4), without a date. */
export function channelStatusWord(status: ChannelStatus): string {
  switch (status) {
    case "off":
      return "Off";
    case "paused":
      return "Paused";
    case "live":
      return "Live";
    case "waiting":
      return "Waiting on you";
    case "setting_up":
      return "Being prepared";
  }
}

/**
 * The one action, in the imperative, for a step the clinic can take. The
 * phone's is the forwarding step, which the wizard shows with the number
 * and the codes only once voice is ready for the clinic.
 */
export function actionLine(channel: Channel, step: ChannelNextStep): string | null {
  switch (step) {
    case "finish_setup":
      return "Finish setup";
    case "direct_line":
      return "Add your direct line, where calls go whenever AYA can't answer";
    case "snippet":
      return "Paste one line on your website";
    case "forwarding":
      return "Set call forwarding on your main line";
    case "meta_connect":
      return "Connect Instagram and Messenger with your Facebook login";
    case "whatsapp_payment_method":
      return "Add a payment method to your WhatsApp account in Meta";
    case "setup":
      return "Finish setup";
    case "preparing":
    case "none":
      void channel;
      return null;
  }
}

/**
 * What happens next for a channel during setup, as one sentence, for the
 * welcome email and the wizard's channel screen. No dates, and nothing that
 * says how long: each channel goes live on a step, not on a day (spec, the
 * set-up promise).
 */
export function setupLine(channel: Channel, step: ChannelNextStep): string {
  const name = CHANNEL_NAMES[channel];
  switch (step) {
    case "none":
      return `${name}: nothing left to set up.`;
    case "preparing":
      return channel === "voice"
        ? `${name}: we're preparing it. Don't change your call forwarding yet; the steps appear here when phone is ready for them.`
        : `${name}: we're preparing it. There's nothing for you to do yet.`;
    case "finish_setup":
      switch (channel) {
        case "web":
          return `${name}: after setup, you paste one line on your website and AYA starts answering there.`;
        case "voice":
          return `${name}: after setup, we show you exactly what to dial to forward calls from your main line. Don't change your call forwarding until then.`;
        case "meta":
          return `${name}: after setup, you connect them with your Facebook login.`;
      }
      return `${name}: after setup.`;
    default:
      return `${name}: ${actionLine(channel, step) ?? "nothing left to set up"}.`;
  }
}

/** The same sentence without the channel's name, for a row that shows the name beside it. */
export function setupSentence(channel: Channel, step: ChannelNextStep): string {
  const line = setupLine(channel, step).slice(`${CHANNEL_NAMES[channel]}: `.length);
  return line.charAt(0).toUpperCase() + line.slice(1);
}
