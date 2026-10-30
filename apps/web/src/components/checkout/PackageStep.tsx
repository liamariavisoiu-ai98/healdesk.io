"use client";

import {
  annualTotalUsd,
  ANNUAL_DISCOUNT_PERCENT,
  type BillingInterval,
  MAX_STEP_UNITS,
  MIN_STEP_UNITS,
  type Package,
  PACKAGES,
  type Plan,
  type Product,
  PRODUCTS,
  STEP_UNITS,
  USAGE_ALERT_PERCENT,
} from "@healdesk/catalog";
import { type Ref, useId } from "react";

import {
  chosenPackage,
  chosenPlan,
  type FunnelState,
  planAt,
  sellableTo,
} from "@/lib/checkout/funnel";
import { packageChips, usd } from "@/lib/pricing";
import { extraBlockPrices, locationsLine, type SetupOffer, setupDueUsd } from "@/lib/checkout/review";
import { site } from "@/lib/site";

import { DemoPlanPicker } from "./DemoPlanPicker";
import type { DemoCheckout } from "./DemoPackageExtras";
import { SetupOfferBanner } from "./SetupOfferBanner";
import { FIELD_LABEL, PrimaryButton, Reassurance, StepShell } from "./StepShell";

/**
 * What a demo buyer's setup fee comes with, one line under the open package
 * (DemoPlanPicker's `includes`). Support is what the plan defines it as
 * (Decisions, "Support"): the portal's help chat and hello@healdesk.io,
 * which the team answers on business days, never "24/7 support". And the
 * clinic changes its own answers and settings, as often as it likes; we do
 * not promise to make changes for it.
 */
export const DEMO_INCLUDES =
  "+ support in your portal and at hello@healdesk.io · change your answers and settings as often as you like · no hidden costs";

/**
 * Step 1, the package (the owner's pricing sheet, 13 October 2026): one of
 * the five packages, then a usage step for each product it has, voice in
 * minutes and chat in conversations, 100 to 1,500 in steps of 100, monthly or
 * annual. The price moves with the steps, live, and so does the plan's name:
 * what is signed for and charged is the package at its steps
 * (`voice-metachat-500-300`), never the package alone.
 *
 * Nothing is chosen until the buyer chooses, unless they arrived from a
 * `?plan` link. The steps start at the sheet's own examples (500 minutes,
 * 300 conversations). The setup fee shows the one offer that applies
 * (lib/checkout/review.ts), struck list price then the price after it, with
 * its clock. No line here says when a channel will answer.
 */
