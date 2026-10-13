"use client";

import {
  type BillingInterval,
  type ChatChannel,
  chatChannelOf,
  getPlan,
  META_SOLD_ALONE,
  offersChatChoice,
  planForCard,
  planNeedsWebsite,
  type PricingCard,
  pricingCards,
} from "@healdesk/catalog";
import { type Ref, useId, useState } from "react";

import {
  allowanceRows,
  annualSavingsPercent,
  CHAT_CHANNEL_CHOICES,
  channelChips,
  monthlyFigureUsd,
  usd,
} from "@/lib/pricing";
import {
  chosenCard,
  chosenPlan,
  type FunnelState,
  planOnSale,
  sellableTo,
} from "@/lib/checkout/funnel";
import { locationsLine } from "@/lib/checkout/review";
import { ASSUMED_SHOW_RATE, DEFAULT_MISSED_CALLS_PER_WEEK, DEFAULT_MISSED_MESSAGES_PER_WEEK, type RoiInputs } from "@/lib/demo/roi";
import { site } from "@/lib/site";

import { DemoPlanPicker } from "./DemoPlanPicker";
import { type DemoCheckout, DemoOfferBanner, RoiPanel } from "./DemoPackageExtras";
import { FIELD_LABEL, PrimaryButton, RadioGroup, Reassurance, StepShell } from "./StepShell";

/**
 * Step 1, the package: the five cards, monthly or annual, and on a card that
 * sells website chat or the Meta bot, which of the two. The channel picked
 * chooses the package itself (chat-web or chat-meta, web-voice or
 * meta-voice), so what is signed for and charged is never a card.
 *
 * Nothing is chosen until the buyer chooses, unless they arrived from a
 * pricing card or a `?plan` link. No line here says when a channel will
 * answer; the chat channel's note says how each goes live.
 */
