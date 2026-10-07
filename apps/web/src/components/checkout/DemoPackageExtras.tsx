"use client";

import { DEMO_SETUP_CREDIT } from "@healdesk/catalog";

import { DemoCountdown } from "@/components/demo/DemoTimers";
import { patientValuePerYear, type RoiInputs } from "@/lib/demo/roi";
import { usd } from "@/lib/pricing";

/**
 * What a buyer who arrives from their personalised demo sees on the package
 * step beyond the packages themselves: the limited offer with its clock, and
 * the editable inputs behind the estimates on each package (lib/demo/roi.ts).
 *
 * What the flow needs from the demo, in one object, so the checkout takes a
 * single optional prop and a visitor without a demo sees none of this.
 */
export type DemoCheckout = {
  clinicName: string;
  roi: {
    priceUsd: number;
    priceSource: string;
    bookingRate: number;
    repeat: RoiInputs["repeat"];
  };
  /** The demo's expiry (ISO) while its offer still holds; absent after it. */
  offerEndsAt?: string;
};

/** The offer, unmissable: the demo's own clock, the one the checkout's coupon honours. */
export function DemoOfferBanner({ endsAt }: { endsAt: string }) {
  return (
    <div className="bg-brand-gradient shadow-brand mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl px-5 py-4 text-white">
      <span>
        <span className="block text-[12px] font-bold tracking-[0.12em] uppercase opacity-85">Demo offer</span>
        <span className="font-display block text-[24px] leading-tight font-semibold">
          {DEMO_SETUP_CREDIT.percentOfSetupFee}% off your setup fee
        </span>
      </span>
      <span className="rounded-xl bg-white/15 px-3 py-2 text-[14.4px] font-semibold">
        Ends in <DemoCountdown expiresAt={endsAt} />
      </span>
    </div>
  );
}

/**
 * The estimate's inputs, on screen and editable: the clinic's own price and
 * the enquiries it misses. An estimate from their numbers, never a result we
 * claim to have seen (lib/demo/roi.ts says why).
 */
export function RoiPanel({
  clinicName,
  inputs,
  onChange,
}: {
  clinicName: string;
  inputs: RoiInputs;
  onChange: (next: RoiInputs) => void;
}) {
  const field = (key: "priceUsd" | "missedCallsPerWeek" | "missedMessagesPerWeek", label: string, hint: string, prefix?: string) => (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-bold tracking-[0.04em] uppercase">{label}</span>
      <span className="border-line focus-within:border-orange flex items-center gap-1 rounded-xl border bg-white px-3 py-2">
        {prefix ? <span className="text-muted font-semibold">{prefix}</span> : null}
        <input
          type="number"
          min={0}
          inputMode="numeric"
          value={inputs[key]}
          onChange={(e) => onChange({ ...inputs, [key]: Math.max(0, Number(e.target.value) || 0) })}
          className="w-full bg-transparent text-[16px] font-semibold outline-none"
        />
      </span>
      {hint ? <span className="text-muted text-xs">{hint}</span> : null}
    </label>
  );
  return (
    <div className="border-line mt-5 rounded-2xl border bg-white p-5">
      <p className="text-[15.6px] font-bold">
        {inputs.repeat
          ? `A ${inputs.repeat.patient} is worth ≈ ${usd.format(patientValuePerYear(inputs) ?? 0)} a year to ${clinicName}.`
          : `What each package could book for ${clinicName}.`}
      </p>
      <p className="text-muted mt-0.5 text-[13.2px]">Estimates below use your numbers. Change any of them.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {field("priceUsd", "One visit", inputs.priceSource.replace(", from your website", ""), "$")}
        {field("missedCallsPerWeek", "Missed calls / wk", "")}
        {field("missedMessagesPerWeek", "Missed messages / wk", "")}
      </div>
    </div>
  );
}
