"use client";

import { useId, useState } from "react";

import { Choice, ScreenShell } from "../ScreenShell";

/**
 * Step 3 · Calendar (plan Part E): 3.1 the calendar and how bookings arrive,
 * and 3.2 whether AYA books against named providers.
 *
 * The Google connection is the calendar backend's, and it is not in this
 * build (lib/setup/calendar.ts), so 3.1 says what is true today: bookings
 * arrive as requests your team confirms. No button that goes nowhere.
 */

type Common = { slug: string; backHref: string | null; skipCost: string };

export function CalendarScreen(
  props: Common & {
    bookingSystem: string | null;
    systems: readonly { id: string; label: string }[];
    rightNow: string;
    /** The manual-booking sentence for a system that does not read Google Calendar, per system. */
    manualNotices: Readonly<Record<string, string | null>>;
  },
) {
  const [system, setSystem] = useState(props.bookingSystem ?? "");
  const [changing, setChanging] = useState(props.bookingSystem === null);
  const selectId = useId();
  const label = props.systems.find((s) => s.id === system)?.label;
  const manual = system ? props.manualNotices[system] : null;

  return (
    <ScreenShell
      slug={props.slug}
      screen="calendar"
      title="Your calendar"
      intro={
        <p>
          Bookings arrive as requests your team confirms. AYA takes the person&rsquo;s details and
          the time they want, and your team books it in.
        </p>
      }
      skipCost={props.skipCost}
      backHref={props.backHref}
      payload={() => (system ? { bookingSystem: system } : {})}
    >
      <div className="rounded-xl border border-line bg-white px-4 py-3">
        <p className="text-sm font-semibold">Where your bookings live today</p>
        {changing ? (
          <div className="mt-2 grid gap-1">
            <label htmlFor={selectId} className="sr-only">
              Where your bookings live today
            </label>
            <select
              id={selectId}
              value={system}
              onChange={(event) => setSystem(event.target.value)}
              className="border-line min-h-11 rounded-lg border bg-white px-2"
            >
              <option value="" disabled>
                Choose one
              </option>
              {props.systems.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <p className="mt-1">
            {label}{" "}
            <button
              type="button"
              onClick={() => setChanging(true)}
              className="min-h-11 text-sm font-semibold underline"
            >
              Change
            </button>
          </p>
        )}
        {manual ? <p className="text-muted mt-2 text-sm">{manual}</p> : null}
      </div>
      <div className="rounded-xl border border-line bg-white px-4 py-3">
        <p className="text-sm font-semibold">Auto-confirm bookings</p>
        <p className="text-muted mt-1 text-sm">{props.rightNow}</p>
      </div>
    </ScreenShell>
  );
}

export function ProvidersScreen(props: Common & { providersRead: number }) {
  const [detail, setDetail] = useState<"generic" | "named_provider">("generic");
  return (
    <ScreenShell
      slug={props.slug}
      screen="providers"
      title="Book with anyone, or a named provider?"
      intro={
        props.providersRead > 0 ? (
          <p>
            Your website names{" "}
            {props.providersRead === 1 ? "1 provider" : `${props.providersRead} providers`}. Booking
            against each one&rsquo;s own calendar comes after your calendar is connected.
          </p>
        ) : (
          <p>
            Booking against each provider&rsquo;s own calendar comes after your calendar is
            connected.
          </p>
        )
      }
      skipCost={props.skipCost}
      backHref={props.backHref}
      payload={() => ({ bookingDetail: detail })}
    >
      <Choice
        legend="Booking detail"
        value={detail}
        onChange={setDetail}
        options={[
          {
            id: "generic",
            label: "Any available time",
            line: "Your team decides who sees each person.",
          },
          {
            id: "named_provider",
            label: "A named provider",
            line: "Available once your calendar is connected.",
            disabled: true,
          },
        ]}
      />
    </ScreenShell>
  );
}
