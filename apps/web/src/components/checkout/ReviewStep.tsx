"use client";

import type { BillingInterval, Plan, SpecialtyId } from "@healdesk/catalog";
import { type ReactNode, type Ref } from "react";

import {
  channelsInServiceLine,
  includedLine,
  offerLine,
  overageSentence,
  payLabel,
  planStartLine,
  riskLine,
  runOutLine,
  SALES_TAX_LINE,
  type SetupOffer,
  setupFeeToday,
} from "@/lib/checkout/review";
import type { SiteReadLine } from "@/lib/checkout/site-read";
import { GUARANTEE_TEXT, LEGAL_VERSION } from "@/lib/legal";
import { site } from "@/lib/site";

import type { AgreementResult } from "./AgreementStep";
import { SetupOfferBanner } from "./SetupOfferBanner";
import { FIELD_LABEL, PrimaryButton, RiskLine, StepShell } from "./StepShell";

/**
 * Step 4, review and pay. In order (plan Part A3): what today's charge is
 * (the setup fee, less the one setup offer that applies) and what it pays
 * for; the plan-start sentence; for a package of more than one
 * channel, what is billed while some are not in service; what each month
 * includes, the overage and what happens at the end of the
 * allowance; sales tax where Stripe Tax is on; what the website read found;
 * the guarantee, in full; the signed agreement; and the terms tick-box beside
 * Pay. Every sentence is built in lib/checkout/review.ts from the catalog.
 *
 * On a phone the tick-box and Pay ride in a bar fixed to the bottom of the
 * screen, so the decision and the action are always in view together, and
 * the page's scroll padding keeps a focused link from hiding behind it.
 */
