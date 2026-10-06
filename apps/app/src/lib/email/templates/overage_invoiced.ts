import type { NoticePayloads } from "@/lib/billing/notices";

import { cancelOnline, counted, dayLong, METER_WORDS, money } from "./billing-copy";
import { compose, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L27: an annual plan's usage past the allowance, invoiced for one closed
 * month (Annex X5; BD20).
 *
 * The month, the units past the allowance on each meter (a meter with none is
 * left out), and the amount, charged automatically. The overage rates are
 * provisional until measured, and the copy says so (CLAUDE.md, "Claims and
 * copy"). The invoice is the receipt (X3's merges), so how to cancel online
 * sits beside it.
 */

export type OverageInvoicedPayload = NoticePayloads["overage_invoiced"];

export const renderOverageInvoiced: EmailTemplate<OverageInvoicedPayload> = (payload, ctx) => {
  const amount = money(payload.amountCents);
  const units = [
    payload.voiceMinutes > 0
      ? counted(payload.voiceMinutes, METER_WORDS.voice_minutes.one, METER_WORDS.voice_minutes.many)
      : null,
    payload.chatConversationsCount > 0
      ? counted(
          payload.chatConversationsCount,
          METER_WORDS.chat_conversations.one,
          METER_WORDS.chat_conversations.many,
        )
      : null,
  ].filter((item): item is string => item !== null);

  const invoice: Block[] = payload.hostedInvoiceUrl
    ? [{ type: "action", label: "View the invoice", url: payload.hostedInvoiceUrl }, cancelOnline()]
    : [];

  return compose(
    {
      subject: "Your healdesk invoice for usage past your allowance",
      preheader: `${amount} for the month to ${dayLong(payload.windowEnd, ctx)}.`,
      blocks: [
        {
          type: "paragraph",
          text: `In the month from ${dayLong(payload.windowStart, ctx)} to ${dayLong(payload.windowEnd, ctx)}, AYA handled more than your plan includes${units.length > 0 ? ". Past your allowance:" : "."}`,
        },
        ...(units.length > 0 ? [{ type: "list", items: units } as const] : []),
        {
          type: "paragraph",
          text: `That comes to ${amount} at your plan's overage rates, charged to the card on file. The rates are provisional until we've measured what each minute and conversation costs us.`,
        },
        ...invoice,
      ],
    },
    ctx,
  );
};

export const OVERAGE_INVOICED_ENTRY: TemplateEntry<OverageInvoicedPayload> = {
  render: renderOverageInvoiced,
  fixture: {
    amountCents: 2_400,
    windowStart: "2026-09-06T14:32:00.000Z",
    windowEnd: "2026-10-06T14:32:00.000Z",
    voiceMinutes: 30,
    chatConversationsCount: 0,
    hostedInvoiceUrl: "https://invoice.stripe.com/i/acct_testplatform/test_invoice",
  },
};
