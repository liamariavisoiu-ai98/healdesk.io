import type { NoticePayloads } from "@/lib/billing/notices";

import {
  cancelOnline,
  CHANNEL_WORDS,
  dayLong,
  money,
  person,
  planById,
  WAITING_CHANNEL_JOINS,
} from "./billing-copy";
import { compose, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L2: "AYA answered her first patient: your plan has started" (Annex X5).
 * Critical, and sent only once the first plan invoice is paid; a failed first
 * charge sends payment_failed instead, and the $0 placeholder invoices before
 * it send nothing (BD7).
 *
 * The plan starts with AYA's first answer, so the email says which channel
 * and on what day: `startedOn`, the first plan period's start, which is the
 * day the plan started and the day the 14-day refund counts from (R15). It is
 * not the day the notice was raised, which is the day the charge was paid,
 * days later when the first charge was declined and paid on retry. Then what
 * was charged and when the first period ends. While some bought channels are
 * not yet in service the clinic is billed for the ones that are (the owner's
 * decision of 6 October), and the email says so in the portal's words, with
 * both ways another channel's price joins: from its first answer, or 30 days
 * after it became ready while it waits on a step of the clinic's (BD4).
 * The receipt rides on this email (X3's merges), with how to cancel online.
 */

export type PlanStartedPayload = NoticePayloads["plan_started"];

export const renderPlanStarted: EmailTemplate<PlanStartedPayload> = (payload, ctx) => {
  const bought = planById(payload.boughtPlanId);
  const started = dayLong(payload.startedOn, ctx);
  const amount = money(payload.amountCents);
  const period = payload.interval === "year" ? "year" : "month";

  const blocks: Block[] = [
    {
      type: "paragraph",
      text: payload.channel
        ? `AYA answered her first ${person(ctx)} ${CHANNEL_WORDS[payload.channel].where}, so your healdesk plan started on ${started}.`
        : `Your healdesk plan started on ${started}.`,
    },
    {
      type: "paragraph",
      text: `We've charged ${amount} for your first ${period} of ${payload.planName}, which runs to ${dayLong(payload.periodEndsOn, ctx)}.`,
    },
  ];
  if (payload.isBilledByChannelsInService) {
    blocks.push({
      type: "paragraph",
      text: `You bought ${bought.name}. Until every channel in it is in service, you're billed for the ones that are: each other channel's price joins from the day it first answers, and we'll email you each time. ${WAITING_CHANNEL_JOINS}`,
    });
  }
  if (payload.receiptUrl) {
    blocks.push({ type: "action", label: "View your receipt", url: payload.receiptUrl });
  }
  blocks.push(cancelOnline());

  return compose(
    {
      subject: payload.channel
        ? `AYA answered her first ${person(ctx)}: your plan has started`
        : "Your healdesk plan has started",
      preheader: `${amount} for your first ${period} of ${payload.planName}.`,
      blocks,
    },
    ctx,
  );
};

export const PLAN_STARTED_ENTRY: TemplateEntry<PlanStartedPayload> = {
  render: renderPlanStarted,
  fixture: {
    planName: "AYA Web Chat, 300 conversations",
    boughtPlanId: "voice-webchat-500-300",
    channel: "web",
    amountCents: 12_000,
    interval: "month",
    startedOn: "2026-10-06",
    periodEndsOn: "2026-11-06",
    receiptUrl: "https://pay.stripe.com/receipts/invoices/test_receipt",
    isBilledByChannelsInService: true,
  },
};
