import { audienceSingular, CHANNEL_NAMES, type Channel } from "@healdesk/catalog";

import { formatReplyBy } from "@/lib/reply-by";
import { actionLine, type ChannelNextStep } from "@/lib/setup/channels";
import { publicUrl } from "@/lib/public-url";

import { compose, EmailCompositionError, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";
import { helpLine } from "./welcome";

/**
 * O7: the setup reminder (Annex X5, with the owner's cadence of 6 October
 * 2026), in two forms (spec, "The first 48 hours"):
 *
 *   - while no channel is answering, one email every five days, six in all,
 *     naming each channel's single action, and for phone the five-minute
 *     call; it prints the window's last day, because it is the reason for the
 *     email: the day the account closes, never a day a channel opens;
 *   - once a channel is answering (`liveRows`), one email for each other
 *     channel still waiting on the clinic 48 hours on, naming its single
 *     action. The account no longer closes, so it says nothing of the window.
 *
 * lib/setup/reminders.ts queues both, only in the clinic's daytime, so each
 * goes within the minute it is queued.
 *
 * An outbox kind, so it carries no token (X1.5): "Continue setup" opens the
 * wizard behind sign-in.
 */

export type SetupReminderRow = {
  channel: Channel;
  /** The channel's next step (lib/setup/channels.ts). */
  status: ChannelNextStep;
};

export type SetupReminderPayload = {
  /** Before a channel is live: which of the six this is, 1 to 6. */
  reminderCount?: number;
  /** How many of the wizard's four steps still have a screen nobody has answered. */
  stepsLeftCount: number;
  /**
   * Before a channel is live, one row per bought channel that is not live;
   * after, one per channel this reminder is for.
   */
  rows: SetupReminderRow[];
  /** Before a channel is live: the setup window's last day, as an ISO date on the clinic's calendar. */
  closesOn?: string;
  /** Once a channel is live: the channels AYA answers on. */
  liveRows?: { channel: Channel }[];
  /** publicUrl("/c/<slug>/setup"), or its channels step once a channel is live. */
  setupUrl: string;
  helpPhoneE164: string | null;
  /** This app's /help/call, when phone is bought and a scheduling page is set. */
  callUrl: string | null;
};

/** Each row's one action, and the wizard's steps left first. */
function actionsOf(payload: SetupReminderPayload): string[] {
  const actions: string[] = [];
  if (payload.stepsLeftCount > 0) {
    actions.push(
      payload.stepsLeftCount === 1
        ? "Finish setup: one step left"
        : `Finish setup: ${payload.stepsLeftCount} steps left`,
    );
  }
  for (const row of payload.rows) {
    // The steps-left line says it, unless every screen is answered and a
    // skipped one is what the channel waits on (its hours, say).
    if (row.status === "finish_setup" && payload.stepsLeftCount > 0) continue;
    const action = actionLine(row.channel, row.status);
    actions.push(
      action
        ? `${CHANNEL_NAMES[row.channel]}: ${action}`
        : `${CHANNEL_NAMES[row.channel]}: we're preparing it, nothing for you to do`,
    );
  }
  return actions;
}

/** A channel as a sentence names it. */
function channelPhrase(channel: Channel): string {
  switch (channel) {
    case "voice":
      return "your phone";
    case "web":
      return "your website chat";
    case "meta":
      return "Instagram, Messenger & WhatsApp";
  }
}

function joined(items: string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Once a channel is live: one reminder for the channels still waiting on the clinic 48 hours on. */
const renderAfterLive: EmailTemplate<SetupReminderPayload> = (payload, ctx) => {
  const clinic = ctx.clinicName ?? "your practice";
  const audience = audienceSingular(ctx.audience);
  const live = joined((payload.liveRows ?? []).map((row) => channelPhrase(row.channel)));
  const waiting = payload.rows.map((row) => CHANNEL_NAMES[row.channel]);
  const phone = payload.rows.some((row) => row.channel === "voice");
  const blocks: Block[] = [
    {
      type: "paragraph",
      text: `AYA is answering ${audience}s for ${clinic} on ${live}. ${joined(waiting)} ${waiting.length === 1 ? "isn't" : "aren't"} answering yet, and ${waiting.length === 1 ? "it needs" : "each needs"} one thing from you:`,
    },
    { type: "list", items: actionsOf(payload) },
    { type: "action", label: "Continue setup", url: payload.setupUrl },
  ];
  if (phone && payload.callUrl) {
    blocks.push({
      type: "paragraph",
      text: "Call forwarding is easier with someone on the line. Book a five-minute call and we'll do it with you.",
    });
    blocks.push({ type: "action", label: "Book a five-minute call", url: payload.callUrl });
  }
  blocks.push({ type: "paragraph", text: helpLine(payload, audience) });
  return compose(
    {
      subject:
        payload.rows.length === 1
          ? `One step left for AYA on ${channelPhrase(payload.rows[0]!.channel)}`
          : "One step left for AYA on your other channels",
      preheader: `AYA is answering on ${live}. Here's what the rest needs.`,
      blocks,
    },
    ctx,
  );
};

export const renderSetupReminder: EmailTemplate<SetupReminderPayload> = (payload, ctx) => {
  if (payload.rows.length === 0) {
    throw new EmailCompositionError("A setup reminder names at least one channel.");
  }
  if (payload.liveRows && payload.liveRows.length > 0) return renderAfterLive(payload, ctx);
  if (payload.reminderCount === undefined || payload.closesOn === undefined) {
    throw new EmailCompositionError(
      "A setup reminder before any channel is live names its count and the window's last day.",
    );
  }
  const clinic = ctx.clinicName ?? "your practice";
  const audience = audienceSingular(ctx.audience);
  const closes = formatReplyBy(payload.closesOn);
  const last = payload.reminderCount >= 6;
  const actions = actionsOf(payload);
  const phone = payload.rows.some((row) => row.channel === "voice");

  const blocks: Block[] = [
    {
      type: "paragraph",
      text: `AYA isn't answering ${audience}s for ${clinic} yet. Here's what's left:`,
    },
    { type: "list", items: actions },
    { type: "action", label: "Continue setup", url: payload.setupUrl },
    {
      type: "paragraph",
      text: last
        ? `Today is the last day to finish. If nothing is answering ${audience}s by the end of ${closes}, the account closes and the setup fee isn't refunded.`
        : `You have until ${closes} to finish. If nothing is answering ${audience}s by the end of that day, the account closes and the setup fee isn't refunded.`,
    },
  ];
  if (phone && payload.callUrl) {
    blocks.push({
      type: "paragraph",
      text: "Call forwarding is easier with someone on the line. Book a five-minute call and we'll do it with you.",
    });
    blocks.push({ type: "action", label: "Book a five-minute call", url: payload.callUrl });
  }
  blocks.push({ type: "paragraph", text: helpLine(payload, audience) });

  return compose(
    {
      subject: last
        ? "Last day to finish setting up AYA"
        : `AYA isn't answering ${audience}s yet: what's left`,
      preheader: `Setup closes at the end of ${closes} if nothing is answering by then.`,
      blocks,
    },
    ctx,
  );
};

export const SETUP_REMINDER_ENTRY: TemplateEntry<SetupReminderPayload> = {
  render: renderSetupReminder,
  get fixture(): SetupReminderPayload {
    return {
      reminderCount: 2,
      stepsLeftCount: 2,
      rows: [
        { channel: "web", status: "finish_setup" },
        { channel: "voice", status: "finish_setup" },
      ],
      closesOn: "2026-11-06",
      setupUrl: publicUrl("/c/radiance-med-spa/setup"),
      helpPhoneE164: "+18885550100",
      callUrl: publicUrl("/help/call"),
    };
  },
};

/** The reminder once a channel is live, for its tests: website chat answering, phone waiting on forwarding. */
export function setupReminderAfterLiveFixture(): SetupReminderPayload {
  return {
    stepsLeftCount: 0,
    rows: [{ channel: "voice", status: "forwarding" }],
    liveRows: [{ channel: "web" }],
    setupUrl: publicUrl("/c/radiance-med-spa/setup?s=channels"),
    helpPhoneE164: "+18885550100",
    callUrl: publicUrl("/help/call"),
  };
}
