import { CHANNEL_NAMES, type Channel } from "@healdesk/catalog";

import type { ChannelState } from "@/lib/channels/state";
import type { MetaConnectView } from "@/lib/meta/reconnect";

import { channelNextStep, channelStatusLabel, setupSentence, type ChannelNextStep } from "./channels";

/**
 * One reading of a channel's status for the two screens that draw it, the
 * wizard's "Your channels" step and Settings' Channels card, so a channel is
 * never "Waiting on you" in one and "Being prepared" in the other, and no
 * status rule is written twice (this is the only place that turns a
 * ChannelState into the words and the one button).
 *
 * A channel is exactly one of:
 *
 * - `live`: answering;
 * - `waiting`: waiting for the ONE specific thing the clinic has to do, said
 *   in the label ("Waiting for call forwarding"), with its button where there
 *   is one;
 * - `paused`: the clinic-wide pause is holding a live channel;
 * - `off`: switched off in Settings;
 * - `preparing`: setup is done and the channel is not ready on our side, so
 *   there is nothing for the clinic to do and no button.
 *
 * A dropped Meta login is `waiting` too, for the one thing that fixes it:
 * reconnecting. Every sentence says what the step IS and never how long it
 * takes or when a channel will open (the set-up promise is per channel and
 * describes the step, owner, 6 October 2026).
 *
 * Pure: no database, no clock of its own.
 */

export type ChannelStatusKind = "live" | "waiting" | "paused" | "off" | "preparing";

/** What the one button does; `reconnect` is a Meta login Meta dropped. */
export type ChannelActionStep = Exclude<ChannelNextStep, "preparing" | "none"> | "reconnect";

export type ChannelAction = {
  step: ChannelActionStep;
  /** The button's words: short, an imperative. */
  label: string;
};

export type ChannelPresentation = {
  channel: Channel;
  kind: ChannelStatusKind;
  /** The status pill: "Live since 14 October", "Waiting for call forwarding", "Paused until …", "Off". */
  label: string;
  /** One sentence under the pill: what is true, or the one thing to do. */
  detail: string;
  /** The single next-step button, or null when the clinic has nothing to press. */
  action: ChannelAction | null;
};

/** Whether either Meta login was dropped by Meta (its Reconnect case). */
export function metaNeedsReconnect(view: Pick<MetaConnectView, "facebook" | "whatsapp"> | null): boolean {
  return view !== null && (view.facebook.state === "needs_reconnect" || view.whatsapp.state === "needs_reconnect");
}

/** The pill's words for a step the clinic has to take: what the channel waits FOR. */
export function waitingLabel(step: Exclude<ChannelNextStep, "preparing" | "none">): string {
  switch (step) {
    case "finish_setup":
    case "setup":
      return "Waiting for you to finish setup";
    case "direct_line":
      return "Waiting for your direct line";
    case "snippet":
      return "Waiting for the line on your website";
    case "forwarding":
      return "Waiting for call forwarding";
    case "meta_connect":
      return "Waiting for your Facebook login";
    case "whatsapp_payment_method":
      return "Waiting for a WhatsApp payment method";
  }
}

/** The button's words for a step the clinic can take. */
export function actionButtonLabel(step: ChannelActionStep): string {
  switch (step) {
    case "finish_setup":
    case "setup":
      return "Finish setup";
    case "direct_line":
      return "Add your direct line";
    case "snippet":
      return "Get the line to paste";
    case "forwarding":
      return "See the forwarding steps";
    case "meta_connect":
      return "Connect with Facebook";
    case "whatsapp_payment_method":
      return "Open WhatsApp in Meta";
    case "reconnect":
      return "Reconnect";
  }
}

/**
 * One Meta platform's own pill. Off is the platform's; a dropped login is
 * only the login that platform rides on (Facebook's for Instagram and
 * Messenger, WhatsApp's for WhatsApp); a live channel says only "Live"
 * (the channel's live date is the first platform's, and one connected later
 * did not go live then); anything else is the channel's reading
 * (`channel`, which the caller computes WITHOUT the channel-wide reconnect
 * flag, so another platform's dropped login does not mark this one).
 */
