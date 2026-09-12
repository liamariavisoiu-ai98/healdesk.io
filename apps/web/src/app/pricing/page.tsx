import { ALTERNATIVES, TRIAL_DAYS, plans } from "@healdesk/catalog";
import type { Metadata } from "next";

import { CTA } from "@/components/CTA";
import { BuyModalProvider } from "@/components/BuyModal";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "What healdesk costs, and what it replaces. No setup fee, a free trial, " +
    "and every minute cap stated up front.",
};

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const INCLUDED = [
  "Voice, SMS, web chat, Instagram DM and WhatsApp",
  "Automatic callbacks to missed numbers",
  "Booking written into your existing system or calendar",
  "Deposit links to cut no-shows",
  "Dormant-patient reactivation, with STOP on every message",
  "Closed-loop revenue reporting to your inbox",
  "A signed BAA, and read-only access to your systems",
] as const;

/**
 * Pricing, linked only from the footer.
 *
 * ## Why the comparison band is here and not a testimonial
 *
 * The number a clinic actually writes down is not ours in isolation, it is ours
 * against the thing it displaces, and both of those figures are sourced ranges
 * in the catalog (docs/launch-plan.md), not invented ones. A prospect who does
 * that arithmetic themselves trusts it in a way they do not trust a quote from
 * a clinic they have never heard of.
 *
 * Minutes are capped and the cap is on screen. Every competitor caps them too;
 * saying so plainly costs nothing and pre-empts the "what's the catch" that an
 * unqualified "unlimited" invites.
 */
