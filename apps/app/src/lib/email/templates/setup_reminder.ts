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
 * 2026). While no channel is answering, one email every five days, six in
 * all, naming each channel's single action, and for phone the five-minute
 * call (spec, "The first 48 hours"). It stops the moment a channel is live:
 * lib/setup/reminders.ts queues it only while none is, and only in the
 * clinic's daytime, so it goes within the minute it is queued.
 *
 * An outbox kind, so it carries no token (X1.5): "Continue setup" opens the
 * wizard behind sign-in. The window's last day is printed because it is the
 * reason for the email; it is the day the account closes, never a day a
 * channel opens.
 */

export type SetupReminderRow = {
  channel: Channel;
  /** The channel's next step (lib/setup/channels.ts). */
  status: ChannelNextStep;
};

export type SetupReminderPayload = {
  /** Which of the six this is, 1 to 6. */
  reminderCount: number;
  /** How many of the wizard's four steps still have a screen nobody has answered. */
  stepsLeftCount: number;
  /** One row per bought channel that is not live. */
  rows: SetupReminderRow[];
  /** The setup window's last day, as an ISO date on the clinic's calendar. */
  closesOn: string;
  /** publicUrl("/c/<slug>/setup"). */
  setupUrl: string;
  helpPhoneE164: string | null;
  /** This app's /help/call, when phone is bought and a scheduling page is set. */
  callUrl: string | null;
};

export const renderSetupReminder: EmailTemplate<SetupReminderPayload> = (payload, ctx) => {
  if (payload.rows.length === 0) {
    throw new EmailCompositionError("A setup reminder names at least one channel.");
  }
  const clinic = ctx.clinicName ?? "your practice";
  const audience = audienceSingular(ctx.audience);
  const closes = formatReplyBy(payload.closesOn);
  const last = payload.reminderCount >= 6;

  const actions: string[] = [];
  if (payload.stepsLeftCount > 0) {
    actions.push(
      payload.stepsLeftCount === 1
        ? "Finish setup: one step left"
        : `Finish setup: ${payload.stepsLeftCount} steps left`,
    );
  }
  for (const row of payload.rows) {
    if (row.status === "finish_setup") continue;
    const action = actionLine(row.channel, row.status);
    actions.push(
      action
        ? `${CHANNEL_NAMES[row.channel]}: ${action}`
        : `${CHANNEL_NAMES[row.channel]}: we're preparing it, nothing for you to do`,
    );
  }
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
