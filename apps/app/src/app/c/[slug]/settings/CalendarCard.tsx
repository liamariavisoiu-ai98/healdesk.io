import { portalMoment } from "@/lib/portal/format";
import type { CalendarCardView } from "@/lib/portal/settings-calendar";

import {
  AutoConfirmSwitch,
  BookingDetailControls,
  ConnectedCalendarControls,
  GoogleSignIn,
} from "./CalendarControls";
import { Card } from "./SettingsCards";
import { SwitchExplainer } from "./SwitchExplainer";

/**
 * Settings → Calendar (plan Part F2): the connected calendar with Change,
 * Reconnect and Disconnect; where bookings live today; Auto-confirm with its
 * "Right now: …"; and the booking detail. A server component around the
 * client controls in ./CalendarControls.tsx; what it reads is
 * lib/portal/settings-calendar.ts.
 *
 * Its states:
 *   - a sign-in cannot start (Google not set up here, or the location's
 *     terms leave healdesk no calendar to use): why, and no Google button;
 *   - not connected: Google's notice, its unticked box and "Sign in with
 *     Google";
 *   - connected: the account and the calendar, with Change and Reconnect
 *     while a sign-in could start, and Disconnect always; a connection that
 *     stopped or needs the new notice says so beside Reconnect.
 */
export function CalendarCard({
  card,
  timeZone,
  now,
  fullPaymentOn = false,
}: {
  /** Full payment is on, so turning Auto-confirm off moves it: say so beside the switch. */
  fullPaymentOn?: boolean;
  card: CalendarCardView;
  timeZone: string;
  now: Date;
}) {
  const { connection } = card;
  return (
    <Card id="calendar" title="Calendar">
      {card.outcome ? (
        <p
          className={`my-3 rounded-md border px-4 py-3 text-sm ${
            card.outcome.ok ? "border-line bg-tint-mint" : "border-problem-line text-problem"
          }`}
        >
          {card.outcome.text}
        </p>
      ) : null}
      <div className="py-3">
        <p className="font-semibold">Connected calendar</p>
        {connection ? (
          <>
            <p className="mt-1 text-sm">
              {connection.email ? `${connection.email}, ` : ""}
              {connection.account}, booking into {connection.calendar}.
              {connection.lastCheckedAt
                ? ` Last checked ${portalMoment(connection.lastCheckedAt, timeZone, now)}.`
                : ""}
            </p>
            {connection.healthLine ? (
              <p className="mt-1 text-sm text-problem">{connection.healthLine}</p>
            ) : null}
            {!card.canConnect && card.blockedLine ? (
              <p className="text-muted mt-1 text-sm">{card.blockedLine}</p>
            ) : null}
            <ConnectedCalendarControls
              slug={card.slug}
              disclosure={card.disclosure}
              canConnect={card.canConnect}
              canList={card.canConnect && connection.health === "healthy"}
            />
          </>
        ) : card.canConnect ? (
          <>
            <p className="text-muted mt-1 text-sm">
              Not connected. Bookings arrive as requests your team confirms until you connect the
              Google Calendar your appointments live in.
            </p>
            <GoogleSignIn
              slug={card.slug}
              disclosure={card.disclosure}
              label="Sign in with Google"
            />
          </>
        ) : (
          <p className="text-muted mt-1 text-sm">
            Not connected. {card.blockedLine} Bookings arrive as requests your team confirms.
          </p>
        )}
      </div>
      <div className="py-3">
        <p className="font-semibold">Where bookings live today</p>
        <p className="text-muted mt-1 text-sm">
          {card.bookingSystem ?? "Not said yet."}{" "}
          <a href={`/c/${card.slug}/setup?s=calendar`} className="text-ink font-semibold underline">
            Change
          </a>
        </p>
      </div>
      <AutoConfirmSwitch
        slug={card.slug}
        initial={card.autoConfirm}
        rightNow={card.rightNow}
        explainerId={fullPaymentOn ? "explain-auto-confirm" : undefined}
        explainer={
          fullPaymentOn ? (
            <SwitchExplainer
              id="explain-auto-confirm"
              note="Turning this off also sets “What AYA asks the patient to pay” back to Deposit only, and we tell you."
              picture={{ mode: "resets", from: "Auto-confirm", to: "Full payment" }}
            />
          ) : undefined
        }
      />
      <BookingDetailControls
        slug={card.slug}
        detail={card.bookingDetail}
        providersPossible={card.providersPossible}
      />
    </Card>
  );
}
