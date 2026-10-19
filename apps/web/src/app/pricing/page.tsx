import {
  ALTERNATIVES,
  MAX_STEP_UNITS,
  MIN_STEP_UNITS,
  OVERAGE_BLOCK_UNITS,
  OVERAGE_RATES_PROVISIONAL,
  planFor,
  PRODUCTS,
  STEP_UNITS,
  USAGE_ALERT_PERCENT,
} from "@healdesk/catalog";
import type { Metadata } from "next";

import { TrackView } from "@/components/analytics/TrackView";
import { BuyButton, BuyModalProvider } from "@/components/BuyModal";
import { Footer } from "@/components/Footer";
import { JsonLd } from "@/components/JsonLd";
import { Nav } from "@/components/Nav";
import { PricingSheet } from "@/components/pricing/PricingSheet";
import {
  annualSavingsPercent,
  comparisonVoicePlan,
  extraBlockUsd,
  overageExample,
  setupFeeRangeLabel,
  usd,
} from "@/lib/pricing";
import { site } from "@/lib/site";
import { softwareApplicationLd } from "@/lib/structured-data";

export const metadata: Metadata = {
  alternates: { canonical: "/pricing" },
  // The category's words, the way a buyer searches for a price (strategy,
  // 14 October 2026); the H1 below stays the owner's.
  title: "AI receptionist pricing",
  description:
    "What AYA costs: pick a product, pick a usage step from 100 to 1,500 minutes or " +
    "conversations a month, and pay a one-time setup fee. Prices are per location; annual " +
    "billing is 20% off.",
};

/**
 * The date the prices below were set: the owner's pricing sheet. Printed with
 * them, because a price an answer engine quotes should carry its date.
 */
const PRICES_AS_OF = "13 October 2026";

/**
 * Every product's price in one sentence, from the catalog, so an answer to
 * "what does an AI receptionist cost" can be lifted whole and cannot drift
 * from checkout. The setup discount is not here: the website's 30% has its
 * own clock and copy, and the operator-demo 50% is never printed publicly.
 */
function priceSentence(): string {
  const { voice, webchat, metachat } = PRODUCTS;
  return (
    `As of ${PRICES_AS_OF}, ${voice.name} costs ${usd.format(voice.perStepMonthlyUsd)} a month per ` +
    `${String(STEP_UNITS)} voice minutes, ${webchat.name} ${usd.format(webchat.perStepMonthlyUsd)} and ` +
    `${metachat.name} ${usd.format(metachat.perStepMonthlyUsd)} per ${String(STEP_UNITS)} conversations, ` +
    `with a one-time setup fee of ${usd.format(voice.setupFeeUsd)}, ${usd.format(webchat.setupFeeUsd)} ` +
    `and ${usd.format(metachat.setupFeeUsd)} respectively.`
  );
}

/**
 * The sheet's worked example of mixing steps: 500 voice minutes and 300 web
 * chat conversations, from the catalog so the sentence cannot drift.
 */
const MIXED = planFor("voice-webchat", { voiceMinutes: 500, chatConversations: 300 });
const MIXED_VOICE = planFor("voice", { voiceMinutes: 500 });
const MIXED_CHAT = planFor("webchat", { chatConversations: 300 });

/**
 * "How it works", the sheet's three steps. The third says what is charged
 * today and when the plan starts, the deferred start in the catalog's words.
 */
const HOW_IT_WORKS = [
  {
    title: "Pick a product",
    body: `${PRODUCTS.voice.name} answers your phone. ${PRODUCTS.webchat.name} answers your website. ${PRODUCTS.metachat.name} answers Instagram, Messenger and WhatsApp, and your website too. Or take Voice with either chat.`,
  },
  {
    title: "Pick a usage step",
    body: `From ${MIN_STEP_UNITS} to ${MAX_STEP_UNITS.toLocaleString("en-US")} minutes or conversations a month, in steps of ${STEP_UNITS}. Voice and chat are chosen separately and added: ${MIXED_VOICE.includedVoiceMinutes} minutes and ${MIXED_CHAT.includedChatConversations} web chat conversations is ${usd.format(MIXED_VOICE.monthlyUsd)} + ${usd.format(MIXED_CHAT.monthlyUsd)} = ${usd.format(MIXED.monthlyUsd)} a month.`,
  },
  {
    title: "Pay",
    body: `The one-time setup fee today, for building and testing your assistant. Your monthly or annual price starts the day ${site.agent} first answers a patient, not before.`,
  },
] as const;

