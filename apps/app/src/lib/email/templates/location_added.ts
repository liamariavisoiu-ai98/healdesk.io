import type { NoticePayloads } from "@/lib/billing/notices";

import { cancelOnline, money, person } from "./billing-copy";
import { compose, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L27: the clinic added a location from Billing (Annex X5). Only our own
 * addLocation enqueues it (BD8).
 *
 * What the location cost: its setup fee, charged when it was added, and its
 * plan price, which joins the plan at once (prorated onto the invoice) or,
 * before the plan has started, with the plan itself. The payload does not say
 * whether the plan is monthly or annual, so the price is "each billing
 * period" rather than a guess. The invoice is the receipt (X3's merges), so
 * how to cancel online sits beside it.
 */

export type LocationAddedPayload = NoticePayloads["location_added"];

export const renderLocationAdded: EmailTemplate<LocationAddedPayload> = (payload, ctx) => {
  const setup = money(payload.setupFeeCents);
  const recurring = money(payload.recurringCents);
  const invoice: Block[] = payload.hostedInvoiceUrl
    ? [
        { type: "action", label: "View the invoice", url: payload.hostedInvoiceUrl },
        cancelOnline({ beforeStart: payload.isBeforeStart }),
      ]
    : [];

  return compose(
    {
      subject: `Location added: you now have ${payload.locations} healdesk locations`,
      preheader: "The new location has its own setup in healdesk.",
      blocks: [
        {
          type: "paragraph",
          text: `Your new location is added, so your healdesk account now covers ${payload.locations} locations.`,
        },
        {
          type: "paragraph",
          text: payload.isBeforeStart
            ? `Its setup fee of ${setup} was charged when you added it. Its plan price of ${recurring} starts with your plan, the day AYA first answers a ${person(ctx)}.`
            : `Its setup fee of ${setup} was charged when you added it, and your plan now costs ${recurring} more each billing period. The invoice covers the setup fee and the new location's share of this period.`,
        },
        {
          type: "paragraph",
          text: "The new location has its own setup to finish in healdesk.",
        },
        ...invoice,
      ],
    },
    ctx,
  );
};

export const LOCATION_ADDED_ENTRY: TemplateEntry<LocationAddedPayload> = {
  render: renderLocationAdded,
  fixture: {
    locations: 2,
    recurringCents: 89_700,
    setupFeeCents: 99_700,
    hostedInvoiceUrl: "https://invoice.stripe.com/i/acct_testplatform/test_invoice",
    isBeforeStart: false,
    billedPlanId: "web-voice",
  },
};