export function PackageStep({
  state,
  offer = null,
  onPackage,
  onSteps,
  onInterval,
  onContinue,
  onClose,
  onOfferEnd,
  headingRef,
  error,
  demo,
}: {
  state: FunnelState;
  /** The setup offer that applies, while it holds; null for none. */
  offer?: SetupOffer | null;
  /** A buyer from a personalised demo: the package it recommended, chosen, and the rest one tap away. */
  demo?: DemoCheckout;
  onPackage: (packageId: string) => void;
  onSteps: (steps: { voiceMinutes?: number; chatConversations?: number }) => void;
  onInterval: (interval: BillingInterval) => void;
  onContinue: () => void;
  onClose?: () => void;
  /** The offer's clock reached zero. */
  onOfferEnd?: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
  /** A refusal from Pay that belongs to the package. */
  error?: string | null;
}) {
  const pkg = chosenPackage(state);
  const plan = chosenPlan(state);
  const groupLabel = useId();
  return (
    <StepShell
      step={1}
      totalSteps={4}
      onClose={onClose}
      headingRef={headingRef}
      eyebrow={site.cta.primary.label}
      title="Choose your package"
      subtitle="Pick what your clinic needs. Pay by usage, in simple steps of 100. Prices are per location."
    >
      {error ? (
        <p
          className="border-red/30 bg-red/[0.06] mb-6 rounded-sm border px-4 py-3 text-sm font-semibold"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {offer ? <SetupOfferBanner offer={offer} plan={plan} onEnd={onOfferEnd} /> : null}

      {/* Monthly or annual, before the packages, because it changes every
          price on them. */}
      <IntervalToggle value={state.interval} onChange={onInterval} />

      {demo ? (
        <DemoPlanPicker
          clinicName={demo.clinicName}
          interval={state.interval}
          steps={state}
          selectedPackageId={pkg?.id ?? null}
          onSelect={onPackage}
          offer={offer}
          noWebsite={state.noWebsite}
          includes={DEMO_INCLUDES}
        />
      ) : (
        <div role="radiogroup" aria-labelledby={groupLabel} className="mt-5">
          <p id={groupLabel} className="sr-only">
            Package
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {PACKAGES.map((p) => (
              <PackageCard
                key={p.id}
                pkg={p}
                interval={state.interval}
                selected={p.id === pkg?.id}
                closed={!sellableTo(p, state)}
                offer={offer}
                onSelect={() => onPackage(p.id)}
              />
            ))}
          </div>
        </div>
      )}

      {pkg && plan ? (
        <StepControls pkg={pkg} plan={plan} interval={state.interval} onSteps={onSteps} />
      ) : null}

      {/* Every package covers one location, and a further one is the same
          plan again at a fixed price, added from Billing: PlanSummary's
          locationsLine says so to every buyer, so there is no quote to ask
          sales for (spec, "More than one location"). */}

      {/* One region, always in the page, so a change of package or step is heard. */}
      <div className="mt-6" role="status" aria-live="polite">
        {plan ? (
          <PlanSummary plan={plan} interval={state.interval} offer={offer} />
        ) : (
          <p className="text-muted text-sm">Choose a package to continue.</p>
        )}
      </div>

      <div className="mt-8">
        <PrimaryButton onClick={onContinue} disabled={!plan}>
          Continue
        </PrimaryButton>
      </div>
      <Reassurance />
    </StepShell>
  );
}

/** Monthly / annual. The saving is the catalog's, never typed here. */
export function IntervalToggle({
  value,
  onChange,
}: {
  value: BillingInterval;
  onChange: (interval: BillingInterval) => void;
}) {
  const options: { id: BillingInterval; label: string; badge?: string }[] = [
    { id: "month", label: "Monthly" },
    { id: "year", label: "Annual", badge: `Save ${ANNUAL_DISCOUNT_PERCENT}%` },
  ];
  return (
    <div
      role="group"
      aria-label="Billing period"
      className="border-line inline-flex rounded-full border bg-white p-1"
    >
      {options.map((option) => {
        const on = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(option.id)}
            className={[
              "inline-flex min-h-11 items-center gap-2 rounded-full px-4 py-2 text-sm font-bold transition-colors",
              on ? "bg-ink text-white" : "text-muted hover:text-ink",
            ].join(" ")}
          >
            {option.label}
            {option.badge ? (
              <span
                className={[
                  "rounded-full px-2 py-0.5 text-xs font-bold tracking-[0.06em] uppercase",
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

/** "$80 per 100 minutes", at the interval's per-month price. */
export function perStepLabel(product: Product, interval: BillingInterval): string {
  const price = interval === "year" ? product.perStepAnnualMonthlyUsd : product.perStepMonthlyUsd;
  return `${usd.format(price)} per ${STEP_UNITS} ${product.unit}s`;
}

/** The products a package bills, voice first. */
export function productsOf(pkg: Pick<Package, "voice" | "chat">): Product[] {
  return [...(pkg.voice ? [PRODUCTS.voice] : []), ...(pkg.chat ? [PRODUCTS[pkg.chat]] : [])];
}

/** The setup fee, struck through with the price after the offer beside it while one applies. */
export function SetupFigure({
  plan,
  offer,
  suffix = "",
}: {
  plan: Pick<Plan, "setupFeeUsd">;
  offer: SetupOffer | null;
  suffix?: string;
}) {
  const due = setupDueUsd(plan, offer);
  if (!offer || due === plan.setupFeeUsd) {
    return (
      <span>
        {usd.format(plan.setupFeeUsd)}
        {suffix}
      </span>
    );
  }
  return (
    <span>
      <s className="text-muted">
        <span className="sr-only">was </span>
        {usd.format(plan.setupFeeUsd)}
      </s>{" "}
      <span className="font-semibold text-[#2f7d3a]">
        <span className="sr-only">now </span>
        {usd.format(due)}
      </span>
      {suffix}
    </span>
  );
}

/**
 * One package, as one answer of the package radio group: its channels, its
 * price per step for the interval, and its setup fee. A package with Web Chat
 * is closed to a practice that has said it has no website.
 */
function PackageCard({
  pkg,
  interval,
  selected,
  closed,
  offer,
  onSelect,
}: {
  pkg: Package;
  interval: BillingInterval;
  selected: boolean;
  closed: boolean;
  offer: SetupOffer | null;
  onSelect: () => void;
}) {
  // The setup fee is the package's, whatever the steps.
  const plan = planAt(pkg.id, { voiceMinutes: MIN_STEP_UNITS, chatConversations: MIN_STEP_UNITS });
  return (
    <label
      className={[
        "relative flex w-full flex-col rounded-md border p-5 text-left transition-colors has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-orange",
        closed
          ? "border-line bg-paper-2 cursor-not-allowed opacity-60"
          : selected
            ? "border-red bg-orange/[0.06] shadow-sm cursor-pointer"
            : "border-line hover:border-line-strong cursor-pointer bg-white",
      ].join(" ")}
    >
      <input
        type="radio"
        name="package"
        value={pkg.id}
        checked={selected}
        disabled={closed}
        onChange={onSelect}
        className="sr-only"
      />
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-display text-lg leading-tight font-medium">{pkg.name}</span>
        {pkg.highlight ? (
          <span className="bg-sun text-ink rounded-full px-2 py-0.5 text-xs font-bold tracking-[0.06em] uppercase">
            {pkg.highlight}
          </span>
        ) : null}
      </span>

      <span className="mt-2 flex flex-wrap gap-1.5">
        {packageChips(pkg).map((chip) => (
          <span
            key={chip}
            className="bg-paper-2 text-muted rounded-full px-2 py-0.5 text-xs font-bold"
          >
            {chip}
          </span>
        ))}
      </span>

      <span className="mt-3 flex flex-col gap-0.5 text-sm font-semibold">
        {productsOf(pkg).map((product) => (
          <span key={product.id}>
            {perStepLabel(product, interval)}
            <span className="text-muted text-xs font-medium">/mo</span>
          </span>
        ))}
      </span>

      <span className="text-muted mt-2 text-sm">
        Setup fee <SetupFigure plan={plan} offer={offer} />, once
      </span>

      {closed ? (
        <span className={`${FIELD_LABEL} text-muted mt-3 text-xs`}>Needs a website</span>
      ) : null}
    </label>
  );
}

/**
 * A step for each product the package has: a native range input, so the
 * arrow keys, Home and End, and a screen reader's own slider gestures all
 * work, with the value said in words ("500 minutes a month"). Beside it the
 * product's monthly price at that step, and the price of each extra 100, as
 * a block and its price, never a per-unit rate.
 */
function StepControls({
  pkg,
  plan,
  interval,
  onSteps,
}: {
  pkg: Package;
  plan: Plan;
  interval: BillingInterval;
  onSteps: (steps: { voiceMinutes?: number; chatConversations?: number }) => void;
}) {
  const extras = extraBlockPrices(plan);
  return (
    <section className="border-line mt-6 rounded-md border bg-white p-5" aria-label="Your usage steps">
      <p className={FIELD_LABEL}>How much a month?</p>
      <div className="mt-4 grid gap-6">
        {productsOf(pkg).map((product) => {
          const voice = product.id === "voice";
          const value = voice ? plan.includedVoiceMinutes : plan.includedChatConversations;
          const extra = extras.find((e) => e.meter === (voice ? "voiceMinutes" : "chatConversations"));
          return (
            <StepSlider
              key={product.id}
              product={product}
              value={value}
              interval={interval}
              extraPrice={extra?.price ?? null}
              onChange={(next) => onSteps(voice ? { voiceMinutes: next } : { chatConversations: next })}
            />
          );
        })}
      </div>
      <p className="text-muted mt-5 text-sm">
        When you reach {USAGE_ALERT_PERCENT}% of your included amount, we email you. You can move up
        a step, or do nothing and let each next {STEP_UNITS} bill at the extra-{STEP_UNITS} price. If
        you regularly go over, moving up a step is the better deal.
      </p>
    </section>
  );
}

function StepSlider({
  product,
  value,
  interval,
  extraPrice,
  onChange,
}: {
  product: Product;
  value: number;
  interval: BillingInterval;
  extraPrice: string | null;
  onChange: (value: number) => void;
}) {
  const id = useId();
  const units = `${product.unit}s`;
  const label = product.id === "voice" ? "Voice minutes" : "Chat conversations";
  const perStep = interval === "year" ? product.perStepAnnualMonthlyUsd : product.perStepMonthlyUsd;
  const price = (value / STEP_UNITS) * perStep;
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <label htmlFor={id} className="text-sm font-bold">
          {label}
        </label>
        <span className="text-sm font-semibold tabular-nums">
          {value.toLocaleString("en-US")} {units}
          <span className="text-muted font-medium"> · {usd.format(price)}/mo</span>
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={MIN_STEP_UNITS}
        max={MAX_STEP_UNITS}
        step={STEP_UNITS}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-valuetext={`${value.toLocaleString("en-US")} ${units} a month, ${usd.format(price)} a month`}
        aria-describedby={`${id}-scale ${id}-extra`}
        className="accent-red mt-3 h-11 w-full cursor-pointer"
      />
      <div id={`${id}-scale`} className="text-muted flex justify-between text-xs font-semibold tabular-nums">
        <span>{MIN_STEP_UNITS.toLocaleString("en-US")}</span>
        <span>{MAX_STEP_UNITS.toLocaleString("en-US")}</span>
      </div>
      <p id={`${id}-extra`} className="text-muted mt-1.5 text-xs">
        {perStepLabel(product, interval)} a month.
        {extraPrice ? ` Each extra ${STEP_UNITS} ${units}: ${extraPrice}.` : ""}
      </p>
    </div>
  );
}

/** What the plan costs, at a glance: the plan's name with its steps, the price, the setup fee and when billing starts. */
function PlanSummary({
  plan,
  interval,
  offer,
}: {
  plan: Plan;
  interval: BillingInterval;
  offer: SetupOffer | null;
}) {
  return (
    <div className="border-line bg-paper-2/50 rounded-md border px-5 py-4">
      <p className="text-sm font-bold">{plan.name}</p>
      <p className="font-display mt-1 text-2xl leading-none font-semibold tabular-nums">
        {usd.format(interval === "year" ? plan.annualMonthlyUsd : plan.monthlyUsd)}
        <span className="text-muted font-sans text-sm font-medium">/mo</span>
        {interval === "year" ? (
          <span className="text-muted ml-2 font-sans text-xs font-medium">
            billed annually, {usd.format(annualTotalUsd(plan))} a year
          </span>
        ) : null}
      </p>
      <p className="mt-2 text-sm">
        Setup fee <SetupFigure plan={plan} offer={offer} suffix=", once" />
      </p>
      <p className="text-muted mt-2 text-sm">
        Today you pay the setup fee only. Your plan starts the day AYA first answers a patient or
        client.
      </p>
      <p className="text-muted mt-1 text-sm">{locationsLine(plan, interval)}</p>
    </div>
  );
}