export default function PricingPage() {
  const entry = plans[0]!;
  const [receptionistLow, receptionistHigh] =
    ALTERNATIVES.inHouseReceptionistMonthlyUsd;
  const [serviceLow, serviceHigh] = ALTERNATIVES.answeringServiceMonthlyUsd;

  return (
    <BuyModalProvider initialPlan={plans[0]!.id}>
      <Nav />

      <main className="mx-auto max-w-[1240px] px-5 pt-16 sm:px-8 sm:pt-20 lg:px-14">
        <div className="max-w-[54ch]">
          <p className="text-muted text-xs font-bold tracking-[0.14em] uppercase">
            Pricing
          </p>
          <h1 className="font-display mt-3 text-[clamp(40.8px,6vw,69.6px)] leading-[1.03] font-medium tracking-[-0.028em]">
            Less than a fortnight of a receptionist.
          </h1>
          <p className="text-muted mt-5 text-[20.4px] font-medium">
            No setup fee, a {TRIAL_DAYS}-day free trial, and every minute cap
            written down. Cancel whenever. There is no annual lock-in.
          </p>
        </div>

        <div className="mt-12 grid gap-4 lg:grid-cols-3">
          {plans.map((plan) => {
            const featured = Boolean(plan.highlight);
            return (
              <div
                key={plan.id}
                className={[
                  "flex flex-col rounded-[22px] border p-7 sm:p-8",
                  featured
                    ? "border-sun bg-sun/[0.16]"
                    : "border-line bg-white",
                ].join(" ")}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="font-display text-[26.4px] font-medium tracking-[-0.02em]">
                    {plan.name}
                  </h2>
                  {/* Ink on Tuscan Sun is 9.3:1. The same label set IN Sun on
                      the page ground would be 1.5:1 and unreadable. This
                      accent is a fill, never a text colour. */}
                  {plan.highlight ? (
                    <span className="bg-sun text-ink rounded-full px-2.5 py-1 text-[12.6px] font-bold tracking-[0.08em] uppercase">
                      Most picked
                    </span>
                  ) : null}
                </div>

                <p className="font-figure mt-4 text-[48px] leading-none font-semibold tracking-[-0.03em] tabular-nums">
                  {currency.format(plan.monthlyUsd)}
                  <span className="text-muted font-sans text-[18px] font-semibold">
                    /mo
                  </span>
                </p>

                <dl className="text-muted mt-6 space-y-2 text-[16.2px]">
                  <Row label="Setup fee">
                    {plan.setupFeeUsd === 0
                      ? "None"
                      : currency.format(plan.setupFeeUsd)}
                  </Row>
                  <Row label="Included minutes">
                    {plan.includedMinutes.toLocaleString()}/mo
                  </Row>
                  <Row label="After that">
                    ${plan.overagePerMinuteUsd.toFixed(2)}/min
                  </Row>
                  <Row label="Locations">
                    {plan.locations === 1 ? "One" : `Up to ${plan.locations}`}
                  </Row>
                </dl>

                <a
                  href="/get-started"
                  className={[
                    "mt-7 rounded-full px-6 py-3.5 text-center text-[18px] font-bold transition-transform duration-200 hover:-translate-y-px",
                    featured
                      ? "bg-brand-gradient shadow-brand text-white"
                      : "border-line-strong text-ink hover:border-ink border-[1.5px]",
                  ].join(" ")}
                >
                  Start free trial
                </a>
              </div>
            );
          })}
        </div>

        <p className="text-muted mt-5 text-xs">
          Minutes are capped because voice minutes are the real cost and they
          scale with how busy you are. Overage is billed at the rate above, never
          as a surprise tier change.
        </p>

        {/* What it replaces. */}
        <section className="border-line mt-20 rounded-[24px] border bg-white p-7 sm:p-10">
          <h2 className="font-display text-[clamp(28.8px,3.6vw,40.8px)] leading-tight font-medium tracking-[-0.024em]">
            What {currency.format(entry.monthlyUsd)} a month is standing in for.
          </h2>
          <div className="mt-8 grid gap-8 sm:grid-cols-3">
            <Compare
              label="A full-time receptionist"
              value={`${currency.format(receptionistLow)}–${currency.format(receptionistHigh)}`}
              note="Loaded monthly cost. Works one shift, takes holidays, and still can't answer at 9pm."
            />
            <Compare
              label="An answering service"
              value={`${currency.format(serviceLow)}–${currency.format(serviceHigh)}`}
              note="Takes a message. Doesn't quote, doesn't qualify, doesn't book."
            />
            <Compare
              label={site.agent}
              value={`${currency.format(entry.monthlyUsd)}`}
              note="Answers everything, books it, calls back what was missed, and reports what collected."
              featured
            />
          </div>
          <p className="text-muted mt-7 max-w-[70ch] text-xs">
            Comparison ranges are sourced industry figures, not quotes for your
            market. They are here so you can do the arithmetic yourself.
          </p>
        </section>

        {/* What every plan includes. */}
        <section className="mt-20">
          <h2 className="font-display text-[clamp(28.8px,3.6vw,40.8px)] leading-tight font-medium tracking-[-0.024em]">
            In every plan.
          </h2>
          <ul className="mt-7 grid gap-x-10 gap-y-3 sm:grid-cols-2">
            {INCLUDED.map((item) => (
              <li key={item} className="flex gap-2.5 text-[18px] font-medium">
                <span aria-hidden className="text-red-deep mt-px shrink-0">
                  ✓
                </span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
          <p className="text-muted mt-6 max-w-[62ch] text-sm font-medium">
            And nothing for your team to log into. There is no console, no seats
            and no software to learn, bookings land where they already land, and
            the report arrives in your inbox.
          </p>
        </section>

        <CTA />
      </main>

      <Footer />
    </BuyModalProvider>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt>{label}</dt>
      <dd className="text-ink font-semibold">{children}</dd>
    </div>
  );
}

function Compare({
  label,
  value,
  note,
  featured,
}: {
  label: string;
  value: string;
  note: string;
  featured?: boolean;
}) {
  return (
    <div className="border-line border-t pt-5">
      <p className="text-muted text-[13.2px] font-bold tracking-[0.1em] uppercase">
        {label}
      </p>
      <p
        className={[
          "font-figure mt-2 text-[31.2px] leading-none font-semibold tabular-nums",
          featured ? "text-brand-gradient" : "",
        ].join(" ")}
      >
        {value}
        <span className="text-muted font-sans text-[15.6px] font-semibold">
          /mo
        </span>
      </p>
      <p className="text-muted mt-2.5 text-[16.2px] font-medium">{note}</p>
    </div>
  );
}
