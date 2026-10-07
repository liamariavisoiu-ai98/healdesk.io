"use client";

import {
  type BillingInterval,
  OVERAGE_BLOCK_UNITS,
  OVERAGE_RATES_PROVISIONAL,
  planForCard,
  pricingCards,
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
import { site } from "@/lib/site";

/**
 * The five pricing cards on /pricing, with the monthly / annual toggle.
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

      {/* Six tracks of which each card spans two, so three fit a row and the
          fourth card can start on the second track: the second row of two is
          centred under the first row of three instead of leaving a hole at
          the right. A five-column row would squeeze every price. */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
        {pricingCards.map((card, i) => {
          // A twin card's two packages are priced identically (the catalog
          // test holds them to it), so either one states the card's terms.
          const plan = planForCard(card);
          const featured = Boolean(card.highlight);
          const overage = overageLine(plan);
          return (
            <div
              key={card.id}
              className={[
                "flex flex-col rounded-[22px] border p-7 sm:p-8 lg:col-span-2",
                i === 3 ? "lg:col-start-2" : "",
                featured ? "border-sun bg-sun/[0.16]" : "border-line bg-white",
              ].join(" ")}
            >
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="font-display text-[24px] font-medium tracking-[-0.02em]">
                  {card.name}
                </h2>
                {/* Ink on Tuscan Sun is 9.3:1. The same label set IN Sun on
                    the page ground would be 1.5:1 and unreadable. This
                    accent is a fill, never a text colour. */}
                {card.highlight ? (
                  <span className="bg-sun text-ink shrink-0 rounded-full px-2.5 py-1 text-[12.6px] font-bold tracking-[0.08em] uppercase">
                    {card.highlight}
                  </span>
                ) : null}
              </div>

              <div className="mt-3 flex flex-wrap gap-1.5">
                {channelChips(card).map((chip) => (
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
                {/* With the flag set, the row and the footnote say the same
                    thing: the rate is published before the first bill, and
                    nothing is billed until it is. With it off the block
                    prices print, marked provisional, because they are
                    placeholders until measured (see the catalog header); the
                    footnote says a started block is billed whole. */}
                <Row label="After that">
                  {overage
                    ? `${overage}, provisional`
                    : "at the rate we publish before your first bill"}
                </Row>
                <Row label="Locations">
                  {plan.locations === 1 ? "One" : `Up to ${plan.locations}`}
                </Row>
              </dl>

              <a
                href={`/get-started?plan=${encodeURIComponent(card.id)}&interval=${interval}`}
                className={[
                  // Flat rectangles, matching BuyButton: solid red on the
                  // featured card, outlined ink on the rest.
                  "mt-7 rounded-[6px] px-6 py-3.5 text-center text-[17px] font-semibold transition-colors duration-200",
                  featured
                    ? "bg-red hover:bg-red-deep text-white"
                    : "border-line-strong text-ink hover:border-ink border-[1.5px]",
                ].join(" ")}
              >
                {site.cta.primary.label}
              </a>
            </div>
          );
        })}
      </div>

      {/* Billed per started block since 6 October 2026 (docs/v1-product-spec.md,
          "Overage prices"): a month's extra units are rounded up to whole
          blocks, so the first one over costs a whole block, and the footnote
          says so rather than leaving "per block" on the cards to be read pro
          rata. */}
      <p className="text-muted mt-5 max-w-[80ch] text-xs">
        Voice minutes and chat conversations are capped because they are the
        real cost and they scale with how busy you are. Past the allowance you
        are billed for each started block of {OVERAGE_BLOCK_UNITS} minutes or{" "}
        {OVERAGE_BLOCK_UNITS} conversations, never moved to a higher tier
        without asking.
        {/* True because lib/billing.ts attaches no metered price while the
            flag is set: nothing CAN bill overage until the rates are live. */}
        {OVERAGE_RATES_PROVISIONAL
          ? " Overage is not billed until the rates are published, and you will see them in writing before they apply."
          : " The overage rates are provisional: they are placeholders until we have measured what a minute and a conversation really cost to serve."}
      </p>
      {/* Meta's own charge, not ours (docs/v1-product-spec.md, "Pricing
          consequences" and "Meta bot onboarding"). Every package with the
          Meta channel includes WhatsApp, so the note is unconditional. */}
      <p className="text-muted mt-2 max-w-[80ch] text-xs">
        Packages with Instagram, Messenger + WhatsApp: Meta bills you directly
        for WhatsApp messages, including replies inside its 24-hour window from
        1 October 2026, and we do not resell them. WhatsApp cannot send until
        your WhatsApp account has a payment method on it.
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
