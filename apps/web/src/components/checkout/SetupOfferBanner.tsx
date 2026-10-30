"use client";

import type { Plan } from "@healdesk/catalog";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { offerCredit, offerHeadline, type SetupOffer, setupDueUsd } from "@/lib/checkout/review";
import { usd } from "@/lib/pricing";

/**
 * The setup offer on the package step: what it takes off and how long it
 * holds, counted down to the second (lib/checkout/review.ts says which offer
 * a buyer sees, and why only one). Once a package is chosen it says it in
 * dollars too, the list fee struck through and what is saved: a saving over
 * $100 reads larger in dollars than as a share.
 *
 * The clock is the offer's own end, the moment /api/checkout stops applying
 * the coupon, so the page never promises a discount past it. When it reaches
 * zero, `onEnd` tells the flow, which drops the offer from every figure.
 */
export function SetupOfferBanner({
  offer,
  plan = null,
  onEnd,
}: {
  offer: SetupOffer;
  /** The plan chosen, for the figures in dollars; null until one is. */
  plan?: Pick<Plan, "setupFeeUsd"> | null;
  onEnd?: () => void;
}) {
  const due = plan ? setupDueUsd(plan, offer) : null;
  return (
    <div className="bg-brand-gradient shadow-sm mb-5 flex flex-wrap items-center justify-between gap-3 rounded-md px-5 py-4 text-white">
      <span>
        <span className="block text-xs font-bold tracking-[0.12em] uppercase opacity-85">
          {offer.kind === "demo" ? "Demo offer" : offer.kind === "site" ? "Website offer" : "Setup credit"}
        </span>
        <span className="font-display block text-xl leading-tight font-semibold">
          {offerHeadline(offer)}
        </span>
        {plan && due !== null && due < plan.setupFeeUsd ? (
          <span className="mt-1 block text-sm font-semibold tabular-nums">
            Setup <s className="opacity-75">{usd.format(plan.setupFeeUsd)}</s> {usd.format(due)} · you save{" "}
            {usd.format(plan.setupFeeUsd - due)}
          </span>
        ) : null}
      </span>
      <span className="rounded-sm bg-white/15 px-3 py-2 text-xs font-semibold">
        Ends in <OfferCountdown endsAt={offer.endsAt} onEnd={onEnd} />
      </span>
    </div>
  );
}

/** The offer as a badge and its clock, for the checkout header beside the clinic's name. */
export function OfferBadge({ offer, onEnd }: { offer: SetupOffer; onEnd?: () => void }) {
  const percent = offerCredit(offer).percentOfSetupFee;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold tabular-nums">
      <span className="rounded-full bg-[#87d68d] px-2.5 py-0.5 font-bold text-[#172a3a]">
        {percent >= 100 ? "Setup on us" : `${percent}% off setup`}
      </span>
      <span className="text-muted">
        ends in <OfferCountdown endsAt={offer.endsAt} onEnd={onEnd} />
      </span>
    </span>
  );
}

function parts(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return {
    days: Math.floor(total / 86_400),
    hours: Math.floor((total % 86_400) / 3_600),
    minutes: Math.floor((total % 3_600) / 60),
    seconds: total % 60,
  };
}

/**
 * Days, hours, minutes and seconds to `endsAt`. Before the first client
 * reading it shows dashes rather than a guess, so a server render and the
 * first client render agree and nobody is shown a figure that is not true.
 */
export function OfferCountdown({ endsAt, onEnd }: { endsAt: string; onEnd?: () => void }) {
  const end = Date.parse(endsAt);
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    // The browser's clock, read as the effect subscribes to it.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- first clock reading, at mount
    setNow(Date.now());
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= end) {
        window.clearInterval(id);
        onEnd?.();
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [end, onEnd]);

  const cell = (value: number | null, label: string) => (
    <span className="inline-flex items-baseline gap-0.5">
      <span className="font-display text-base font-semibold tabular-nums">
        {value === null ? "--" : value.toString().padStart(2, "0")}
      </span>
      <span className="text-xs font-bold opacity-75">{label}</span>
    </span>
  );
  const left = now === null ? null : parts(end - now);

  return (
    <span className="inline-flex items-center gap-1.5" role="timer" aria-live="off">
      {left === null || left.days > 0 ? cell(left?.days ?? null, "d") : null}
      {cell(left?.hours ?? null, "h")}
      {cell(left?.minutes ?? null, "m")}
      {cell(left?.seconds ?? null, "s")}
    </span>
  );
}

/**
 * The countdown on a page the server draws, which asks the server to draw it
 * again when the clock reaches zero, so the offer leaves the page the moment
 * checkout stops honouring it (the demo page's banner).
 */
export function RefreshingOfferCountdown({ endsAt }: { endsAt: string }) {
  const router = useRouter();
  const refresh = useCallback(() => router.refresh(), [router]);
  return <OfferCountdown endsAt={endsAt} onEnd={refresh} />;
}
