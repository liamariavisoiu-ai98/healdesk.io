import type { NoticePayloads } from "@/lib/billing/notices";

import { dayLong, monthAndYear, portalUrl } from "./billing-copy";
import { compose } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L27: the card on file expires before the next renewal (Annex X5; BD16).
 * Sent in the clinic's daytime, at most 30 days before the renewal.
 *
 * The card is named by brand and last four only, as the payload carries it.
 * The one action is updating it from Billing, which opens Stripe's own portal
 * there; a Customer Portal session URL in an email would expire in minutes.
 */

export type CardExpiringPayload = NoticePayloads["card_expiring"];

export const renderCardExpiring: EmailTemplate<CardExpiringPayload> = (payload, ctx) =>
  compose(
    {
      subject: "Your card expires before your healdesk plan renews",
      preheader: `Update it before ${dayLong(payload.renewsOn, ctx)} so the renewal goes through.`,
      blocks: [
        {
          type: "paragraph",
          text: `The card we charge for healdesk, ${payload.cardMasked}, expires at the end of ${monthAndYear(payload.cardExpiresOn, ctx)}, before your plan renews on ${dayLong(payload.renewsOn, ctx)}.`,
        },
        {
          type: "paragraph",
          text: "Update it in Billing so the renewal goes through and AYA keeps answering.",
        },
        { type: "action", label: "Update your card", url: portalUrl() },
      ],
    },
    ctx,
  );

export const CARD_EXPIRING_ENTRY: TemplateEntry<CardExpiringPayload> = {
  render: renderCardExpiring,
  fixture: {
    cardMasked: "Visa •••• 4242",
    cardExpiresOn: "2026-10-31",
    renewsOn: "2026-11-06",
  },
};
