import { needsYouEmptyLine, type HomeTile, type NeedItem } from "@/lib/portal/home-summary";
import type { WeekDay } from "@/lib/portal/week-schedule";
import type { ClaimLine } from "@/lib/reporting/claim-words";

/**
 * Home's two answers, as one calm list each. Static markup with no motion, so
 * nothing depends on prefers-reduced-motion; every action is a real link with
 * a 44px target, and each region is named by its heading. The app has one
 * (light) theme, so these use the portal's tokens like every other screen.
 */

export function NeedsYou({ items, answering }: { items: readonly NeedItem[]; answering: boolean }) {
  return (
    <section aria-labelledby="attention-heading" className="mt-6">
      <h2 id="attention-heading" className="text-lg font-semibold">
        Needs you
      </h2>
      {items.length === 0 ? (
        <p className="border-line text-muted mt-3 rounded-md border bg-white px-4 py-3">
          {needsYouEmptyLine(answering)}
        </p>
      ) : (
        <ul className="mt-3 grid gap-2">
          {items.map((item) => (
            <li
              key={item.key}
              className="border-line flex flex-wrap items-center justify-between gap-3 rounded-md border bg-white px-4 py-3"
            >
              <span className="min-w-0">{item.text}</span>
              {item.action ? (
                <a
                  href={item.action.href}
                  className="bg-ink inline-flex min-h-11 items-center rounded-full px-5 text-sm font-bold text-white"
                >
                  {item.action.label}
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function WhatAyaDid({
  headline,
  lines,
  tiles = [],
}: {
  headline: string;
  lines: readonly ClaimLine[];
  /** Home's three big numbers (homeTiles); shown above the sentence. */
  tiles?: readonly HomeTile[];
}) {
  return (
    <section aria-labelledby="week-heading" className="mt-10">
      <h2 id="week-heading" className="text-lg font-semibold">
        What AYA did this week
      </h2>
      {tiles.length > 0 ? (
        <ul className="mt-3 grid gap-3 sm:grid-cols-3">
          {tiles.map((tile) => (
            <li
              key={tile.key}
              className={`border-line rounded-lg border px-5 py-5 shadow-sm ${
                tile.key === "value" ? "bg-gradient-to-br from-white to-tint-peach/60" : "bg-white"
              }`}
            >
              <p className="text-muted text-xs font-semibold tracking-wider uppercase">{tile.label}</p>
              <p className="mt-1 text-4xl font-bold tracking-tight">{tile.value}</p>
              <p className="text-muted mt-1 text-sm">{tile.hint}</p>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-3">{headline}</p>
      <p className="text-muted mt-1 text-sm">The last 7 days.</p>
      {lines.length > 1 ? (
        <dl className="border-line mt-3 grid gap-2 rounded-md border bg-white px-4 py-3">
          {lines.map((line) => (
            <div key={line.label} className="flex flex-wrap items-baseline justify-between gap-x-3">
              <dt className="text-muted">{line.label}</dt>
              <dd className="font-semibold">{line.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

/**
 * This week on the calendar, Monday to Sunday (portal redesign, owner,
 * 1 November 2026): how many appointments are on each day, and one tap into
 * Bookings for who and when. Counts only, because Home opens without the
 * passkey step-up and Bookings does not (lib/portal/week-schedule.ts).
 */
export function WeekAtAGlance({
  days,
  bookingsHref,
}: {
  days: readonly WeekDay[];
  bookingsHref: string | null;
}) {
  const total = days.reduce((sum, d) => sum + d.count, 0);
  return (
    <section aria-labelledby="calendar-heading" className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="calendar-heading" className="text-lg font-semibold">
          This week on your calendar
        </h2>
        {bookingsHref ? (
          <a href={bookingsHref} className="text-sm font-semibold underline underline-offset-2">
            Open Bookings
          </a>
        ) : null}
      </div>
      <ol className="mt-3 grid grid-cols-7 gap-1.5 sm:gap-2">
        {days.map((d) => (
          <li
            key={d.date}
            aria-label={`${d.label} ${d.dayOfMonth}: ${d.count} ${d.count === 1 ? "appointment" : "appointments"}${d.isToday ? ", today" : ""}`}
            className={`flex min-h-28 flex-col items-center rounded-md px-1 py-3 text-center ${
              d.isToday ? "border-ink border-2 bg-white" : "bg-paper-2"
            }`}
          >
            <span className="text-muted text-xs font-semibold">{d.label}</span>
            <span className="text-sm font-semibold">{d.dayOfMonth}</span>
            {d.count > 0 ? (
              <span className="border-orange bg-tint-peach mt-3 inline-flex min-w-9 items-center justify-center rounded-sm border px-2 py-1.5 text-sm font-bold">
                {d.count}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
      <p className="text-muted mt-2 text-sm">
        {total === 0
          ? "Nothing on the calendar this week yet."
          : `${total} ${total === 1 ? "appointment" : "appointments"} this week. Names, treatments and times are in Bookings, on a device with your passkey.`}
      </p>
    </section>
  );
}

/** Shown in place of the page when Home's numbers could not be read. */
export function HomeUnavailable() {
  return (
    <div role="alert" className="border-line mt-6 rounded-md border bg-white px-4 py-3">
      <p className="font-semibold">We could not load Home just now.</p>
      <p className="text-muted mt-1 text-sm">
        Nothing is wrong with AYA because of this. Reload the page in a minute; the other screens in
        the menu still work.
      </p>
    </div>
  );
}
