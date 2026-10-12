import { BOOKING_SYSTEMS, bookingSyncFor, manualBookingNotice } from "@healdesk/catalog";

import { connectedOn } from "@/lib/connections/calendar-links";
import { stepUpPath } from "@/lib/portal/step-up";
import {
  calendarNoticeWords,
  calendarStateOf,
  noticeFits,
  type AutoConfirmView,
  type CalendarNotice,
  type CalendarStep,
} from "@/lib/setup/calendar";

import { CalendarConnect, type CalendarConnectActions } from "./CalendarConnect";
import { CalendarScreen } from "./CalendarScreens";

/**
 * Setup 3.1 as the clinic sees it, from calendarStep's answer: the Google
 * panel only where Sign in with Google can work, the outcome Google's return
 * carried in words (when it fits the calendar as it stands), the booking
 * system with Change, and Auto-confirm with its "Right now" line
 * (autoConfirmFor, on effectiveBookingMode). Server-rendered and
 * synchronous, so the page awaits both and tests render this with any step.
 */
export function CalendarStepView(props: {
  slug: string;
  backHref: string | null;
  skipCost: string;
  step: CalendarStep;
  notice: CalendarNotice | null;
  /** The booking system as saved. */
  bookingSystem: string | null;
  autoConfirm: AutoConfirmView;
  /** The clinic's time zone, for the day the calendar was connected. */
  timeZone: string;
  /** Whether a passkey step-up is live on this session (portalActor). */
  steppedUp: boolean;
  actions: CalendarConnectActions;
}) {
  const { step } = props;
  const state = calendarStateOf(step);
  return (
    <CalendarScreen
      slug={props.slug}
      backHref={props.backHref}
      skipCost={props.skipCost}
      requestsOnly={step.kind === "requests_only"}
      notice={
        props.notice && noticeFits(props.notice, state)
          ? calendarNoticeWords(props.notice, step.kind === "google" ? step.account : null)
          : null
      }
      connect={
        step.kind === "google" ? (
          <CalendarConnect
            slug={props.slug}
            step={step}
            connectedOn={
              step.connection.status === "not_connected"
                ? null
                : connectedOn(step.connection.connectedAt, props.timeZone)
            }
            steppedUp={props.steppedUp}
            stepUpHref={stepUpPath(props.slug, `/c/${props.slug}/setup?s=calendar`)}
            actions={props.actions}
          />
        ) : null
      }
      bookingSystem={props.bookingSystem}
      systems={BOOKING_SYSTEMS.map((system) => ({ id: system.id, label: system.label }))}
      manualNotices={Object.fromEntries(
        BOOKING_SYSTEMS.map((system) => [
          system.id,
          bookingSyncFor(system.id) === "manual" ? manualBookingNotice(system.label) : null,
        ]),
      )}
      autoConfirm={props.autoConfirm}
    />
  );
}
