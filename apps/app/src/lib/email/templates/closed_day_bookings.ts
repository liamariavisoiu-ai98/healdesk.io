import { publicUrl } from "@/lib/public-url";

import { compose } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * O17: "A closed day has bookings on it", to the clinic's one address, when
 * the clinic saves a closed day in Knowledge → Hours and AYA's bookings or
 * requests still waiting already fall on a day it just closed (owner decision
 * D10: the portal's note at save time, plus this email). Queued after the
 * save has committed, in its own transaction (lib/portal/knowledge.ts), once
 * per set of newly closed days.
 *
 * A pointer into the portal, like every patient-related email (CLAUDE.md,
 * "Email"): no name, time, service, date or count, nothing from a booking,
 * only that some exist and where to see them. The closure cancels nothing
 * and contacts nobody, and the email says so. An outbox kind: no token, and
 * the action opens Bookings behind sign-in.
 *
 * The words are the owner's proposed wording (23 October 2026), kept in
 * WORDS below so a change to them is a change in one place.
 */

export type ClosedDayBookingsPayload = {
  /** publicUrl("/c/<slug>/bookings#booked"). */
  bookingsUrl: string;
};

/** Every word the email says, in one place. */
export const CLOSED_DAY_BOOKINGS_WORDS = {
  subject: "A closed day has bookings on it",
  preheader: "Nothing has been cancelled and nobody has been contacted.",
  greeting: "Hi,",
  body: [
    "You've marked a day as closed, and some bookings were already made for it.",
    "Nothing has been cancelled and nobody has been contacted.",
    "You can see them in Bookings and decide whether to move them.",
  ],
  action: "Open Bookings",
} as const;

export const renderClosedDayBookings: EmailTemplate<ClosedDayBookingsPayload> = (payload, ctx) => {
  const w = CLOSED_DAY_BOOKINGS_WORDS;
  return compose(
    {
      subject: w.subject,
      preheader: w.preheader,
      blocks: [
        { type: "paragraph", text: w.greeting },
        { type: "paragraph", text: w.body.join(" ") },
        { type: "action", label: w.action, url: payload.bookingsUrl },
      ],
    },
    ctx,
  );
};

export const CLOSED_DAY_BOOKINGS_ENTRY: TemplateEntry<ClosedDayBookingsPayload> = {
  render: renderClosedDayBookings,
  get fixture(): ClosedDayBookingsPayload {
    return { bookingsUrl: publicUrl("/c/radiance-med-spa/bookings#booked") };
  },
};