/**
 * The v1 product as docs/v1-product-spec.md states it: bookings written live
 * into the clinic's Google Calendar (auto-confirm on by default), deposits in
 * chat through the clinic's own checkout while voice flags them for the desk,
 * inbound only, and the v1 proof set, which is never revenue.
 */
const INCLUDED = [
  "Bookings written straight into your Google Calendar during the conversation (turn auto-confirm off to approve each one first)",
  "Deposits taken in chat through your own checkout link; phone bookings flagged for your desk to collect",
  "Inbound only: she answers, and never calls or texts anyone on your behalf",
  "Conversations handled, appointments booked, deposits collected and booked value, in your portal and a weekly email",
  "We sign a business associate agreement and handle patient data under it",
] as const;

/**
 * The setup promise, per channel, never global (docs/v1-product-spec.md,
 * "Honest headline timing"). Each line says how the channel goes live, never
 * when: no timing before purchase (the owner's rule of 6 October 2026).
 */
const LIVE_WHEN = [
  { channel: "Website chat", when: "Once the one-line snippet is on your site." },
  { channel: "Instagram and Messenger", when: "As soon as you connect them." },
  { channel: "WhatsApp", when: "Once your WhatsApp account has a payment method on it." },
  { channel: "Phone", when: "Once call forwarding is set on your line." },
] as const;

/**
 * /pricing, the owner's pricing sheet of 13 October 2026.
 *
 * The page was retired on 9 October 2026, when the seven fixed packages were
 * shown only in the buy flow. The sheet replaced those packages with three
 * products sold in usage steps, which a package card cannot show, and the
 * website's setup offer (lib/site-offer.ts) starts its 48-hour clock where
 * the prices are first seen; so the prices have a page again, linked from the
 * footer. Its order is the sheet's: how it works, the monthly price and setup
 * of each product, a calculator and "Find your step", what happens past a
 * step, and that prices are per location.
 *
 * ## What it never says
 *
 * Half off setup belongs to the personalised demo a clinic asked for and is
 * offered only there; this page prints the website's 30% and nothing else
 * (src/app/pricing/pricing-copy.test.ts). Overage is quoted per started block
 * of 100 at each product's extra-100 price, marked provisional, never as a
 * per-minute or per-conversation rate. No opening dates, no "revenue", and
 * the data line is the spec's: we sign a business associate agreement and
 * handle patient data under it.
 *
 * ## Why the comparison band is here
 *
 * The number a clinic writes down is ours against what it displaces, and
 * both of those figures are sourced ranges in the catalog (ALTERNATIVES), not
 * invented ones. The healdesk figure is AYA Voice at the sheet's own example
 * step, 500 minutes (`comparisonVoicePlan`): both alternatives answer a month
 * of calls, and the 100-minute entry step would not, so quoting it there would
 * be a comparison the reader could fairly call rigged.
 */
