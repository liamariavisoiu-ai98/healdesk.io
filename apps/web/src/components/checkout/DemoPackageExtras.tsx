"use client";

import { patientValuePerYear, type RoiInputs } from "@/lib/demo/roi";
import { usd } from "@/lib/pricing";

/**
 * What a buyer who arrives from their personalised demo sees on the package
 * step beyond the packages themselves: the editable inputs behind the
 * estimates on each package (lib/demo/roi.ts). The demo's setup offer (50%
 * from an operator's demo, 30% from a homepage one, for 48 hours) is not here: it is one of the setup offers the flow takes
 * as `setupOffer` (lib/checkout/review.ts) and shows in the same banner as
 * any other (SetupOfferBanner).
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
};

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
      <span className="border-line focus-within:border-orange flex items-center gap-1 rounded-sm border bg-white px-3 py-2">
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
    <div className="border-line mt-5 rounded-md border bg-white p-5">
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
