import { ALTERNATIVES } from "@healdesk/catalog";
import type { Metadata } from "next";

import { TrackView } from "@/components/analytics/TrackView";
import { CTA } from "@/components/CTA";
import { BuyModalProvider } from "@/components/BuyModal";
import { Footer } from "@/components/Footer";
import { Guarantee } from "@/components/Guarantee";
import { Nav } from "@/components/Nav";
import { PricingCards } from "@/components/PricingCards";
import { site } from "@/lib/site";
import {
  annualSavingsPercent,
  cheapestPlan,
  cheapestVoicePlan,
  usd,
} from "@/lib/pricing";

export const metadata: Metadata = {
  alternates: { canonical: "/pricing" },
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
 *
 * The rest is the v1 product as docs/v1-product-spec.md states it: bookings
 * written live into the clinic's Google Calendar (auto-confirm on by
 * default; off makes every booking a request staff approve), deposits taken
 * in chat through the clinic's own checkout while voice flags them for the
 * desk, inbound only, and the v1 proof set. That set is conversations,
 * bookings, deposits and booked value; never revenue, which needs phase-two
 * read-back from the clinic's point of sale.
 */
const INCLUDED = [
  "Channels per package: phone, website chat, Instagram, Messenger and WhatsApp",
  "Bookings written straight into your Google Calendar during the conversation (turn auto-confirm off to approve each one first)",
  "Deposits taken in chat through your own checkout link; phone bookings flagged for your desk to collect",
  "Inbound only: the agent answers, and never calls or texts anyone on your behalf",
  "Conversations handled, appointments booked, deposits collected and booked value, in your portal and a weekly email",
  "A signed BAA, and the only system we write to is the Google Calendar you connect",
] as const;

/**
 * The setup promise, per channel, never global (docs/v1-product-spec.md,
 * "Honest headline timing"). Two channels wait on things outside our hands:
 * the clinic's call forwarding and its own WhatsApp billing.
 */
const LIVE_WHEN = [
  { channel: "Website chat", when: "Once the one-line snippet is on your site." },
  { channel: "Instagram and Messenger", when: "As soon as you connect them." },
  { channel: "WhatsApp", when: "Once your WhatsApp account has a payment method on it." },
  { channel: "Phone", when: "Once call forwarding is set on your line, usually the same day." },
] as const;

/**
 * Pricing, linked only from the footer.
 *
 * ## The hero has to be true
 *
 * It used to promise no setup fee, a free trial and no annual option, and all
 * three are now false: there is a one-time setup fee because the agent is
 * built and must pass its pre-launch audit before any channel answers a
 * patient, there is no trial because
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
  const wage = ALTERNATIVES.receptionistMedianWage;
  const wageMonthly = Math.round(wage.annualUsd / 12);

  return (
    <BuyModalProvider initialPlan={entry.id}>
      <TrackView event="pricing_viewed" />
      <Nav />

      <main className="mx-auto max-w-[1240px] px-5 pt-16 sm:px-8 sm:pt-20 lg:px-14">
        <div className="max-w-[54ch]">
          <p className="eyebrow-tag">
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

        {/* What it replaces.

            The frame is the U.S. median receptionist wage, stated as a monthly
            figure, after the way reception.ai puts the same question: the
            reader should see a number they recognise from their own payroll
            before they see ours. The wage is a wage, not a loaded cost, so the
            first card still shows the loaded range and the footnote says which
            is which. And the paragraph says what she does NOT do, in the same
            breath, because the comparison is only fair if it is honest about
            the desk work that stays with a person. */}
        <section className="border-line mt-20 rounded-[24px] border bg-white p-7 sm:p-10">
          <p className="eyebrow-tag">A smarter way to answer every call</p>
          <h2 className="font-display mt-5 max-w-[22ch] text-[clamp(28.8px,3.6vw,40.8px)] leading-tight font-normal tracking-[-0.024em] text-balance">
            Why pay {usd.format(wageMonthly)} a month just to keep the phone covered?
          </h2>
          <p className="text-muted mt-4 max-w-[64ch] text-[18px] leading-[1.55] font-medium">
            That is what a receptionist earns at the U.S. median, before payroll taxes, benefits,
            and the evenings and weekends when nobody is at the desk anyway. {site.agent} answers
            the calls and books the appointments for a fraction of it. She does not greet
            anyone at the door or run the room, and we would not pretend she does. What she does
            is make sure the person who does those things is never also the person losing calls.
          </p>
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
              note="Answers the calls the desk missed and books them straight into your calendar."
              featured
            />
          </div>
          <p className="text-muted mt-7 max-w-[76ch] text-xs">
            Wage comparison based on the {wage.period} U.S. median annual wage for receptionists
            of {usd.format(wage.annualUsd)}, or {usd.format(wageMonthly)} a month ({wage.source}).
            The full-time range above is a loaded cost and adds payroll taxes and benefits. All
            comparison figures are sourced industry numbers, not quotes for your market; they are
            here so you can do the arithmetic yourself. The healdesk figure is the entry voice
            package billed monthly, before the one-time setup fee. {site.agent} handles calls,
            chat and scheduling; she does not replace in-person duties.
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
            Nothing to install and nothing to learn. A small portal, signed into
            from an emailed link, holds your switches, every conversation and
            every booking, and a weekly email sums it up.
          </p>
        </section>

        {/* The guarantee, word for word the same as terms § 5 (see Guarantee.tsx). */}
        <Guarantee />

        {/* When each channel goes live. */}
        <section className="mt-20">
          <h2 className="font-display text-[clamp(28.8px,3.6vw,40.8px)] leading-tight font-medium tracking-[-0.024em]">
            About fifteen minutes of your time.
          </h2>
          <p className="text-muted mt-4 max-w-[62ch] text-[18px] leading-[1.55] font-medium">
            Confirm your services, prices and hours, set how she behaves, connect
            your Google Calendar, then connect each channel you bought. Each one
            goes live on its own:
          </p>
          <dl className="mt-7 grid gap-x-10 gap-y-4 sm:grid-cols-2">
            {LIVE_WHEN.map((item) => (
              <div key={item.channel} className="border-line border-t pt-4">
                <dt className="text-[18px] font-semibold">{item.channel}</dt>
                <dd className="text-muted mt-1 text-[16.2px] font-medium">{item.when}</dd>
              </div>
            ))}
          </dl>
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
