import { OVERAGE_BLOCK_UNITS, USAGE_ALERT_PERCENT } from "@healdesk/catalog";

import type { NoticePayloads } from "@/lib/billing/notices";

import { counted, dayLong, dayShort, METER_WORDS, money, portalUrl } from "./billing-copy";
import { compose, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L27: the usage alerts (Annex X5; BD21), sent while Billing's "Usage alerts"
 * switch is on, once per meter per allowance window.
 *
 * `usage_80` is the first alert. It goes at USAGE_ALERT_PERCENT of the
 * allowance, 90% since the pricing sheet of 13 October 2026 ("When you use
 * 90% of your included amount, we send you a short email"); its kind kept the
 * old name because the name is a key in two CHECK constraints
 * (lib/billing/usage-alerts.ts says why). `usage_100` goes when the allowance
 * is used up.
 *
 * Short, as the sheet promises, and with the sheet's two choices: move up a
 * step from Billing, or do nothing, and each started block of 100 past the
 * allowance is billed at the extra-100 price. Moving up is the better deal
 * for a clinic that goes over regularly (an extra block costs 30% more than a
 * step), and the email says so without quoting the step's price, which the
 * payload does not carry and which depends on the billing period. It never
 * says when a bigger step's allowance applies: that is the plan change's own
 * business, and Billing shows it before anything is charged.
 *
 * The block price is the payload's, at the BOUGHT package's rate; the email
 * says nothing of our own costs (owner, 30 October 2026). Under "Stop and fall back" nothing is billed past the allowance, so
 * the email says what stops instead; the critical allowance_fallback email
 * still goes when the cap engages, whatever this switch says. Counts and the
 * clinic's own allowance only: nothing about a patient or a conversation.
 */

export type UsageAlertPayload = NoticePayloads["usage_80"];

/** "Each started block of 100 extra voice minutes is billed at $104". */
function extraBlocks(payload: UsageAlertPayload, lead: string): string {
  const words = METER_WORDS[payload.meter];
  return `${lead} each started block of ${OVERAGE_BLOCK_UNITS} extra ${words.many} is billed at ${money(payload.blockRateCents)}.`;
}

/** What stops under "Stop and fall back", in allowance_fallback's words. */
function whatStops(payload: UsageAlertPayload): string {
  return payload.meter === "voice_minutes"
    ? "AYA doesn't answer new calls: they go to your direct line"
    : "AYA doesn't start new conversations: website chat becomes a contact form, and new Instagram, Messenger and WhatsApp messages wait for your team";
}

const MOVE_UP =
  "Move up a step in Billing, for a bigger monthly allowance: it costs less than paying for extra blocks.";

function renderUsage(threshold: "alert" | "used_up"): EmailTemplate<UsageAlertPayload> {
  return (payload, ctx) => {
    const words = METER_WORDS[payload.meter];
    const included = counted(payload.included, words.one, words.many);
    const resets = dayLong(payload.windowEndsOn, ctx);
    const capped = payload.overageMode === "hard_cap";
    // Whole percent, rounded down, so 89.6% never reads as 90%; the alert
    // itself only goes from USAGE_ALERT_PERCENT up.
    const percent =
      payload.included > 0
        ? Math.max(USAGE_ALERT_PERCENT, Math.min(99, Math.floor((payload.used * 100) / payload.included)))
        : USAGE_ALERT_PERCENT;

    const blocks: Block[] = [];
    if (threshold === "alert") {
      blocks.push(
        {
          type: "paragraph",
          text: `AYA has used ${payload.used.toLocaleString("en-US")} of the ${included} in this month's allowance, which resets on ${resets}.`,
        },
        { type: "paragraph", text: "If it runs out before then, you can:" },
        {
          type: "list",
          items: capped
            ? [
                MOVE_UP,
                `Do nothing. You chose “Stop and fall back”, so once the allowance is used, ${whatStops(payload)} until it resets. Nothing extra is billed.`,
              ]
            : [MOVE_UP, extraBlocks(payload, "Do nothing. AYA keeps answering, and")],
        },
      );
    } else if (capped) {
      blocks.push(
        {
          type: "paragraph",
          text: `AYA has used all ${included} in this month's allowance. You chose “Stop and fall back”, so until ${resets}, when your allowance resets, ${whatStops(payload)}. Nothing extra is billed.`,
        },
        {
          type: "paragraph",
          text: `To keep AYA answering, move up a step in Billing, or switch to “Keep going and bill the extra”. ${extraBlocks(payload, "Then")}`,
        },
      );
    } else {
      blocks.push(
        {
          type: "paragraph",
          text: `AYA has used all ${included} in this month's allowance. She keeps answering, and until ${resets}, when your allowance resets, ${extraBlocks(payload, "").trimStart()}`,
        },
        { type: "paragraph", text: MOVE_UP },
      );
    }
    blocks.push({ type: "action", label: "Open Billing", url: portalUrl() });

    return compose(
      {
        subject:
          threshold === "alert"
            ? `You've used ${percent}% of this month's ${words.many}`
            : `You've used all of this month's ${words.many}`,
        preheader:
          threshold === "alert"
            ? `Your allowance resets on ${dayShort(payload.windowEndsOn, ctx)}. Move up a step, or let extra blocks bill.`
            : capped
              ? `Until ${dayShort(payload.windowEndsOn, ctx)}, AYA falls back to your team.`
              : `Extra blocks of ${OVERAGE_BLOCK_UNITS} bill at ${money(payload.blockRateCents)} until ${dayShort(payload.windowEndsOn, ctx)}.`,
        blocks,
      },
      ctx,
    );
  };
}

export const renderUsage80 = renderUsage("alert");
export const renderUsage100 = renderUsage("used_up");

export const USAGE_80_ENTRY: TemplateEntry<UsageAlertPayload> = {
  render: renderUsage80,
  fixture: {
    meter: "voice_minutes",
    used: 452,
    included: 500,
    windowEndsOn: "2026-11-06",
    overageMode: "allow",
    blockRateCents: 10_400,
  },
};

export const USAGE_100_ENTRY: TemplateEntry<UsageAlertPayload> = {
  render: renderUsage100,
  fixture: {
    meter: "chat_conversations",
    used: 300,
    included: 300,
    windowEndsOn: "2026-11-06",
    overageMode: "allow",
    blockRateCents: 5_200,
  },
};