export function metaPlatformStatus(input: {
  platform: "instagram" | "messenger" | "whatsapp";
  on: boolean;
  channel: Pick<ChannelPresentation, "kind" | "label">;
  connect: Pick<MetaConnectView, "facebook" | "whatsapp"> | null;
}): { kind: ChannelStatusKind; label: string } {
  if (!input.on) return { kind: "off", label: "Off" };
  const login = input.platform === "whatsapp" ? input.connect?.whatsapp : input.connect?.facebook;
  if (login?.state === "needs_reconnect") return { kind: "waiting", label: "Waiting for you to reconnect" };
  if (input.channel.kind === "live") return { kind: "live", label: "Live" };
  return { kind: input.channel.kind, label: input.channel.label };
}

const RECONNECT_DETAIL = "Meta dropped the connection, so AYA can't reply there until you reconnect.";

export function channelPresentation(
  state: Pick<ChannelState, "channel" | "status" | "waitingOn" | "liveAt" | "pausedUntil">,
  options: {
    setupFinished: boolean;
    timeZone: string;
    now: Date;
    /** Meta only: Meta dropped a login (metaNeedsReconnect). Ignored for other channels and while off. */
    needsReconnect?: boolean;
  },
): ChannelPresentation {
  const { channel } = state;

  if (state.status === "off") {
    return {
      channel,
      kind: "off",
      label: "Off",
      detail: `${CHANNEL_NAMES[channel]} is switched off. Turn it back on in Settings.`,
      action: null,
    };
  }

  if (state.status === "paused") {
    return {
      channel,
      kind: "paused",
      label: channelStatusLabel(state, options.timeZone, options.now),
      detail: "AYA is paused for the whole clinic, so nothing here is answered until the pause ends.",
      action: null,
    };
  }

  // A dropped login is the one thing a live (or waiting) Meta channel needs.
  if (channel === "meta" && options.needsReconnect) {
    return {
      channel,
      kind: "waiting",
      label: "Waiting for you to reconnect",
      detail: RECONNECT_DETAIL,
      action: { step: "reconnect", label: actionButtonLabel("reconnect") },
    };
  }

  if (state.status === "live") {
    return {
      channel,
      kind: "live",
      label: channelStatusLabel(state, options.timeZone, options.now),
      detail: "Nothing left to set up.",
      action: null,
    };
  }

  const step = channelNextStep(state, options.setupFinished);
  if (step === "preparing" || step === "none") {
    return {
      channel,
      kind: "preparing",
      label: "Being prepared",
      detail: setupSentence(channel, step),
      action: null,
    };
  }
  return {
    channel,
    kind: "waiting",
    label: waitingLabel(step),
    detail: setupSentence(channel, step),
    action: { step, label: actionButtonLabel(step) },
  };
}

/**
 * Where the button goes on a screen, or null where the step itself sits right
 * below it (the wizard shows the line, the login and the forwarding steps
 * under the row and is itself where setup finishes) or happens in Meta, whose
 * address is not ours to link.
 */
export function channelActionHref(
  surface: "settings" | "wizard",
  slug: string,
  action: ChannelAction,
): string | null {
  if (surface === "wizard") {
    return action.step === "direct_line" ? `/c/${slug}/setup?s=direct_line` : null;
  }
  switch (action.step) {
    case "finish_setup":
    case "setup":
      return `/c/${slug}/setup`;
    case "direct_line":
      return `/c/${slug}/settings#safety-net`;
    case "snippet":
      return "#website-line";
    case "meta_connect":
    case "reconnect":
      return "#meta-connections";
    case "forwarding":
      return "#channels";
    case "whatsapp_payment_method":
      return null;
  }
}
