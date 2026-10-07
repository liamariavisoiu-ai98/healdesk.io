"use client";

import { type BillingInterval, channelList, demoSetupCreditUsd, getPlan, type Plan } from "@healdesk/catalog";

import { estimate, type RoiInputs } from "@/lib/demo/roi";
import { allowanceRows, CHANNEL_LABELS, monthlyFigureUsd, usd } from "@/lib/pricing";

/**
 * The demo buyer's packages, as rows grouped by what they answer: the phone,
 * website chat, the Meta inboxes, both chats, chat with the phone, or all of
 * it (owner, 7 October 2026). Every package is its own row, so there is no
 * "web or Meta" choice to make afterwards.
 *
 * A row shows the name, the price and what it is likely to book for this
 * clinic (lib/demo/roi.ts); choosing one opens it to the detail: allowances,
 * the setup fee and what it includes, and the full estimate.
 */

const GROUPS: { title: string; planIds: string[] }[] = [
  { title: "Voice", planIds: ["voice"] },
  { title: "Web chat", planIds: ["chat-web"] },
  { title: "Meta: Instagram, Messenger + WhatsApp", planIds: ["chat-meta"] },
  { title: "Both chats", planIds: ["chat-dual"] },
  { title: "Chat + Voice", planIds: ["web-voice", "meta-voice"] },
  { title: "All together", planIds: ["complete"] },
];

export function DemoPlanPicker({
  interval,
  selectedPlanId,
  onSelect,
  roi,
  setupWaived,
  includes,
}: {
  interval: BillingInterval;
  selectedPlanId: string;
  onSelect: (plan: Plan) => void;
  roi: RoiInputs | null;
  setupWaived: boolean;
  /** What the setup fee buys, one line. */
  includes: string;
}) {
  return (
    <div className="mt-5 space-y-5">
      {GROUPS.map((group) => (
        <section key={group.title}>
          <p className="text-muted mb-2 text-xs font-bold tracking-[0.08em] uppercase">{group.title}</p>
          <div className="space-y-2">
            {group.planIds.map((id) => {
              const plan = getPlan(id);
              if (!plan) return null;
              const open = plan.id === selectedPlanId;
              const est = roi ? estimate(plan, roi) : null;
              const recommended = plan.id === "complete";
              return (
                <div
                  key={plan.id}
                  className={`overflow-hidden rounded-2xl border transition-all ${
                    open ? "border-red bg-orange/[0.05] shadow-brand" : "border-line hover:border-line-strong bg-white"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(plan)}
                    aria-expanded={open}
                    className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 text-left sm:flex-nowrap"
                  >
                    <span
                      aria-hidden
                      className={`grid size-5 shrink-0 place-items-center rounded-full border-2 ${open ? "border-red" : "border-line-strong"}`}
                    >
                      {open ? <span className="bg-red size-2.5 rounded-full" /> : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-display text-[18.6px] leading-tight font-medium">{plan.name}</span>
                        {recommended ? (
                          <span className="bg-sun text-ink rounded-full px-2 py-0.5 text-[10.8px] font-bold tracking-[0.06em] uppercase">
                            Recommended
                          </span>
                        ) : null}
                      </span>
                      <span className="text-muted block text-[13.2px]">
                        {channelList(plan)
                          .map((c) => CHANNEL_LABELS[c])
                          .join(" · ")}
                      </span>
                    </span>
                    <span className="text-right">
                      <span className="font-display block text-[22px] leading-none font-semibold">
                        {usd.format(monthlyFigureUsd(plan, interval))}
                        <span className="text-muted text-[13px] font-medium">/mo</span>
                      </span>
                      {est && est.bookedValueUsd > 0 ? (
                        <span className="mt-1 block text-[12.6px] font-bold text-[#2f7d3a]">
                          likely books ≈ {usd.format(est.bookedValueUsd)}/mo
                        </span>
                      ) : null}
                    </span>
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className={`text-muted size-5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
                      aria-hidden
                    >
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </button>

                  {open ? (
                    <div className="border-line grid gap-4 border-t px-4 py-4 sm:grid-cols-2">
                      <div className="text-[14.4px]">
                        {allowanceRows(plan).map((row) => (
                          <p key={row.label} className="text-muted">
                            {row.label}: <span className="text-ink font-semibold">{row.value}</span>
                          </p>
                        ))}
                        <p className="text-muted mt-1">
                          Setup:{" "}
                          {setupWaived ? (
                            <>
                              <span className="line-through">{usd.format(plan.setupFeeUsd)}</span>{" "}
                              <span className="font-semibold text-[#2f7d3a]">
                                {usd.format(plan.setupFeeUsd - demoSetupCreditUsd(plan))} this week
                              </span>
                            </>
                          ) : (
                            <span className="text-ink font-semibold">{usd.format(plan.setupFeeUsd)} once</span>
                          )}
                        </p>
                        <p className="text-ink mt-1 text-[13px] font-semibold">{includes}</p>
                      </div>
                      {est && est.bookedValueUsd > 0 ? (
                        <div className="rounded-xl bg-[#e5f6dc] px-3.5 py-3 text-[13.8px] text-[#172a3a]">
                          <p className="text-[12.6px] font-semibold">A clinic like yours is likely to book</p>
                          <p className="font-display text-[22px] leading-tight font-semibold">≈ {usd.format(est.bookedValueUsd)} a month</p>
                          <p>
                            about {est.patientsPerMonth} new patients · {est.multiple}× its price
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
        </section>
      ))}
    </div>
  );
}
