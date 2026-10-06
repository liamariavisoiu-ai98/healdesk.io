import { OVERAGE_BLOCK_UNITS } from "@healdesk/catalog";

import type { NoticePayloads } from "@/lib/billing/notices";

import { cancelOnline, counted, dayLong, METER_WORDS, money } from "./billing-copy";
import { compose, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L27: an annual plan's usage past the allowance, invoiced for one closed
 * month (Annex X5; BD20).
 *
 * The month, then each meter's units past the allowance and the started
 * blocks of 100 they are billed as, at the block price (a meter that billed
 * no block is left out), and the amount, charged automatically. Overage is
 * billed per started block since 6 October 2026 (docs/v1-product-spec.md,
 * "Overage prices"), so the email shows the blocks the invoice charges and
 * never a per-unit rate the clinic could not reconcile with it. The overage
 * rates are provisional until measured, and the copy says so (CLAUDE.md,
 * "Claims and copy"). The invoice is the receipt (X3's merges), so how to
 * cancel online sits beside it.
 */

export type OverageInvoicedPayload = NoticePayloads["overage_invoiced"];

/**
 * One meter's line: "130 voice minutes, billed as 2 blocks of 100 voice
 * minutes at $80 each". Null for a meter that billed no block.
 */
function billedBlocks(
  units: number,
  blocks: number,
  blockRateCents: number,
  words: { one: string; many: string },
): string | null {
  if (blocks <= 0) return null;
  const billedAs = counted(
    blocks,
    `block of ${OVERAGE_BLOCK_UNITS} ${words.many}`,
    `blocks of ${OVERAGE_BLOCK_UNITS} ${words.many}`,
  );
  const each = blocks === 1 ? "" : " each";
  return `${counted(units, words.one, words.many)}, billed as ${billedAs} at ${money(blockRateCents)}${each}`;
}

export const renderOverageInvoiced: EmailTemplate<OverageInvoicedPayload> = (payload, ctx) => {
  const amount = money(payload.amountCents);
  const meters = [
    billedBlocks(
      payload.voiceMinutes,
      payload.voiceBlocksCount,
      payload.voiceBlockRateCents,
      METER_WORDS.voice_minutes,
    ),
    billedBlocks(
      payload.chatConversationsCount,
      payload.chatBlocksCount,
      payload.chatBlockRateCents,
      METER_WORDS.chat_conversations,
    ),
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
          text: `In the month from ${dayLong(payload.windowStart, ctx)} to ${dayLong(payload.windowEnd, ctx)}, AYA handled more than your plan includes${meters.length > 0 ? ". Past your allowance:" : "."}`,
        },
        ...(meters.length > 0 ? [{ type: "list", items: meters } as const] : []),
        {
          type: "paragraph",
          text: `Overage is billed for each started block of ${OVERAGE_BLOCK_UNITS}, so that comes to ${amount}, charged to the card on file. The rates are provisional until we've measured what each minute and conversation costs us.`,
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
    amountCents: 8_000,
    windowStart: "2026-09-06T14:32:00.000Z",
    windowEnd: "2026-10-06T14:32:00.000Z",
    voiceMinutes: 30,
    chatConversationsCount: 0,
    voiceBlocksCount: 1,
    chatBlocksCount: 0,
    voiceBlockRateCents: 8_000,
    chatBlockRateCents: 3_000,
    hostedInvoiceUrl: "https://invoice.stripe.com/i/acct_testplatform/test_invoice",
  },
};