export default function PricingPage() {
  const example = overageExample();
  const voice = comparisonVoicePlan();
  const [receptionistLow, receptionistHigh] = ALTERNATIVES.inHouseReceptionistMonthlyUsd;
  const [serviceLow, serviceHigh] = ALTERNATIVES.answeringServiceMonthlyUsd;
  const wage = ALTERNATIVES.receptionistMedianWage;
  const wageMonthly = Math.round(wage.annualUsd / 12);

  return (
    <BuyModalProvider>
      <TrackView event="pricing_viewed" />
      <Nav />
      <JsonLd data={softwareApplicationLd()} />

      <main className="mx-auto max-w-[1240px] px-5 pt-16 sm:px-8 sm:pt-20 lg:px-14">
        <div className="max-w-[58ch]">
          <p className="eyebrow-tag">Pricing</p>
          <h1 className="font-display mt-3 text-[clamp(40.8px,6vw,69.6px)] leading-[1.03] font-medium tracking-[-0.028em]">
            Priced by how much she answers.
          </h1>
          <p className="text-muted mt-5 text-[20.4px] font-medium">
            Three products, each priced per {STEP_UNITS} minutes or conversations a month. Choose
            your step, pay a one-time setup fee of {setupFeeRangeLabel()} depending on the
            product, and your plan starts the day {site.agent} first answers a patient. Prices
            are per location; annual billing is {annualSavingsPercent()}% off.
          </p>
          <p className="text-muted mt-4 text-[16.5px] leading-[1.6]">{priceSentence()}</p>
        </div>

        <section aria-labelledby="how-heading" className="mt-16">
          <h2
            id="how-heading"
            className="font-display text-[clamp(28.8px,3.6vw,40.8px)] leading-tight font-medium tracking-[-0.024em]"
          >
            How it works.
          </h2>
          <ol className="mt-7 grid gap-6 md:grid-cols-3">
            {HOW_IT_WORKS.map((step, i) => (
              <li key={step.title} className="border-line border-t pt-5">
                <p className="text-red-deep font-figure text-[15px] font-bold">{i + 1}.</p>
                <p className="mt-1 text-[20px] font-semibold">{step.title}</p>
                <p className="text-muted mt-2 text-[16.2px] leading-[1.55] font-medium">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <PricingSheet />

        {/* What happens past a step: the sheet's 90% email, the extra-100
            price per started block, and its worked example, all from the
            catalog. */}
        <section aria-labelledby="over-heading" className="mt-20">
          <h2
            id="over-heading"
            className="font-display text-[clamp(28.8px,3.6vw,40.8px)] leading-tight font-medium tracking-[-0.024em]"
          >
            If you go over your step.
          </h2>
          <div className="text-muted mt-5 max-w-[68ch] space-y-4 text-[18px] leading-[1.55] font-medium">
            <p>
              When you have used {USAGE_ALERT_PERCENT}% of what your step includes, we send you a
              short email. You can move up a step, or do nothing.
            </p>
            {OVERAGE_RATES_PROVISIONAL ? (
              <p>
                If you do nothing, usage above your step is not billed until we publish its prices,
                and you will see them in writing before they apply.
              </p>
            ) : (
              <>
                <p>
                  If you do nothing, each started block of {OVERAGE_BLOCK_UNITS} past your step is
                  billed at that product&apos;s extra-100 price: {usd.format(extraBlockUsd("voice"))}{" "}
                  for voice minutes, {usd.format(extraBlockUsd("webchat"))} for{" "}
                  {PRODUCTS.webchat.name} conversations and {usd.format(extraBlockUsd("metachat"))}{" "}
                  for {PRODUCTS.metachat.name} conversations. The same applies above{" "}
                  {MAX_STEP_UNITS.toLocaleString("en-US")}. An extra block costs more than moving up a
                  step, so if you go over most months, move up.
                </p>
                <p className="border-line text-ink rounded-md border bg-white p-5">
                  For example: you chose {example.step} minutes ({usd.format(example.stepUsd)} a
                  month) and used {example.used}. That is {usd.format(example.stepUsd)} +{" "}
                  {usd.format(example.extraUsd)} for {example.blocks === 1 ? "one started block" : `${example.blocks} started blocks`}{" "}
                  of {OVERAGE_BLOCK_UNITS} = {usd.format(example.stepUsd + example.extraUsd)}. Moving
                  up to {example.nextStep} minutes would have cost {usd.format(example.nextStepUsd)}.
                </p>
                <p className="text-sm">
                  The extra-100 prices are provisional until we have measured what a minute and a
                  conversation cost to serve.
                </p>
              </>
            )}
          </div>
        </section>

        <section aria-labelledby="locations-heading" className="mt-20">
          <h2
            id="locations-heading"
            className="font-display text-[clamp(28.8px,3.6vw,40.8px)] leading-tight font-medium tracking-[-0.024em]"
          >
            Prices are per location.
          </h2>
          <p className="text-muted mt-4 max-w-[64ch] text-[18px] leading-[1.55] font-medium">
            Every price on this page covers one location. Each further location is added to the
            same plan from Billing in your portal, at the same plan price again and its own setup
            fee, and renews on the same date.
          </p>
        </section>

        {/* What it replaces. The wage is a wage, not a loaded cost, so the
            first figure shows the loaded range and the footnote says which is
            which; and the paragraph says what she does NOT do, because the
            comparison is only fair if it is honest about the desk work that
            stays with a person. */}
        <section className="border-line mt-20 rounded-lg border bg-white p-7 sm:p-10">
          <p className="eyebrow-tag">A smarter way to answer the phone</p>
          <h2 className="font-display mt-5 max-w-[22ch] text-[clamp(28.8px,3.6vw,40.8px)] leading-tight font-normal tracking-[-0.024em] text-balance">
            Why pay {usd.format(wageMonthly)} a month just to keep the phone covered?
          </h2>
          <p className="text-muted mt-4 max-w-[64ch] text-[18px] leading-[1.55] font-medium">
            That is what a receptionist earns at the U.S. median, before payroll taxes, benefits,
            and the evenings and weekends when nobody is at the desk anyway. {site.agent} answers
            the calls and books the appointments for a fraction of it. She does not greet anyone
            at the door or run the room, and we would not pretend she does. What she does is make
            sure the person who does those things is never also the person losing calls.
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
              label={voice.name}
              value={usd.format(voice.monthlyUsd)}
              note="Answers the calls the desk missed and books them straight into your calendar."
              featured
            />
          </div>
          <p className="text-muted mt-7 max-w-[76ch] text-xs">
            Wage comparison based on the {wage.period} U.S. median annual wage for receptionists of{" "}
            {usd.format(wage.annualUsd)}, or {usd.format(wageMonthly)} a month ({wage.source}). The
            full-time range above is a loaded cost and adds payroll taxes and benefits. All
            comparison figures are sourced industry numbers, not quotes for your market; they are
            here so you can do the arithmetic yourself. The healdesk figure is {voice.name}, billed
            monthly, before the one-time setup fee. {site.agent} handles calls, chat and
            scheduling; she does not replace in-person duties.
          </p>
        </section>

        <section className="mt-20">
          <h2 className="font-display text-[clamp(28.8px,3.6vw,40.8px)] leading-tight font-medium tracking-[-0.024em]">
            With every product.
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
          {/* Meta's own charge, not ours (docs/v1-product-spec.md, "Pricing
              consequences" and "Meta bot onboarding"). Meta Chat includes
              WhatsApp, so the note is unconditional. */}
          <p className="text-muted mt-6 max-w-[72ch] text-sm font-medium">
            With {PRODUCTS.metachat.name}, Meta bills you directly for WhatsApp messages, including
            replies inside its 24-hour window, and we do not resell them. WhatsApp cannot send
            until your WhatsApp account has a payment method on it.
          </p>
        </section>

        <section className="mt-20">
          <h2 className="font-display text-[clamp(28.8px,3.6vw,40.8px)] leading-tight font-medium tracking-[-0.024em]">
            About fifteen minutes of your time.
          </h2>
          <p className="text-muted mt-4 max-w-[62ch] text-[18px] leading-[1.55] font-medium">
            Confirm your services, prices and hours, set how she behaves, connect your Google
            Calendar, then connect each channel you bought. Each one goes live on its own:
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

        {/* The close. The calculator's button carries the plan it built; this
            one opens the buy flow in place, where the buyer chooses. */}
        <section className="mt-20 mb-24 flex flex-col items-start gap-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="font-display max-w-[30ch] text-[clamp(26px,3vw,34px)] leading-tight font-normal tracking-[-0.024em]">
            Hear her first, or start now.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <a
              href={`/${site.cta.secondary.href}`}
              className="border-line-strong text-ink hover:border-ink rounded-sm border-[1.5px] bg-white px-6 py-3.5 text-base font-semibold transition-colors"
            >
              {site.cta.secondary.label}
            </a>
            <BuyButton size="px-6 py-3.5 text-base" />
          </div>
        </section>
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
      <p className="text-muted text-[13.2px] font-bold tracking-[0.1em] uppercase">{label}</p>
      <p
        className={[
          "font-figure mt-2 text-[31.2px] leading-none font-semibold tabular-nums",
          featured ? "text-brand-gradient" : "",
        ].join(" ")}
      >
        {value}
        <span className="text-muted font-sans text-[15.6px] font-semibold">/mo</span>
      </p>
      <p className="text-muted mt-2.5 text-[16.2px] font-medium">{note}</p>
    </div>
  );
}