export function PackageStep({
  state,
  onCard,
  onChat,
  onInterval,
  onContinue,
  onClose,
  headingRef,
  error,
  demo,
  onPlan,
}: {
  state: FunnelState;
  /** A buyer from a personalised demo: grouped packages with estimates and the demo offer. */
  demo?: DemoCheckout;
  /** Choose a package by its id; the demo's rows each name one. */
  onPlan?: (planId: string) => void;
  onCard: (cardId: string) => void;
  onChat: (chat: ChatChannel) => void;
  onInterval: (interval: BillingInterval) => void;
  onContinue: () => void;
  onClose?: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
  /** A refusal from Pay that belongs to the package. */
  error?: string | null;
}) {
  const card = chosenCard(state);
  const plan = chosenPlan(state);
  const groupLabel = useId();
  const [roiInputs, setRoiInputs] = useState<RoiInputs | null>(() =>
    demo
      ? {
          ...demo.roi,
          missedCallsPerWeek: DEFAULT_MISSED_CALLS_PER_WEEK,
          missedMessagesPerWeek: DEFAULT_MISSED_MESSAGES_PER_WEEK,
          showRate: ASSUMED_SHOW_RATE,
        }
      : null,
  );

  return (
    <StepShell
      step={1}
      totalSteps={4}
      onClose={onClose}
      headingRef={headingRef}
      eyebrow={site.cta.primary.label}
      title="Choose your package"
      subtitle="Today you pay the setup fee only. Your plan starts the day AYA first answers a patient."
    >
      {error ? (
        <p
          className="border-red/30 bg-red/[0.06] mb-6 rounded-sm border px-4 py-3 text-[15.6px] font-semibold"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {/* Monthly or annual, before the cards, because it changes every price
          on them. Pressed buttons rather than radios: two native buttons with
          aria-pressed say exactly what they are. */}
      {demo?.offerEndsAt ? <DemoOfferBanner endsAt={demo.offerEndsAt} percent={demo.offerPercent} /> : null}

      <IntervalToggle value={state.interval} onChange={onInterval} />

      {demo && roiInputs && onPlan ? (
        <>
          <RoiPanel clinicName={demo.clinicName} inputs={roiInputs} onChange={setRoiInputs} />
          <DemoPlanPicker
            interval={state.interval}
            selectedPlanId={plan?.id ?? ""}
            onSelect={(chosen) => onPlan(chosen.id)}
            roi={roiInputs}
            setupCreditPercent={demo.offerEndsAt ? demo.offerPercent : null}
            includes="+ 24/7 support included · unlimited modifications · no hidden costs"
          />
        </>
      ) : (
      <div role="radiogroup" aria-labelledby={groupLabel} className="mt-5">
        <p id={groupLabel} className="sr-only">
          Package
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {pricingCards.map((c) => (
            <PackageCard
              key={c.id}
              card={c}
              interval={state.interval}
              selected={c.id === card?.id}
              noWebsite={state.noWebsite}
              onSelect={() => onCard(c.id)}
            />
          ))}
        </div>
      </div>
      )}

      {/* Only a "Web OR Meta" card asks: the others include both chat
          channels or neither, and a question with one answer is noise. */}
      {!demo && card && plan && offersChatChoice(card) ? (
        <ChatChannelField
          card={card}
          // The package's own channel, so a choice the step overrides (Meta
          // alone, while it is not sold) shows as what will be bought.
          value={chatChannelOf(plan)}
          onChange={onChat}
          noWebsite={state.noWebsite}
        />
      ) : null}

      {/* Every package covers one location; more is quoted by the team. */}
      {demo ? (
        <div className="border-line mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border bg-white px-5 py-4">
          <span className="text-sm font-semibold">More than one location?</span>
          <a
            href="/contact"
            className="border-line hover:border-line-strong rounded-full border px-4 py-2 text-sm font-bold transition-colors"
          >
            Get a quote from sales
          </a>
        </div>
      ) : null}

      {/* One region, always in the page, so a change of package is heard. */}
      <p className="text-muted mt-6 text-sm" role="status" aria-live="polite">
        {plan ? (
          <>
            <span className="text-ink font-semibold">{plan.name}.</span>{" "}
            {locationsLine(plan, state.interval)}
          </>
        ) : (
          "Choose a package to continue."
        )}
      </p>

      <div className="mt-8">
        <PrimaryButton onClick={onContinue} disabled={!plan}>
          Continue
        </PrimaryButton>
      </div>
      <Reassurance />
    </StepShell>
  );
}

/**
 * Monthly / annual. The saving is computed from the catalog, never typed
 * here, so the badge cannot outlive the discount it describes.
 */
export function IntervalToggle({
  value,
  onChange,
}: {
  value: BillingInterval;
  onChange: (interval: BillingInterval) => void;
}) {
  const options: { id: BillingInterval; label: string; badge?: string }[] = [
    { id: "month", label: "Monthly" },
    { id: "year", label: "Annual", badge: `Save ${annualSavingsPercent()}%` },
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
 * One pricing card, as one answer of the package radio group. A twin card
 * shows its web package's figures, which its Meta twin shares (the catalog
 * test holds them to it). The price is always per month, as the old
 * /pricing quoted it; the annual total is in the review, where it is what the plan bills.
 */
function PackageCard({
  card,
  interval,
  selected,
  noWebsite,
  onSelect,
}: {
  card: PricingCard;
  interval: BillingInterval;
  selected: boolean;
  noWebsite: boolean;
  onSelect: () => void;
}) {
  const plan = planForCard(card);
  // Closed only when no package on the card can be sold to this practice: a
  // twin card still sells its Meta package to a practice without a website,
  // unless Meta on its own is not on sale either.
  const closed = !card.planIds.some((id) => sellableTo(getPlan(id)!, { noWebsite }));
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
        value={card.id}
        checked={selected}
        disabled={closed}
        onChange={onSelect}
        className="sr-only"
      />
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-display text-[20.4px] leading-tight font-medium">{card.name}</span>
        {card.highlight ? (
          <span className="bg-sun text-ink rounded-full px-2 py-0.5 text-[11px] font-bold tracking-[0.06em] uppercase">
            {card.highlight}
          </span>
        ) : null}
      </span>

      <span className="mt-2 flex flex-wrap gap-1.5">
        {channelChips(card).map((chip) => (
          <span
            key={chip}
            className="bg-paper-2 text-muted rounded-full px-2 py-0.5 text-[12px] font-bold"
          >
            {chip}
          </span>
        ))}
      </span>

      <span className="font-figure mt-3 text-[26.4px] leading-none font-semibold tabular-nums">
        {usd.format(monthlyFigureUsd(plan, interval))}
        <span className="text-muted font-sans text-sm font-medium">/mo</span>
        {interval === "year" ? (
          <span className="text-muted ml-2 font-sans text-xs font-medium">billed annually</span>
        ) : null}
      </span>

      {/* Both allowance rows, an em dash for a zero: the same rows and the
          same policy everywhere a package is priced, from the same helper. */}
      <span className="text-muted mt-3 flex flex-col gap-0.5 text-sm">
        {allowanceRows(plan).map((row) => (
          <span key={row.label}>
            {row.label}: {row.value}
          </span>
        ))}
        <span>Setup fee {usd.format(plan.setupFeeUsd)}, once</span>
      </span>

      {closed ? (
        <span className={`${FIELD_LABEL} text-muted mt-3 text-[12px]`}>Needs a website</span>
      ) : null}
    </label>
  );
}

/**
 * Which twin a "Web OR Meta" card sells: website chat or the Meta bot.
 *
 * Exported (and from CheckoutFlow, where its test has always found it) so a
 * test can render it on its own. While Meta is not sold on its own (catalog,
 * META_SOLD_ALONE), the choice that would leave Meta as the clinic's only
 * channel stays on screen, disabled, with one line saying why: the card's
 * name still says "or Meta", and an option that silently vanished would read
 * as a mistake. A practice with no website cannot take website chat, and is
 * told so beside the option.
 */
export function ChatChannelField({
  card,
  value,
  onChange,
  noWebsite = false,
  metaSoldAlone = META_SOLD_ALONE,
}: {
  card: PricingCard;
  value: ChatChannel;
  onChange: (choice: ChatChannel) => void;
  noWebsite?: boolean;
  /** The catalog's flag; a parameter only so a test can close it. */
  metaSoldAlone?: boolean;
}) {
  const waitsForMeta = (choice: ChatChannel) =>
    !planOnSale(planForCard(card, choice), metaSoldAlone);
  const needsWebsite = (choice: ChatChannel) =>
    noWebsite && planNeedsWebsite(planForCard(card, choice));
  return (
    <div className="border-line mt-6 rounded-md border bg-white p-5">
      <RadioGroup<ChatChannel>
        name="chatChannelChoice"
        label="Which chat channel?"
        hint={`${card.name} includes one. Website chat goes live once its one-line snippet is on your site. Instagram and Messenger go live once you connect them in setup, and WhatsApp once your WhatsApp account has a payment method on it, because Meta bills you directly for WhatsApp messages.`}
        options={CHAT_CHANNEL_CHOICES.map((option) => ({
          id: option.id,
          label: option.label,
          disabled: waitsForMeta(option.id) || needsWebsite(option.id),
          description: needsWebsite(option.id)
            ? "Needs a website: you told us you don't have one."
            : undefined,
        }))}
        value={value}
        onChange={onChange}
      />
      {CHAT_CHANNEL_CHOICES.some((option) => waitsForMeta(option.id)) ? (
        <p className="text-muted mt-3 text-xs">
          On its own, Instagram, Messenger + WhatsApp waits for Meta to approve our app, so this
          package is website chat for now.
        </p>
      ) : null}
    </div>
  );
}
