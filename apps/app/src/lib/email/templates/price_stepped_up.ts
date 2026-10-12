import type { NoticePayloads } from "@/lib/billing/notices";

import { cancelOnline, CHANNEL_WORDS, money, perInterval, verbFor } from "./billing-copy";
import { compose, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L3: another bought channel's price joined the plan (Annex X5; BD3).
 *
 * The annex titles it "{Channel} is in service", but a step-up has two
 * causes, the channel's first answer and a waiting channel reaching its 30
 * days (BD4, after L4's week of notice), and the payload does not say which.
 * So the copy says only what is true of both: the channel joined the plan,
 * and this is the new price. Monthly plans carry the prorated difference on
 * the next invoice; annual plans are invoiced for it at once, and that
 * invoice is the receipt (X3's merges), with how to cancel online.
 *
 * An annual step-up is applied even when its card declines (allow_incomplete)
 * and the invoice is left open, so "charged to the card on file" is said only
 * when the invoice was paid (`isPaid`); otherwise the email says the invoice
 * is due and links it, beside the payment_failed email Stripe's failure sends.
 */

export type PriceSteppedUpPayload = NoticePayloads["price_stepped_up"];

export const renderPriceSteppedUp: EmailTemplate<PriceSteppedUpPayload> = (payload, ctx) => {
  const channel = CHANNEL_WORDS[payload.channel];
  const price = `${money(payload.amountCents)} ${perInterval(payload.interval)}`;
  const period = payload.interval === "year" ? "year" : "month";

  const blocks: Block[] = [
    {
      type: "paragraph",
      text: `${channel.title} ${verbFor(payload.channel, "is", "are")} now part of your healdesk plan, which makes it ${payload.planName}, at ${price}.`,
    },
    {
      type: "paragraph",
      text: !payload.isInvoicedNow
        ? `The difference for the rest of this ${period} is prorated onto your next invoice.`
        : payload.isPaid
          ? `The difference for the rest of this ${period} is invoiced now and charged to the card on file.`
          : `The difference for the rest of this ${period} is invoiced now, and that invoice is due.`,
    },
  ];
  if (payload.hostedInvoiceUrl) {
    blocks.push(
      {
        type: "action",
        label: payload.isInvoicedNow && !payload.isPaid ? "Pay the invoice" : "View the invoice",
        url: payload.hostedInvoiceUrl,
      },
      cancelOnline(),
    );
  }

  return compose(
    {
      subject: `${channel.title} joined your plan: your new price`,
      preheader: `${payload.planName}, at ${price}.`,
      blocks,
    },
    ctx,
  );
};

export const PRICE_STEPPED_UP_ENTRY: TemplateEntry<PriceSteppedUpPayload> = {
  render: renderPriceSteppedUp,
  fixture: {
    channel: "voice",
    planName: "AYA Web Chat + Voice",
    amountCents: 89_700,
    interval: "month",
    isInvoicedNow: false,
    hostedInvoiceUrl: null,
    isPaid: false,
  },
};
