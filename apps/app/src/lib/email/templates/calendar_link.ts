import { publicUrl } from "@/lib/public-url";

import { compose } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * The calendar link (plan §4.1): one location's single-use link to its
 * Google Calendar page, mailed only to the practice's own address.
 *
 * A link email (X1.5): the token is minted at send time and lives only in
 * this message, so this kind is sent straight and never through the outbox.
 * Three purposes, three wordings:
 *
 *   - `connect`: connect the calendar the assistant books into, or record the
 *     location's calendar terms first;
 *   - `change`: the practice owner's link to connect a different Google
 *     account, which someone at the practice asked for;
 *   - `confirm`: the practice owner's link to read and accept an election
 *     that widens what reaches Google, which someone at the practice chose.
 *
 * It says what the link does and that it works once, and names nothing but
 * the practice: no account, no calendar, nothing from a conversation.
 */

export type CalendarLinkPurpose = "connect" | "change" | "confirm";

export type CalendarLinkPayload = {
  /** publicUrl("/calendar/<token>"): the only place the token is ever written. */
  linkUrl: string;
  /** When the link stops working. */
  expiresAt: string;
  purpose: CalendarLinkPurpose;
};

export const renderCalendarLink: EmailTemplate<CalendarLinkPayload> = (payload, ctx) => {
  const until = new Intl.DateTimeFormat("en-US", {
    timeZone: ctx.timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(payload.expiresAt));
  const practice = ctx.clinicName ?? "your practice";
  const once = `The link works once, until ${until}. If it runs out, follow it anyway and ask for a new one: it goes to this address.`;

  switch (payload.purpose) {
    case "connect":
      return compose(
        {
          subject: "Connect your Google Calendar to healdesk",
          preheader: "Your assistant books into the calendar you connect.",
          blocks: [
            {
              type: "paragraph",
              text: `Use this link to connect the Google Calendar ${practice}'s assistant books into. The page says what healdesk reads and what it adds before you sign in with Google.`,
            },
            { type: "action", label: "Connect your calendar", url: payload.linkUrl },
            { type: "paragraph", text: once },
            {
              type: "paragraph",
              text: "Until a calendar is connected, your assistant takes each booking as a request for your staff to confirm.",
            },
          ],
        },
        ctx,
      );
    case "change":
      return compose(
        {
          subject: "Change the Google account healdesk books into",
          preheader: "Someone at your practice asked to connect a different account.",
          blocks: [
            {
              type: "paragraph",
              text: `Someone at ${practice} asked to connect a different Google account to healdesk. As the practice owner, use this link to sign in with the account whose calendar should take the bookings.`,
            },
            { type: "action", label: "Change the Google account", url: payload.linkUrl },
            { type: "paragraph", text: once },
            {
              type: "paragraph",
              text: "Nothing changes unless you use it. If you didn't expect this, reply to this email.",
            },
          ],
        },
        ctx,
      );
    case "confirm":
      return compose(
        {
          subject: "Please confirm a change to your calendar terms",
          preheader: "A change to how healdesk uses your calendar needs the owner.",
          blocks: [
            {
              type: "paragraph",
              text: `Someone at ${practice} chose to change how healdesk uses the practice's Google Calendar, in a way that needs the practice owner's agreement. Use this link to read the calendar election and accept it.`,
            },
            { type: "action", label: "Read and confirm", url: payload.linkUrl },
            { type: "paragraph", text: once },
            {
              type: "paragraph",
              text: "Nothing changes unless you confirm. If you didn't expect this, reply to this email.",
            },
          ],
        },
        ctx,
      );
  }
};

/** Token-shaped and never issued: what the snapshot tests and the seed script render. */
const FIXTURE_TOKEN = "Zq8vLm3TxR7wYb2NcK5pHs9JdF4gA6eU1oIiQ0yBtVw";

export const CALENDAR_LINK_ENTRY: TemplateEntry<CalendarLinkPayload> = {
  render: renderCalendarLink,
  // A getter, so the link is built from BETTER_AUTH_URL when a test or the
  // seed script reads it, not when this module loads.
  get fixture(): CalendarLinkPayload {
    return {
      linkUrl: publicUrl(`/calendar/${FIXTURE_TOKEN}`),
      expiresAt: "2026-10-13T14:32:00.000Z",
      purpose: "connect",
    };
  },
};
