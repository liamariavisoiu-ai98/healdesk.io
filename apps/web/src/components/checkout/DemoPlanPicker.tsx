"use client";

import { type Audience, type BillingInterval, PACKAGES, type PackageId } from "@healdesk/catalog";

import { type FunnelState, planAt, sellableTo } from "@/lib/checkout/funnel";
import { includedLine, type SetupOffer } from "@/lib/checkout/review";
import { estimate, type RoiInputs } from "@/lib/demo/roi";
import { packageChips, usd } from "@/lib/pricing";

import { SetupFigure } from "./PackageStep";

/**
 * The demo buyer's packages: the five, in the sheet's order, each a row with
 * its price at the steps chosen and what it is likely to book for this
 * clinic (lib/demo/roi.ts). Choosing one opens it to the detail: what it
 * includes at those steps, the setup fee with the demo's offer, and the full
 * estimate. The steps themselves are set below the list, as for every buyer
 * (PackageStep's StepControls), so the price and the estimate move with them.
 */
export function DemoPlanPicker({
  interval,
  steps,
  selectedPackageId,
  onSelect,
  roi,
  offer,
  noWebsite = false,
  includes,
  audience,
}: {
  interval: BillingInterval;
  steps: Pick<FunnelState, "voiceMinutes" | "chatConversations">;
  selectedPackageId: PackageId | null;
  onSelect: (packageId: PackageId) => void;
  roi: RoiInputs | null;
  /** The setup offer that applies, while it holds. */
  offer: SetupOffer | null;
  /** The practice has said it has no website: Web Chat is not sold to it. */
  noWebsite?: boolean;
  /** What the setup fee buys, one line. */
  includes: string;
  /** Who the clinic serves: a vet's new people are clients. */
  audience: Audience;
}) {
  return (
    <div className="mt-5 space-y-2">
      {PACKAGES.map((pkg) => {
        const plan = planAt(pkg.id, steps);
        const open = pkg.id === selectedPackageId;
        const closed = !sellableTo(pkg, { noWebsite });
        const est = roi ? estimate(plan, roi) : null;
        return (
          <div
            key={pkg.id}
            className={`overflow-hidden rounded-md border transition-all ${
              closed
                ? "border-line bg-paper-2 opacity-60"
                : open
                  ? "border-red bg-orange/[0.05] shadow-sm"
                  : "border-line hover:border-line-strong bg-white"
            }`}
          >
            <button
              type="button"
              aria-pressed={open}
              disabled={closed}
              onClick={() => onSelect(pkg.id)}
              className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 text-left disabled:cursor-not-allowed sm:flex-nowrap"
            >
              <span
                aria-hidden
                className={`grid size-5 shrink-0 place-items-center rounded-full border-2 ${open ? "border-red" : "border-line-strong"}`}
              >
                {open ? <span className="bg-red size-2.5 rounded-full" /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-display text-[18.6px] leading-tight font-medium">{pkg.name}</span>
                  {pkg.highlight ? (
                    <span className="bg-sun text-ink rounded-full px-2 py-0.5 text-[10.8px] font-bold tracking-[0.06em] uppercase">
                      {pkg.highlight}
                    </span>
                  ) : null}
                </span>
                <span className="text-muted block text-[13.2px]">
                  {closed ? "Needs a website" : packageChips(pkg).join(" · ")}
                </span>
              </span>
              <span className="text-right">
                <span className="font-display block text-[22px] leading-none font-semibold">
                  {usd.format(interval === "year" ? plan.annualMonthlyUsd : plan.monthlyUsd)}
                  <span className="text-muted text-[13px] font-medium">/mo</span>
                </span>
                {est && est.bookedValueUsd > 0 ? (
                  <span className="mt-1 block text-[12.6px] font-bold text-[#2f7d3a]">
                    likely books ≈ {usd.format(est.bookedValueUsd)}/mo
                  </span>
                ) : null}
              </span>
            </button>

            {open ? (
              <div className="border-line grid gap-4 border-t px-4 py-4 sm:grid-cols-2">
                <div className="text-[14.4px]">
                  <p className="text-ink font-semibold">{includedLine(plan)}</p>
                  <p className="text-muted mt-1">
                    Setup: <SetupFigure plan={plan} offer={offer} suffix=" once" />
                  </p>
                  <p className="text-ink mt-1 text-[13px] font-semibold">{includes}</p>
                </div>
                {est && est.bookedValueUsd > 0 ? (
                  <div className="rounded-sm bg-[#e5f6dc] px-3.5 py-3 text-[13.8px] text-[#172a3a]">
                    <p className="text-[12.6px] font-semibold">A clinic like yours is likely to book</p>
                    <p className="font-display text-[22px] leading-tight font-semibold">≈ {usd.format(est.bookedValueUsd)} a month</p>
                    <p>
                      about {est.patientsPerMonth} new {audience} · {est.multiple}× its price
                    </p>
                    {est.yearValueUsd !== null ? (
                      <p className="mt-0.5 font-semibold">≈ {usd.format(est.yearValueUsd)} a year once they come back</p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
