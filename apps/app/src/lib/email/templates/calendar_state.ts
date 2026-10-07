import { audienceSingular } from "@healdesk/catalog";

import { publicUrl } from "@/lib/public-url";

import { compose } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";
import { helpLine } from "./welcome";

/**
 * O13: "Calendar stopped working · reconnected" (Annex X5). The calendar
 * backend calls notifyCalendarState (lib/notices/calendar-state.ts) in the
 * transaction that records the change: the watch when a connection breaks,
 * the connect flow when a clinic reconnects after setup. Connecting during
 * setup sends nothing.
 *
 * A pointer, like every email about the practice's operation: what changed
 * and what it means, with a link to where it is put right, and nothing about
 * any booking.
 */

export type CalendarStatePayload = {
  /** When the backend recorded the change. */
  changedAt: string;
  /** Where the clinic reconnects: the wizard's calendar step until Settings → Calendar ships. */
  calendarUrl: string;
  helpPhoneE164: string | null;
};

export const renderCalendarStopped: EmailTemplate<CalendarStatePayload> = (payload, ctx) => {
  const clinic = ctx.clinicName ?? "your practice";
  return compose(
    {
      subject: "Your calendar connection stopped working",
      preheader: "Bookings arrive as requests until you reconnect it.",
      blocks: [
        {
          type: "paragraph",
          text: `AYA can no longer reach the Google Calendar ${clinic} connected, so bookings arrive as requests your team confirms until you reconnect it. Nothing already in your calendar has changed.`,
        },
        { type: "action", label: "Reconnect your calendar", url: payload.calendarUrl },
        {
          type: "paragraph",
          text: "Reconnecting takes one Google sign-in. It usually stops when a Google password changes or someone removes healdesk's access.",
        },
        { type: "paragraph", text: helpLine(payload, audienceSingular(ctx.audience)) },
      ],
    },
    ctx,
  );
};

export const renderCalendarReconnected: EmailTemplate<CalendarStatePayload> = (payload, ctx) => {
  const clinic = ctx.clinicName ?? "your practice";
  return compose(
    {
      subject: "Your calendar is connected again",
      preheader: "AYA can see your calendar again.",
      blocks: [
        {
          type: "paragraph",
          text: `The Google Calendar ${clinic} uses with healdesk is connected again, and AYA reads it again for times that are free.`,
        },
        { type: "action", label: "See your calendar settings", url: payload.calendarUrl },
        { type: "paragraph", text: helpLine(payload, audienceSingular(ctx.audience)) },
      ],
    },
    ctx,
  );
};

export const CALENDAR_STOPPED_ENTRY: TemplateEntry<CalendarStatePayload> = {
  render: renderCalendarStopped,
  get fixture(): CalendarStatePayload {
    return {
      changedAt: "2026-10-12T14:32:00Z",
      calendarUrl: publicUrl("/c/radiance-med-spa/setup?s=calendar"),
      helpPhoneE164: "+18885550100",
    };
  },
};

export const CALENDAR_RECONNECTED_ENTRY: TemplateEntry<CalendarStatePayload> = {
  render: renderCalendarReconnected,
  get fixture(): CalendarStatePayload {
    return {
      changedAt: "2026-10-12T15:10:00Z",
      calendarUrl: publicUrl("/c/radiance-med-spa/setup?s=calendar"),
      helpPhoneE164: null,
    };
  },
};
