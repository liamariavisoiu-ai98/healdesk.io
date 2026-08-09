import { plans, TRIAL_DAYS } from "@healdesk/catalog";

import { site } from "@/lib/site";

export function CTA() {
  const entry = plans[0]!;

  return (
    <section id="get-started" className="scroll-mt-24 pt-8 pb-24 sm:pb-32">
      <div className="bg-brand-gradient shadow-brand-lg relative overflow-hidden rounded-[28px] px-8 py-16 text-center text-white sm:px-14 sm:py-20">
        <h2 className="font-display mx-auto max-w-[18ch] text-[clamp(32px,5vw,56px)] leading-[1.02] font-medium tracking-[-0.03em]">
          Make it yours.
        </h2>
        <p className="mx-auto mt-5 max-w-[46ch] text-[17px] font-medium text-white/85">
          Tell us your specialty and where the phone drops. We&apos;ll build the
          front desk around your treatments, your pricing, and your booking stack.
        </p>

        <div className="mt-9 flex flex-wrap items-center justify-center gap-4">
          <a
            href={site.cta.primary.href}
            className="text-ink inline-flex items-center gap-2 rounded-full bg-white px-8 py-4 text-base font-bold transition-transform duration-200 hover:-translate-y-0.5"
          >
            Start {TRIAL_DAYS}-day free trial
          </a>
          <a
            href="mailto:hello@healdesk.io?subject=healdesk%20demo"
            className="inline-flex items-center gap-2 rounded-full border-[1.5px] border-white/40 px-8 py-4 text-base font-bold text-white transition-colors hover:border-white hover:bg-white/10"
          >
            Talk to us first
          </a>
        </div>

        <p className="mt-7 text-[13px] font-medium text-white/70">
          From ${entry.monthlyUsd}/mo · ${entry.setupFeeUsd} setup · No booking
          software required
        </p>
      </div>
    </section>
  );
}
