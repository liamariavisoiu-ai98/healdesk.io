"use client";

import {
  type BillingInterval,
  OVERAGE_RATES_PROVISIONAL,
  plans,
} from "@healdesk/catalog";
import { useState } from "react";

import {
  allowanceRows,
  annualSavingsPercent,
  annualTotalLabel,
  channelChips,
  monthlyFigureUsd,
  overageLine,
  usd,
} from "@/lib/pricing";

/**
 * The five package cards on /pricing, with the monthly / annual toggle.
 *
 * A client component only because the toggle is state; the page around it
 * stays a server component so the metadata and the comparison band render
 * without JavaScript. The cards render server-side too, on the monthly
 * default, so a visitor with scripts blocked still sees every price.
 *
 * ## Why the grid wraps rather than forcing five columns
 *
 * Five cards across is 200px each on a 1240px page, which is too narrow for
 * "Included chat conversations" to sit on one line and far too narrow for a
 * price to read as a headline. Two columns on tablet, three on desktop, and
 * the fifth card sits alone on its row, which is fine: it is the Complete
 * package and it can carry the space.
 *
 * ## Every row is rendered for every package, including the empty ones
 *
 * A voice-only package has no chat allowance and a chat-only package has no
 * voice minutes. The row is still there, with an em dash, so the cards line up
 * and the absence is visible rather than implied — `allowanceRows()` in
 * lib/pricing.ts, shared with the checkout's package cards so both surfaces
 * state that policy the same way.
 *
 * ## The toggle is two pressed buttons, not a radio group
 *
 * `role="radio"` promises the arrow-key pattern a screen reader user expects
 * of a radio group, and two native buttons do not provide it. `aria-pressed`
 * describes exactly what they are: toggle buttons, each a Tab stop, Enter or
 * Space to press. Same construction as the checkout's IntervalToggle.
 */
export function PricingCards({
  initialInterval = "month",
}: {
  initialInterval?: BillingInterval;
}) {
  const [interval, setBillingInterval] = useState<BillingInterval>(initialInterval);
  const options: { id: BillingInterval; label: string; badge?: string }[] = [
    { id: "month", label: "Monthly" },
    { id: "year", label: "Annual", badge: `Save ${annualSavingsPercent()}%` },
  ];

  return (
    <>
      <div
        role="group"
        aria-label="Billing period"
        className="border-line mt-10 inline-flex rounded-full border bg-white p-1"
      >
        {options.map((option) => {
          const on = option.id === interval;
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={on}
              onClick={() => setBillingInterval(option.id)}
              className={[
                "inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-bold transition-colors",
                on ? "bg-ink text-white" : "text-muted hover:text-ink",
              ].join(" ")}
            >
              {option.label}
              {option.badge ? (
                <span
                  className={[
                    "rounded-full px-2 py-0.5 text-[11px] font-bold tracking-[0.06em] uppercase",
                    on ? "bg-white/15 text-white" : "bg-sun text-ink",
                  ].join(" ")}
                >
                  {option.badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {plans.map((plan) => {
          const featured = Boolean(plan.highlight);
          const overage = overageLine(plan);
          return (
            <div
              key={plan.id}
              className={[
                "flex flex-col rounded-[22px] border p-7 sm:p-8",
                featured ? "border-sun bg-sun/[0.16]" : "border-line bg-white",
              ].join(" ")}
            >
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="font-display text-[24px] font-medium tracking-[-0.02em]">
                  {plan.name}
                </h2>
                {/* Ink on Tuscan Sun is 9.3:1. The same label set IN Sun on
                    the page ground would be 1.5:1 and unreadable. This
                    accent is a fill, never a text colour. */}
                {plan.highlight ? (
                  <span className="bg-sun text-ink shrink-0 rounded-full px-2.5 py-1 text-[12.6px] font-bold tracking-[0.08em] uppercase">
                    {plan.highlight}
                  </span>
                ) : null}
              </div>

              <div className="mt-3 flex flex-wrap gap-1.5">
                {channelChips(plan).map((chip) => (
                  <span
                    key={chip}
                    className="bg-paper-2 text-muted rounded-full px-2.5 py-1 text-[12.6px] font-bold"
                  >
                    {chip}
                  </span>
                ))}
              </div>

              <p className="font-figure mt-5 text-[48px] leading-none font-semibold tracking-[-0.03em] tabular-nums">
                {usd.format(monthlyFigureUsd(plan, interval))}
                <span className="text-muted font-sans text-[18px] font-semibold">
                  /mo
                </span>
              </p>
              {/* Kept in the flow at both settings so the cards do not jump
                  when the toggle flips. */}
              <p className="text-muted mt-2 min-h-[1.5em] text-sm font-medium">
                {interval === "year"
                  ? `${annualTotalLabel(plan)} billed annually`
                  : "Billed monthly"}
              </p>

              <dl className="text-muted mt-6 space-y-2 text-[16.2px]">
                <Row label="Setup fee">
                  {usd.format(plan.setupFeeUsd)} once
                </Row>
                {allowanceRows(plan).map((row) => (
                  <Row key={row.label} label={row.label}>
                    {row.value}
                  </Row>
                ))}
                {/* While the rates are provisional the row and the footnote
                    say the same thing: the rate is published before the
                    first bill, and nothing is billed until it is. */}
                <Row label="After that">
                  {overage ?? "at the rate we publish before your first bill"}
                </Row>
                <Row label="Locations">
                  {plan.locations === 1 ? "One" : `Up to ${plan.locations}`}
                </Row>
              </dl>

              <a
                href={`/get-started?plan=${encodeURIComponent(plan.id)}&interval=${interval}`}
                className={[
                  "mt-7 rounded-full px-6 py-3.5 text-center text-[18px] font-bold transition-transform duration-200 hover:-translate-y-px",
                  featured
                    ? "bg-brand-gradient shadow-brand text-white"
                    : "border-line-strong text-ink hover:border-ink border-[1.5px]",
                ].join(" ")}
              >
                Get started
              </a>
            </div>
          );
        })}
      </div>

      <p className="text-muted mt-5 max-w-[80ch] text-xs">
        Voice minutes and chat conversations are capped because they are the
        real cost and they scale with how busy you are. Past the allowance you
        are billed per minute or per conversation, never moved to a higher tier
        without asking.
        {/* True because lib/billing.ts attaches no metered price while the
            flag is set: nothing CAN bill overage until the rates are live. */}
        {OVERAGE_RATES_PROVISIONAL
          ? " Overage is not billed until the rates are published, and you will see them in writing before they apply."
          : null}
      </p>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt>{label}</dt>
      <dd className="text-ink text-right font-semibold">{children}</dd>
    </div>
  );
}