export function ReviewStep({
  plan,
  interval,
  specialty,
  clinicName,
  siteRead,
  salesTax,
  agreement,
  copyLink,
  termsAccepted,
  onTerms,
  submitting,
  error,
  notice,
  onPay,
  onBack,
  onClose,
  headingRef,
  offer = null,
  onOfferEnd,
}: {
  /** The offer's clock reached zero. */
  onOfferEnd?: () => void;
  /**
   * The setup offer that applies, while it holds (lib/checkout/review.ts):
   * the same figure the Stripe coupon takes off, which /api/checkout decides.
   */
  offer?: SetupOffer | null;
  /** The package at its steps; its name says both. */
  plan: Plan;
  interval: BillingInterval;
  specialty: SpecialtyId | null;
  clinicName: string;
  siteRead: SiteReadLine;
  /** STRIPE_AUTOMATIC_TAX, read on the server and handed down. */
  salesTax: boolean;
  agreement: AgreementResult;
  /** The download of the signed copy, rendered by the flow, which owns the PDF fallback. */
  copyLink: ReactNode;
  termsAccepted: boolean;
  onTerms: (accepted: boolean) => void;
  submitting: boolean;
  error: string | null;
  /** Said first, such as "nothing was charged" on the way back from the payment page. */
  notice?: string | null;
  onPay: () => void;
  onBack: () => void;
  onClose?: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const fee = setupFeeToday(plan, offer);
  const inService = channelsInServiceLine(plan, interval);

  return (
    <StepShell
      step={4}
      totalSteps={4}
      onBack={onBack}
      onClose={onClose}
      headingRef={headingRef}
      eyebrow={site.cta.primary.label}
      title="Review and pay"
    >
      {notice ? (
        <p
          className="border-line bg-paper-2/60 mb-6 rounded-sm border px-4 py-3 text-[15.6px] font-semibold"
          role="status"
        >
          {notice}
        </p>
      ) : null}

      {offer ? <SetupOfferBanner offer={offer} plan={plan} onEnd={onOfferEnd} /> : null}

      <p className="text-muted text-sm">
        <span className="text-ink font-semibold">{clinicName}</span> · {plan.name},{" "}
        {interval === "year" ? "billed annually" : "billed monthly"}
      </p>

      <section
        className="border-line mt-4 rounded-md border bg-white p-5"
        aria-label="What you pay"
      >
        <p className="font-display text-[26.4px] leading-tight font-medium">{fee.headline}</p>
        {offer ? (
          <p className="mt-1 text-sm font-semibold text-[#2f7d3a]">{offerLine(plan, offer)}</p>
        ) : null}
        <p className="text-muted mt-2 text-sm">
          {fee.covers} You then have 30 days to finish setup:{" "}
          <a
            href="/terms#fees"
            target="_blank"
            rel="noreferrer"
            className="text-ink font-semibold underline underline-offset-4"
          >
            Terms, section 3
          </a>
          .
        </p>

        <p className="mt-4 text-[15.6px] font-semibold">
          {planStartLine(plan, interval, specialty)}
        </p>
        {inService ? <p className="text-muted mt-2 text-sm">{inService}</p> : null}

        <div className="border-line mt-4 space-y-2 border-t pt-4 text-sm">
          <p>{includedLine(plan)}</p>
          <p className="text-muted">{overageSentence(plan, interval)}</p>
          <p className="text-muted">{runOutLine(plan)}</p>
          {salesTax ? <p className="text-muted">{SALES_TAX_LINE}</p> : null}
        </div>
      </section>

      {/* What the read found, or that setup will ask. In the page from the
          start, so a read that finishes while the buyer is here is heard. */}
      <p
        role="status"
        aria-live="polite"
        className="border-line mt-4 rounded-md border bg-white px-5 py-4 text-sm"
      >
        {siteRead.text}
      </p>

      <section
        className="border-line bg-paper-2/50 mt-4 rounded-md border p-5"
        aria-labelledby="guarantee-heading"
      >
        <h2 id="guarantee-heading" className={FIELD_LABEL}>
          {GUARANTEE_TEXT.heading}
        </h2>
        <div className="text-muted mt-3 space-y-2.5 text-[13.5px] leading-relaxed">
          {GUARANTEE_TEXT.paragraphs.map((paragraph) => (
            <p key={paragraph.lead}>
              <strong className="text-ink">{paragraph.lead}</strong> {paragraph.body}
            </p>
          ))}
        </div>
      </section>

      <div className="border-line mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border bg-white px-5 py-3 text-sm">
        <span className="font-bold">Agreement signed</span>
        <span aria-hidden className="text-red-deep font-bold">
          ✓
        </span>
        <span aria-hidden className="text-muted">
          ·
        </span>
        {copyLink}
      </div>
      {!agreement.approvedByCounsel ? (
        <p className="border-red/30 bg-red/[0.06] mt-4 rounded-sm border px-4 py-3 text-[15.6px] font-semibold">
          This agreement is a draft pending legal review. Until it is finalised, accounts are
          created for synthetic data only and cannot receive real patient information.
        </p>
      ) : null}

      {/* The commercial terms are accepted here, beside the action that
          spends the money; the agreement was signed a step earlier. */}
      <div className="hd-pay-bar border-line bg-paper sticky bottom-0 z-10 mt-6 rounded-t-md border-t px-1 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:static sm:rounded-none sm:border-0 sm:bg-transparent sm:p-0">
        <label className="flex min-h-11 cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={termsAccepted}
            onChange={(e) => onTerms(e.target.checked)}
            // Never restored from autofill or a back-navigation cache.
            autoComplete="off"
            className="accent-red mt-1 size-5 shrink-0"
          />
          <span className="text-sm font-medium">
            I agree to the{" "}
            <a
              href="/terms"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              Terms of service
            </a>{" "}
            and the{" "}
            <a
              href="/privacy"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              Privacy policy
            </a>{" "}
            (version {LEGAL_VERSION}). The plan renews until I cancel.
          </span>
        </label>

        {error ? (
          <p className="text-red-deep mt-3 text-sm font-semibold" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-4">
          <PrimaryButton onClick={onPay} disabled={!termsAccepted || submitting}>
            {submitting ? "Taking you to payment…" : payLabel(plan, offer)}
          </PrimaryButton>
        </div>
        {/* At Pay, where the risk is felt: the one line, and the wallets a phone pays with. */}
        <RiskLine text={riskLine(plan, specialty)} className="mt-3" />
      </div>
    </StepShell>
  );
}
