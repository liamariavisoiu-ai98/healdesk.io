import type { NoticePayloads } from "@/lib/billing/notices";

import { dayLong, dayShort, money, portalUrl } from "./billing-copy";
import { compose } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L27: an annual plan renews soon (Annex X5), at 30 and again at 21 days, the
 * notice windows the Terms and the states' automatic-renewal laws ask of a
 * business contract. Sent in the clinic's daytime.
 *
 * It names the date, the amount and how to stop it (Visa's recommended
 * practice, X7), and asks nothing of a clinic that wants to carry on. The
 * second notice says it is a reminder; both say the same facts.
 */

export type RenewalUpcomingPayload = NoticePayloads["renewal_upcoming"];

export const renderRenewalUpcoming: EmailTemplate<RenewalUpcomingPayload> = (payload, ctx) => {
  const renews = dayLong(payload.renewsOn, ctx);
  const locations = payload.locations > 1 ? ` (${payload.locations} locations)` : "";
  return compose(
    {
      subject: `Your healdesk plan renews on ${dayShort(payload.renewsOn, ctx)}`,
      preheader: `${payload.noticeDays === 21 ? "A reminder: your" : "Your"} annual plan renews for ${money(payload.amountCents)}.`,
      blocks: [
        {
          type: "paragraph",
          // The plan's name says its steps since 13 October 2026 ("AYA Voice,
          // 500 minutes"), so it stands apart rather than before "plan".
          text: `Your annual plan, ${payload.planName}, renews on ${renews}, for ${money(payload.amountCents)}${locations}. We'll charge the card on file.`,
        },
        {
          type: "paragraph",
          text: `There's nothing to do if you'd like to carry on. To stop it renewing, turn auto-renew off in Billing before ${renews}.`,
        },
        { type: "action", label: "Manage auto-renew", url: portalUrl() },
      ],
    },
    ctx,
  );
};

export const RENEWAL_UPCOMING_ENTRY: TemplateEntry<RenewalUpcomingPayload> = {
  render: renderRenewalUpcoming,
  fixture: {
    renewsOn: "2027-11-05",
    amountCents: 556_800,
    planName: "AYA Voice + Meta Chat, 500 minutes and 300 conversations",
    locations: 1,
    noticeDays: 30,
  },
};
