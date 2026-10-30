import { needsYouEmptyLine, type NeedItem } from "@/lib/portal/home-summary";
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

export function WhatAyaDid({ headline, lines }: { headline: string; lines: readonly ClaimLine[] }) {
  return (
    <section aria-labelledby="week-heading" className="mt-10">
      <h2 id="week-heading" className="text-lg font-semibold">
        What AYA did this week
      </h2>
      <p className="mt-1">{headline}</p>
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
