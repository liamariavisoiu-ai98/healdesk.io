import { cheapestPlan, usd } from "@/lib/pricing";
import { site } from "@/lib/site";

/**
 * The closing band. Lives on /pricing now rather than the homepage, the
 * homepage ends on the FAQ and the contact form, because a visitor who has
 * questions left converts worse than one who has just had them answered.
 *
 * The price line names the setup fee beside the monthly figure on purpose.
 * A "From $397/mo" that meets a $497 line item at checkout is the kind of
 * surprise that ends in a chargeback; both numbers come from the cheapest
 * package so the line cannot quote one package's rate and another's fee.
 */
export function CTA() {
  const entry = cheapestPlan();

  return (
    <section id="get-started" className="scroll-mt-24 pt-8 pb-24 sm:pb-32">
      <div className="bg-brand-gradient-deep shadow-brand-lg relative overflow-hidden rounded-[28px] px-8 py-16 text-center text-white sm:px-14 sm:py-20">
        <h2 className="font-display mx-auto max-w-[18ch] text-[clamp(38.4px,6vw,67.2px)] leading-[1.02] font-medium tracking-[-0.03em]">
          Make it yours.
        </h2>
        <p className="mx-auto mt-5 max-w-[46ch] text-[20.4px] font-medium text-white">
          Tell us your specialty and where the phone drops. We&apos;ll build the
          front desk around your treatments, your pricing and your Google Calendar.
        </p>

        <div className="mt-9 flex flex-wrap items-center justify-center gap-4">
          <a
            href="/get-started"
            className="text-ink inline-flex items-center gap-2 rounded-full bg-white px-8 py-4 text-base font-bold transition-transform duration-200 hover:-translate-y-0.5"
          >
            Get started
          </a>
          <a
            href={`mailto:${site.email}?subject=healdesk%20demo`}
            className="inline-flex items-center gap-2 rounded-full border-[1.5px] border-white/40 px-8 py-4 text-base font-bold text-white transition-colors hover:border-white hover:bg-white/10"
          >
            Talk to us first
          </a>
        </div>

        <p className="mt-7 text-[15.6px] font-medium text-white">
          From {usd.format(entry.monthlyUsd)}/mo + {usd.format(entry.setupFeeUsd)}{" "}
          setup · Works with your Google Calendar
        </p>
      </div>
    </section>
  );
}
