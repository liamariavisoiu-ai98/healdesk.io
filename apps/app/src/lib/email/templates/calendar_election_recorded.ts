import {
  calendarClauseBody,
  isBookingSystemId,
  isCalendarAccount,
  type BookingSystemId,
  type CalendarAccount,
  type CalendarTermsKind,
} from "@healdesk/catalog";

import { compose, EmailCompositionError } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * The practice's copy of a calendar election it recorded (plan §2.6): the
 * terms that now govern one location's Google Calendar in place of the
 * agreement's calendar clause.
 *
 * The clause is rendered here from the catalogue, from the three answers the
 * election recorded, rather than carried in the payload: a payload holds ids,
 * categories and dates only (lib/email/lint.ts), and the clause is a pure
 * function of those answers. The stored election, with its signature block
 * and hash, stays the record; this is the practice's copy of what it
 * agreed to. No link: the page it was accepted on has spent its link.
 */

export type CalendarElectionRecordedPayload = {
  electionId: string;
  /** The terms kind the election chose. */
  kind: CalendarTermsKind;
  /** The kind of Google account the practice named. */
  type: CalendarAccount;
  /** The booking system the practice named. */
  provider: BookingSystemId;
  electedAt: string;
};

export const renderCalendarElectionRecorded: EmailTemplate<CalendarElectionRecordedPayload> = (
  payload,
  ctx,
) => {
  if (!isCalendarAccount(payload.type) || !isBookingSystemId(payload.provider)) {
    throw new EmailCompositionError("A calendar election names a known account and system.");
  }
  const clause = calendarClauseBody({
    kind: payload.kind,
    account: payload.type,
    bookingSystem: payload.provider,
  });
  const on = new Intl.DateTimeFormat("en-US", {
    timeZone: ctx.timeZone,
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(payload.electedAt));
  const practice = ctx.clinicName ?? "your practice";
  const summary =
    payload.kind === "not_used"
      ? "healdesk does not connect to this location's Google Calendar, and your assistant takes each booking as a request for your staff to confirm."
      : "healdesk adds the bookings it makes to the calendar this location connects, as the terms below describe.";

  return compose(
    {
      subject: "Your calendar election was recorded",
      preheader: `${practice}'s calendar terms changed on ${on}.`,
      blocks: [
        {
          type: "paragraph",
          text: `${practice} recorded a calendar election on ${on}. For this location, it takes the place of the Google Calendar clause of your business associate agreement with healdesk. ${summary}`,
        },
        { type: "paragraph", text: "The terms you accepted:" },
        ...clause
          .split(/\n{2,}/)
          .map((paragraph) => paragraph.replace(/\s*\n\s*/g, " ").trim())
          .filter((paragraph) => paragraph.length > 0)
          .map((text) => ({ type: "paragraph" as const, text })),
        { type: "facts", rows: [["Election", payload.electionId]] },
        {
          type: "paragraph",
          text: "If nobody at your practice made this change, reply to this email.",
        },
      ],
    },
    ctx,
  );
};

export const CALENDAR_ELECTION_RECORDED_ENTRY: TemplateEntry<CalendarElectionRecordedPayload> = {
  render: renderCalendarElectionRecorded,
  fixture: {
    electionId: "7d0b2c1e-0000-4000-8000-000000000000",
    kind: "uncovered",
    type: "personal",
    provider: "google_calendar",
    electedAt: "2026-10-06T14:32:00.000Z",
  },
};
