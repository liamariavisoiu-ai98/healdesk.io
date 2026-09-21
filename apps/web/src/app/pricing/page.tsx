import { ALTERNATIVES } from "@healdesk/catalog";
import type { Metadata } from "next";

import { TrackView } from "@/components/analytics/TrackView";
import { CTA } from "@/components/CTA";
import { BuyModalProvider } from "@/components/BuyModal";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { PricingCards } from "@/components/PricingCards";
import {
  annualSavingsPercent,
  cheapestPlan,
  cheapestVoicePlan,
  usd,
} from "@/lib/pricing";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "What healdesk costs, and what it replaces. Five packages, monthly or " +
    "annual, a one-time setup fee, and every allowance stated up front.",
};

/**
 * "Channels per package", not a list of channels.
 *
 * The old first line promised voice, web chat, Instagram and WhatsApp in every
 * plan, which was true of the old three plans and is false of the five
 * packages: a voice-only package has no chat and a chat-only package has no
 * phone. The cards above say what each includes; this list must not say more.
 */
const INCLUDED = [
  "Channels per package: voice, web chat, Instagram DM and WhatsApp",
  "Booking requests handed to your desk with one click to confirm, call back or decline",
  "Your deposit rule stated on the call; the desk collects it",
  "Inbound only: the agent answers, and never calls or texts anyone on your behalf",
  "Closed-loop revenue reporting to your inbox",
  "A signed BAA, and read-only access to your systems",
] as const;

/**
 * Pricing, linked only from the footer.
 *
 * ## The hero has to be true
 *
 * It used to promise no setup fee, a free trial and no annual option, and all
 * three are now false: there is a one-time setup fee because a person builds
 * and QA-tests the agent before the clinic sees it, there is no trial because
 * a trial and a setup fee do not compose (see the catalog header), and annual
 * billing exists at a discount. So the hero says exactly those things, and it
 * reads them from the catalog rather than restating them.
 *
 * ## Why the comparison band is here and not a testimonial
 *
 * The number a clinic actually writes down is not ours in isolation, it is ours
 * against the thing it displaces, and both of those figures are sourced ranges
 * in the catalog (docs/launch-plan.md), not invented ones. A prospect who does
 * that arithmetic themselves trusts it in a way they do not trust a quote from
 * a clinic they have never heard of. The figure is the cheapest package WITH
 * VOICE, found by price rather than by position in the array: the two things
 * it is set against both answer the phone, and the cheapest package overall
 * (a chatbot) does not, so quoting it there would be a comparison the reader
 * could fairly call rigged. The modal's default package stays the cheapest
 * overall — that is a starting point, not a comparison.
 *
 * Allowances are capped and the cap is on screen. Every competitor caps them
 * too; saying so plainly costs nothing and pre-empts the "what's the catch"
 * that an unqualified "unlimited" invites.
 */
export default function PricingPage() {
  const entry = cheapestPlan();
  const voiceEntry = cheapestVoicePlan();
  const [receptionistLow, receptionistHigh] =
    ALTERNATIVES.inHouseReceptionistMonthlyUsd;
  const [serviceLow, serviceHigh] = ALTERNATIVES.answeringServiceMonthlyUsd;

  return (
    <BuyModalProvider initialPlan={entry.id}>
      <TrackView event="pricing_viewed" />
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
            Five packages, billed monthly or annually at{" "}
            {annualSavingsPercent()}% off. A one-time setup fee covers building
            and QA-testing your agent before it takes a call. Cancel at the end
            of any period.
          </p>
        </div>

        <PricingCards />

        {/* What it replaces. */}
        <section className="border-line mt-20 rounded-[24px] border bg-white p-7 sm:p-10">
          <h2 className="font-display text-[clamp(28.8px,3.6vw,40.8px)] leading-tight font-medium tracking-[-0.024em]">
            What {usd.format(voiceEntry.monthlyUsd)} a month is standing in for.
          </h2>
          <div className="mt-8 grid gap-8 sm:grid-cols-3">
            <Compare
              label="A full-time receptionist"
              value={`${usd.format(receptionistLow)}–${usd.format(receptionistHigh)}`}
              note="Loaded monthly cost. Works one shift, takes holidays, and still can't answer at 9pm."
            />
            <Compare
              label="An answering service"
              value={`${usd.format(serviceLow)}–${usd.format(serviceHigh)}`}
              note="Takes a message. Doesn't quote, doesn't qualify, doesn't book."
            />
            <Compare
              label={voiceEntry.name}
              value={usd.format(voiceEntry.monthlyUsd)}
              note="Answers the calls the desk missed, takes the booking request for the desk to confirm, and reports what collected."
              featured
            />
          </div>
          <p className="text-muted mt-7 max-w-[70ch] text-xs">
            Comparison ranges are sourced industry figures, not quotes for your
            market. They are here so you can do the arithmetic yourself. The
            healdesk figure is the entry voice package billed monthly, before
            the one-time setup fee.
          </p>
        </section>

        {/* What every package includes. */}
        <section className="mt-20">
          <h2 className="font-display text-[clamp(28.8px,3.6vw,40.8px)] leading-tight font-medium tracking-[-0.024em]">
            In every package.
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
