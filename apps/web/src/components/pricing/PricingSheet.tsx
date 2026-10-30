"use client";

import {
  type BillingInterval,
  type ChatProductId,
  DEFAULT_STEPS,
  MAX_STEP_UNITS,
  MIN_STEP_UNITS,
  OVERAGE_RATES_PROVISIONAL,
  type Package,
  type PackageId,
  PACKAGES,
  packageSetupFeeUsd,
  planFor,
  type ProductId,
  PRODUCTS,
  SITE_SETUP_CREDIT,
  setupAfterCreditUsd,
  STEP_UNITS,
  USAGE_STEPS,
} from "@healdesk/catalog";
import { useId, useState } from "react";

import { useBuy } from "@/components/BuyModal";
import {
  annualSavingsPercent,
  annualTotalLabel,
  extraBlockUsd,
  monthlyFigureUsd,
  packageChips,
  perStepUsd,
  usd,
} from "@/lib/pricing";
import { site } from "@/lib/site";

import { countdownLabel, type SiteOffer, useSiteOffer } from "./use-site-offer";

/**
 * The owner's pricing sheet of 13 October 2026, as the interactive half of
 * /pricing: the monthly price and setup of each product, a calculator that
 * builds a plan from a package and its steps, and the sheet's "Find your
 * step" table. The page around it (app/pricing/page.tsx) is a server
 * component and carries the parts that need no state.
 *
 * ## One interval and one offer for the whole sheet
 *
 * The monthly / annual toggle sits above everything it changes, so a figure
 * on the table and the calculator's total never disagree about which
 * interval they are in. The website's setup offer (`useSiteOffer`) is read
 * once here for the same reason: the struck-through list price and the
 * offer price appear in the table and in the calculator, and both must turn
 * back to the list price at the same second.
 *
 * ## The setup offer is the website's 30%, never the demo's 50%
 *
 * Half off setup belongs to the personalised demo a clinic asked for, and is
 * shown only on that path (the checkout reads `demoOfferEndsAt`). This page is
 * public, so it prints the website's offer and no other: SITE_SETUP_CREDIT's
 * percentage, read from the catalog, with what a buyer pays rounded up the way
 * `setupAfterCreditUsd` rounds it, which is the figure Stripe charges.
 *
 * ## Rendered without script on list prices
 *
 * The server render has no offer (the cookie is read by an API call after
 * mount), so a visitor without JavaScript sees list prices and a calculator
 * set to the sheet's own example steps, and every link still works.
 */
export function PricingSheet({ initialInterval = "month" }: { initialInterval?: BillingInterval }) {
  const [interval, setBillingInterval] = useState<BillingInterval>(initialInterval);
  const offer = useSiteOffer();

  return (
    <div className="mt-14">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <IntervalToggle interval={interval} onChange={setBillingInterval} />
        <OfferBanner offer={offer} />
      </div>

      <ProductTable interval={interval} offer={offer} />
      <Calculator interval={interval} offer={offer} />
      <FindYourStep interval={interval} />
    </div>
  );
}

/**
 * Two pressed buttons, not a radio group: `role="radio"` promises the
 * arrow-key pattern a screen reader user expects, and two native buttons do
 * not provide it. Same construction as the checkout's IntervalToggle.
 */
