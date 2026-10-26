"use client";

import { type BillingInterval, PACKAGES, type PackageId } from "@healdesk/catalog";
import { useId } from "react";

import { type FunnelState, planAt, sellableTo } from "@/lib/checkout/funnel";
import { includedLine, type SetupOffer } from "@/lib/checkout/review";
import { recommendedPackage } from "@/lib/demo/close";
import { packageChips, usd } from "@/lib/pricing";

import { SetupFigure } from "./PackageStep";

/**
 * The demo buyer's package (26 October 2026): the one their demo
 * recommended, already chosen, with every other one a tap away under "See
 * other packages", not a wall of five. Checkout does not sell: what a package
 * could book for the clinic was shown on the demo page (components/demo/
 * ValueTiles.tsx), and is not repeated here. The steps are set below, as for
 * every buyer (PackageStep's StepControls).
 */
export function DemoPlanPicker({
  clinicName,
  interval,
  steps,
  selectedPackageId,
  onSelect,
  offer,
  noWebsite = false,
  includes,
}: {
  clinicName: string;
  interval: BillingInterval;
  steps: Pick<FunnelState, "voiceMinutes" | "chatConversations">;
  selectedPackageId: PackageId | null;
  onSelect: (packageId: PackageId) => void;
  /** The setup offer that applies, while it holds. */
  offer: SetupOffer | null;
  /** The practice has said it has no website: Web Chat is not sold to it. */
  noWebsite?: boolean;
  /** What the setup fee buys, one line. */
  includes: string;
}) {
  const recommended = recommendedPackage().id;
  const selected = PACKAGES.find((p) => p.id === selectedPackageId) ?? null;
  const others = PACKAGES.filter((p) => p.id !== selected?.id);
  const groupId = useId();

  const row = (pkg: (typeof PACKAGES)[number]) => {
    const plan = planAt(pkg.id, steps);
    const open = pkg.id === selectedPackageId;
    const closed = !sellableTo(pkg, { noWebsite });
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
          role="radio"
          aria-checked={open}
          disabled={closed}
          onClick={() => onSelect(pkg.id)}
          className="flex min-h-14 w-full flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 text-left disabled:cursor-not-allowed sm:flex-nowrap"
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
              {pkg.id === recommended ? (
                <span className="bg-sun text-ink rounded-full px-2 py-0.5 text-[10.8px] font-bold tracking-[0.06em] uppercase">
                  Recommended for {clinicName}
                </span>
              ) : null}
            </span>
            <span className="text-muted block text-[13.2px]">{closed ? "Needs a website" : packageChips(pkg).join(" · ")}</span>
          </span>
          <span className="font-display text-right text-[22px] leading-none font-semibold tabular-nums">
            {usd.format(interval === "year" ? plan.annualMonthlyUsd : plan.monthlyUsd)}
            <span className="text-muted text-[13px] font-medium">/mo</span>
          </span>
        </button>
        {open ? (
          <div className="border-line border-t px-4 py-4 text-[14.4px]">
            <p className="text-ink font-semibold">{includedLine(plan)}</p>
            <p className="text-muted mt-1">
              Setup: <SetupFigure plan={plan} offer={offer} suffix=" once" />
            </p>
            <p className="text-ink mt-1 text-[13px] font-semibold">{includes}</p>
          </div>
        ) : null}
      </div>
    );
  };

  if (!selected) {
    return (
      <div role="radiogroup" aria-label="Package" className="mt-5 space-y-2">
        {PACKAGES.map(row)}
      </div>
    );
  }

  return (
    <div role="radiogroup" aria-labelledby={groupId} className="mt-5 space-y-2">
      <p id={groupId} className="sr-only">
        Package
      </p>
      {row(selected)}
      <details className="group">
        <summary className="text-muted hover:text-ink flex min-h-11 cursor-pointer list-none items-center gap-2 px-1 text-sm font-bold">
          <span aria-hidden className="transition-transform group-open:rotate-90">›</span>
          See other packages
        </summary>
        <div className="mt-1 space-y-2">{others.map(row)}</div>
      </details>
    </div>
  );
}
