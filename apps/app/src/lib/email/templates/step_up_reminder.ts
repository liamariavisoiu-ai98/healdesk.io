import type { ChannelWaitingOn } from "@/db/schema";
import type { NoticePayloads } from "@/lib/billing/notices";

import {
  CHANNEL_WORDS,
  dayLong,
  dayShort,
  money,
  perInterval,
  portalUrl,
  verbFor,
} from "./billing-copy";
import { compose } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L4: "{Channel} joins your plan on {date}" (Annex X5), a week's notice before
 * a channel that is ready on our side, and waiting on the clinic, joins the
 * price at its 30 days (BD4, R33). Sent in the clinic's daytime.
 *
 * It names the channel's one outstanding action (the spec's "one reminder
 * naming the single action outstanding"), the date and the new price, and says
 * plainly that the price joins on that date whether or not the channel is
 * live, and sooner if AYA answers there first, because that is the rule a
 * waiting channel is billed by.
 */

export type StepUpReminderPayload = NoticePayloads["step_up_reminder"];

/**
 * The one action each waiting state asks of the clinic: in full for the body,
 * short for the preheader, and the button that leads to it.
 */
const WAITING_ON: Record<ChannelWaitingOn, { task: string; short: string; label: string }> = {
  setup: { task: "finish its setup in healdesk", short: "finish its setup", label: "Finish setup" },
  forwarding: {
    task: "set call forwarding on your clinic's line; the steps for your carrier are in healdesk",
    short: "set call forwarding on your clinic's line",
    label: "See the forwarding steps",
  },
  snippet: {
    task: "add the chat snippet to your website",
    short: "add the chat snippet to your website",
    label: "Get the snippet",
  },
  meta_connect: {
    task: "connect Instagram and Messenger with the Facebook login in healdesk",
    short: "connect Instagram and Messenger",
    label: "Connect Instagram and Messenger",
  },
  whatsapp_payment_method: {
    task: "add a payment method to your WhatsApp Business account in Meta, which WhatsApp needs before it can send",
    short: "add a payment method to WhatsApp in Meta",
    label: "See what to do",
  },
};

export const renderStepUpReminder: EmailTemplate<StepUpReminderPayload> = (payload, ctx) => {
  const channel = CHANNEL_WORDS[payload.channel];
  const waiting = WAITING_ON[payload.waitingOn];
  const joins = dayLong(payload.joinsOn, ctx);
  const join = verbFor(payload.channel, "joins", "join");

  return compose(
    {
      subject: `${channel.title} ${join} your plan on ${dayShort(payload.joinsOn, ctx)}`,
      preheader: `One thing left: ${waiting.short}.`,
      blocks: [
        {
          type: "paragraph",
          text: `${channel.title} ${verbFor(payload.channel, "is", "are")} ready on our side and waiting on one thing from you: ${waiting.task}.`,
        },
        {
          type: "paragraph",
          text: `On ${joins}, ${channel.name} ${join} your plan whether or not ${verbFor(payload.channel, "it's", "they're")} live, which makes it ${payload.planName}, at ${money(payload.amountCents)} ${perInterval(payload.interval)}. If AYA answers there before then, ${verbFor(payload.channel, "it joins", "they join")} from that first answer instead.`,
        },
        { type: "action", label: waiting.label, url: portalUrl() },
      ],
    },
    ctx,
  );
};

export const STEP_UP_REMINDER_ENTRY: TemplateEntry<StepUpReminderPayload> = {
  render: renderStepUpReminder,
  fixture: {
    channel: "voice",
    joinsOn: "2026-10-13",
    planName: "AYA Voice + Web Chat, 500 minutes and 300 conversations",
    amountCents: 52_000,
    interval: "month",
    waitingOn: "forwarding",
  },
};