function IntervalToggle({
  interval,
  onChange,
}: {
  interval: BillingInterval;
  onChange: (interval: BillingInterval) => void;
}) {
  const options: { id: BillingInterval; label: string; badge?: string }[] = [
    { id: "month", label: "Monthly" },
    { id: "year", label: "Annual", badge: `Save ${annualSavingsPercent()}%` },
  ];
  return (
    <div role="group" aria-label="Billing period" className="border-line inline-flex rounded-full border bg-white p-1">
      {options.map((option) => {
        const on = option.id === interval;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(option.id)}
            className={[
              "inline-flex min-h-11 items-center gap-2 rounded-full px-5 py-2.5 text-sm font-bold transition-colors",
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
  );
}

/**
 * The offer and its clock, or nothing. The clock is the server's end time
 * counted down; the label inside `aria-live="off"` so a screen reader is not
 * read a new number every second, with the end stated once in words beside it.
 */
function OfferBanner({ offer }: { offer: SiteOffer }) {
  if (!offer.live || !offer.endsAt) return null;
  return (
    <p className="bg-tint-butter text-ink rounded-md px-4 py-2.5 text-[15px] font-semibold">
      {SITE_SETUP_CREDIT.percentOfSetupFee}% off the setup fee when you buy on this site. Ends in{" "}
      <span className="font-figure tabular-nums" aria-live="off">
        {countdownLabel(offer.remainingMs)}
      </span>
      <span className="sr-only">
        , at{" "}
        {offer.endsAt.toLocaleString("en-US", {
          weekday: "long",
          hour: "numeric",
          minute: "2-digit",
        })}
      </span>
      .
    </p>
  );
}

/** A setup fee, struck through beside the offer price while the offer holds. */
function SetupPrice({ listUsd, offer, className = "" }: { listUsd: number; offer: SiteOffer; className?: string }) {
  if (!offer.live) return <span className={className}>{usd.format(listUsd)}</span>;
  const after = setupAfterCreditUsd({ setupFeeUsd: listUsd }, SITE_SETUP_CREDIT);
  return (
    <span className={className}>
      <s className="text-muted font-medium">
        <span className="sr-only">List price </span>
        {usd.format(listUsd)}
      </s>{" "}
      <span>
        <span className="sr-only">, now </span>
        {usd.format(after)}
      </span>
    </span>
  );
}

const PRODUCT_ORDER: readonly ProductId[] = ["voice", "webchat", "metachat"];

/** What each product answers, in buyers' words. Meta Chat includes the website. */
const PRODUCT_COVERS: Record<ProductId, string> = {
  voice: "Your phone line, in the coverage you choose",
  webchat: "The chat on your website",
  metachat: "Instagram, Messenger and WhatsApp, and your website chat",
};

const unitWord = (product: ProductId) => (PRODUCTS[product].unit === "minute" ? "minutes" : "conversations");

/** The product table's column headings, written once: the header row and each phone card's labels read them. */
const PER_100_HEADING = (interval: BillingInterval) =>
  `Per 100 a month${interval === "year" ? ", billed yearly" : ""}`;
const EXTRA_100_HEADING = "Each extra 100 (provisional)";
const SETUP_HEADING = "One-time setup";

function ProductTable({ interval, offer }: { interval: BillingInterval; offer: SiteOffer }) {
  const combined = PACKAGES.filter((pkg) => pkg.voice && pkg.chat);
  return (
    <section aria-labelledby="price-table-heading" className="mt-10">
      <h2
        id="price-table-heading"
        className="font-display text-[clamp(28.8px,3.6vw,40.8px)] leading-tight font-medium tracking-[-0.024em]"
      >
        Monthly price and setup.
      </h2>
      {/* A table from 640px; under it each row is a card, every cell under
          its column's heading (globals.css, "The pricing sheet's product
          table on a phone"), so no price is behind a sideways scroll. The
          `data-label` on each cell is what the card writes above it. */}
      <div className="mt-6 overflow-x-auto">
        <table className="price-table w-full min-w-[640px] text-left text-[16px]">
          <thead>
            <tr className="border-line text-muted border-b text-[13px] font-bold tracking-[0.08em] uppercase">
              <th scope="col" className="py-3 pr-4">Product</th>
              <th scope="col" className="py-3 pr-4">{PER_100_HEADING(interval)}</th>
              {OVERAGE_RATES_PROVISIONAL ? null : (
                <th scope="col" className="py-3 pr-4">{EXTRA_100_HEADING}</th>
              )}
              <th scope="col" className="py-3">{SETUP_HEADING}</th>
            </tr>
          </thead>
          <tbody>
            {PRODUCT_ORDER.map((id) => {
              const product = PRODUCTS[id];
              return (
                <tr key={id} className="border-line border-b align-top">
                  <th scope="row" className="py-4 pr-4 font-normal">
                    <span className="block font-semibold">{product.name}</span>
                    <span className="text-muted block text-[14.5px] font-medium">{PRODUCT_COVERS[id]}</span>
                  </th>
                  <td className="py-4 pr-4" data-label={PER_100_HEADING(interval)}>
                    <span className="font-figure text-[20px] font-semibold tabular-nums">
                      {usd.format(perStepUsd(id, interval))}
                    </span>{" "}
                    <span className="text-muted text-[14.5px] font-medium">per 100 {unitWord(id)}</span>
                  </td>
                  {OVERAGE_RATES_PROVISIONAL ? null : (
                    <td className="py-4 pr-4 tabular-nums" data-label={EXTRA_100_HEADING}>
                      {usd.format(extraBlockUsd(id))}{" "}
                      <span className="text-muted text-[14.5px] font-medium">per 100 {unitWord(id)}</span>
                    </td>
                  )}
                  <td className="py-4 font-semibold tabular-nums" data-label={SETUP_HEADING}>
                    <SetupPrice listUsd={product.setupFeeUsd} offer={offer} />
                  </td>
                </tr>
              );
            })}
            {combined.map((pkg) => (
              <tr key={pkg.id} className="border-line border-b align-top">
                <th scope="row" className="py-4 pr-4 font-normal">
                  <span className="block font-semibold">{pkg.name}</span>
                  <span className="text-muted block text-[14.5px] font-medium">
                    Both products&apos; prices, added
                  </span>
                </th>
                <td className="text-muted py-4 pr-4 text-[14.5px] font-medium" data-label={PER_100_HEADING(interval)}>
                  Voice step + chat step
                </td>
                {OVERAGE_RATES_PROVISIONAL ? null : (
                  <td className="text-muted py-4 pr-4 text-[14.5px] font-medium" data-label={EXTRA_100_HEADING}>
                    Each product&apos;s own
                  </td>
                )}
                <td className="py-4 font-semibold tabular-nums" data-label={SETUP_HEADING}>
                  <SetupPrice listUsd={packageSetupFeeUsd(pkg)} offer={offer} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-muted mt-4 max-w-[80ch] text-sm font-medium">
        Prices are per location, in US dollars, before any sales tax. Annual billing is{" "}
        {annualSavingsPercent()}% off the monthly price.{" "}
        {OVERAGE_RATES_PROVISIONAL
          ? "Usage above your step is not billed until we publish those prices, and you will see them in writing before they apply."
          : "The extra-100 prices are provisional until we have measured what a minute and a conversation cost to serve."}
      </p>
    </section>
  );
}

function stepLabel(units: number, product: ProductId): string {
  return `${units.toLocaleString("en-US")} ${unitWord(product)}`;
}

/** One step slider: 100 to 1,500 in steps of 100, the value said in words. */
function StepSlider({
  product,
  value,
  onChange,
}: {
  product: ProductId;
  value: number;
  onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[15px] font-semibold">
          {PRODUCTS[product].name} step
        </label>
        <span className="font-figure text-[18px] font-semibold tabular-nums">{stepLabel(value, product)}</span>
      </div>
      <input
        id={id}
        type="range"
        min={MIN_STEP_UNITS}
        max={MAX_STEP_UNITS}
        step={STEP_UNITS}
        value={value}
        aria-valuetext={`${stepLabel(value, product)} a month`}
        onChange={(event) => onChange(Number(event.target.value))}
        className="accent-red mt-3 w-full"
      />
      <div className="text-muted mt-1 flex justify-between text-[12.5px] font-medium tabular-nums" aria-hidden>
        <span>{MIN_STEP_UNITS}</span>
        <span>{MAX_STEP_UNITS.toLocaleString("en-US")}</span>
      </div>
    </div>
  );
}

/**
 * Package, then a step for each product in it, then the price. The steps
 * start on the sheet's own example (`DEFAULT_STEPS`: 500 minutes, 300
 * conversations) and are kept when the package changes, so moving from Voice
 * to Voice + Web Chat adds the chat step rather than resetting the voice one.
 * The plan is built by the catalog's `planFor`, the same call checkout makes,
 * and the button carries its id, so checkout opens on exactly this plan.
 */
function Calculator({ interval, offer }: { interval: BillingInterval; offer: SiteOffer }) {
  const [packageId, setPackageId] = useState<PackageId>("voice-metachat");
  const [voiceMinutes, setVoiceMinutes] = useState<number>(DEFAULT_STEPS.voiceMinutes);
  const [chatConversations, setChatConversations] = useState<number>(DEFAULT_STEPS.chatConversations);
  const pkg = PACKAGES.find((p) => p.id === packageId) ?? PACKAGES[0]!;
  const plan = planFor(pkg.id, { voiceMinutes, chatConversations });
  const chat: ChatProductId | null = pkg.chat;

  const lines: { label: string; usd: number }[] = [];
  if (pkg.voice) {
    lines.push({
      label: `${PRODUCTS.voice.name}, ${stepLabel(voiceMinutes, "voice")}`,
      usd: (voiceMinutes / STEP_UNITS) * perStepUsd("voice", interval),
    });
  }
  if (chat) {
    lines.push({
      label: `${PRODUCTS[chat].name}, ${stepLabel(chatConversations, chat)}`,
      usd: (chatConversations / STEP_UNITS) * perStepUsd(chat, interval),
    });
  }

  return (
    <section aria-labelledby="calculator-heading" className="mt-20">
      <h2
        id="calculator-heading"
        className="font-display text-[clamp(28.8px,3.6vw,40.8px)] leading-tight font-medium tracking-[-0.024em]"
      >
        Work out your price.
      </h2>
      <div className="mt-7 grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div className="border-line rounded-lg border bg-white p-6 sm:p-8">
          <fieldset>
            <legend className="text-[15px] font-semibold">Product</legend>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {PACKAGES.map((option) => (
                <PackageOption
                  key={option.id}
                  pkg={option}
                  selected={option.id === pkg.id}
                  onSelect={() => setPackageId(option.id)}
                />
              ))}
            </div>
          </fieldset>
          <div className="mt-8 space-y-7">
            {pkg.voice ? <StepSlider product="voice" value={voiceMinutes} onChange={setVoiceMinutes} /> : null}
            {chat ? <StepSlider product={chat} value={chatConversations} onChange={setChatConversations} /> : null}
          </div>
        </div>

        <div
          className={[
            "flex flex-col rounded-lg border p-6 sm:p-8",
            pkg.highlight ? "border-sun bg-sun/[0.16]" : "border-line bg-white",
          ].join(" ")}
          aria-live="polite"
        >
          <p className="text-muted text-[13px] font-bold tracking-[0.1em] uppercase">{plan.packageName}</p>
          <p className="font-figure mt-3 text-[48px] leading-none font-semibold tracking-[-0.03em] tabular-nums">
            {usd.format(monthlyFigureUsd(plan, interval))}
            <span className="text-muted font-sans text-[18px] font-semibold">/mo</span>
          </p>
          <p className="text-muted mt-2 text-sm font-medium">
            {interval === "year" ? `${annualTotalLabel(plan)} billed yearly` : "Billed monthly"}
          </p>
          <dl className="text-muted mt-6 space-y-2 text-[15.5px]">
            {lines.map((line) => (
              <Row key={line.label} label={line.label}>
                {usd.format(line.usd)}
              </Row>
            ))}
            <Row label="One-time setup">
              <SetupPrice listUsd={plan.setupFeeUsd} offer={offer} />
            </Row>
            {pkg.voice && !OVERAGE_RATES_PROVISIONAL ? (
              <Row label="Each extra 100 minutes">{usd.format(extraBlockUsd("voice"))}</Row>
            ) : null}
            {chat && !OVERAGE_RATES_PROVISIONAL ? (
              <Row label="Each extra 100 conversations">{usd.format(extraBlockUsd(chat))}</Row>
            ) : null}
          </dl>
          <p className="text-muted mt-5 text-[14.5px] font-medium">
            Today you pay the setup fee. Your {interval === "year" ? "annual" : "monthly"} price starts the day{" "}
            {site.agent} first answers a patient.
          </p>
          <PlanBuyLink
            planId={plan.id}
            interval={interval}
            className="bg-red hover:bg-red-deep mt-6 rounded-sm px-6 py-3.5 text-center text-[17px] font-semibold text-white transition-colors duration-fast"
          />
        </div>
      </div>
    </section>
  );
}

/**
 * The calculator's "Get AYA": the purchase opens in place over the page, with
 * this package at these steps and this interval already chosen (plan A1,
 * "Pricing cards open the sheet in place with the package already chosen"),
 * through the BuyModalProvider the page wraps everything in. It stays a link
 * to /get-started with the same choice, which preselects it there, for a
 * page without the provider, a browser that has not run the script yet, and
 * a click that asks for a new tab or window.
 */
export function PlanBuyLink({
  planId,
  interval,
  className,
}: {
  planId: string;
  interval: BillingInterval;
  className: string;
}) {
  const buy = useBuy();
  return (
    <a
      href={`/get-started?plan=${encodeURIComponent(planId)}&interval=${interval}`}
      onClick={(event) => {
        if (!buy || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return;
        }
        event.preventDefault();
        buy.open({ plan: planId, interval });
      }}
      className={className}
    >
      {site.cta.primary.label}
    </a>
  );
}

function PackageOption({ pkg, selected, onSelect }: { pkg: Package; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={[
        "rounded-md border px-4 py-3 text-left transition-colors",
        selected ? "border-ink bg-paper-2" : "border-line hover:border-line-strong",
      ].join(" ")}
    >
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-[16px] font-semibold">{pkg.name}</span>
        {pkg.highlight ? (
          <span className="bg-sun text-ink shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold tracking-[0.06em] uppercase">
            {pkg.highlight}
          </span>
        ) : null}
      </span>
      <span className="text-muted mt-1 block text-[13.5px] font-medium">{packageChips(pkg).join(" · ")}</span>
    </button>
  );
}

/**
 * The sheet's "Find your step": what each product costs a month at every
 * step, on the interval chosen above. A plan with voice and chat adds a row
 * from each column, so the table needs no combined columns.
 */
function FindYourStep({ interval }: { interval: BillingInterval }) {
  return (
    <section aria-labelledby="steps-heading" className="mt-20">
      <h2
        id="steps-heading"
        className="font-display text-[clamp(28.8px,3.6vw,40.8px)] leading-tight font-medium tracking-[-0.024em]"
      >
        Find your step.
      </h2>
      <p className="text-muted mt-4 max-w-[64ch] text-[18px] leading-[1.55] font-medium">
        Each step is 100 minutes or 100 conversations a month. Voice and chat are chosen separately, and
        their prices add up.
      </p>
      <div className="mt-6 overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-[16px] tabular-nums">
          <caption className="sr-only">
            Monthly price at each step{interval === "year" ? ", billed yearly" : ""}
          </caption>
          <thead>
            <tr className="border-line text-muted border-b text-[13px] font-bold tracking-[0.08em] uppercase">
              <th scope="col" className="py-3 pr-4">Step</th>
              {PRODUCT_ORDER.map((id) => (
                <th key={id} scope="col" className="py-3 pr-4">
                  {PRODUCTS[id].name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {USAGE_STEPS.map((units) => (
              <tr key={units} className="border-line border-b">
                <th scope="row" className="py-2.5 pr-4 font-semibold">
                  {units.toLocaleString("en-US")}
                </th>
                {PRODUCT_ORDER.map((id) => (
                  <td key={id} className="py-2.5 pr-4">
                    {usd.format((units / STEP_UNITS) * perStepUsd(id, interval))}
                    <span className="text-muted text-[14px] font-medium">/mo</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt>{label}</dt>
      <dd className="text-ink text-right font-semibold tabular-nums">{children}</dd>
    </div>
  );
}
