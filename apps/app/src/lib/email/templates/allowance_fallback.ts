import { OVERAGE_BLOCK_UNITS } from "@healdesk/catalog";

import type { NoticePayloads } from "@/lib/billing/notices";

import { counted, dayLong, dayShort, METER_WORDS, portalUrl } from "./billing-copy";
import { compose } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L19: "Allowance used: calls go to your direct line until {date}" (Annex X5).
 * Critical, and sent whatever the usage-alerts switch says: that switch
 * governs the 90% and 100% emails, not this one (BD21).
 *
 * The clinic chose "Stop and fall back" for when its allowance runs out, so
 * this is the moment it engaged: what stops, until when (the window's end,
 * when the allowance resets), and what still works. Under the cap a call or a
 * conversation already under way is never cut off; only new ones fall back
 * (R18). The one action is the switch itself, with the honest cost of the
 * other choice: usage past the allowance billed for each started block of
 * 100, as "Keep going" bills it since 6 October 2026 (docs/v1-product-spec.md,
 * the allowance switch), at the plan's overage rates. The email says nothing
 * of our own costs (owner, 30 October 2026).
 */

export type AllowanceFallbackPayload = NoticePayloads["allowance_fallback"];

export const renderAllowanceFallback: EmailTemplate<AllowanceFallbackPayload> = (payload, ctx) => {
  const words = METER_WORDS[payload.meter];
  const included = counted(payload.included, words.one, words.many);
  const resets = dayLong(payload.windowEndsOn, ctx);
  const voice = payload.meter === "voice_minutes";

  return compose(
    {
      subject: voice
        ? `Allowance used: calls go to your direct line until ${dayShort(payload.windowEndsOn, ctx)}`
        : `Allowance used: AYA starts no new chats until ${dayShort(payload.windowEndsOn, ctx)}`,
      preheader: "You chose “Stop and fall back” for when your allowance runs out.",
      blocks: [
        {
          type: "paragraph",
          text: voice
            ? `All ${included} in your plan are used for this period. You chose “Stop and fall back” for when that happens, so until ${resets}, when your allowance resets, AYA doesn't answer new calls: they go to your direct line instead. A call she's already on carries on.`
            : `All ${included} in your plan are used for this period. You chose “Stop and fall back” for when that happens, so until ${resets}, when your allowance resets, AYA doesn't start new conversations: website chat becomes a contact form, and new Instagram, Messenger and WhatsApp messages go unanswered for your team to see. Conversations already under way carry on.`,
        },
        {
          type: "paragraph",
          text: `To keep AYA answering instead, switch to “Keep going and bill the extra” in Billing. Usage past the allowance is then billed for each started block of ${OVERAGE_BLOCK_UNITS} ${words.many} at your plan's overage rates.`,
        },
        { type: "action", label: "Change it in Billing", url: portalUrl() },
      ],
    },
    ctx,
  );
};

export const ALLOWANCE_FALLBACK_ENTRY: TemplateEntry<AllowanceFallbackPayload> = {
  render: renderAllowanceFallback,
  fixture: { meter: "voice_minutes", included: 1_000, windowEndsOn: "2026-11-06" },
};
