import { Attribution } from "@/components/Attribution";
import { CTA } from "@/components/CTA";
import { Footer } from "@/components/Footer";
import { HowItWorks } from "@/components/HowItWorks";
import { LeakCalculator } from "@/components/LeakCalculator";
import { Nav } from "@/components/Nav";
import { SpecialtyExperience } from "@/components/SpecialtyExperience";
import { site } from "@/lib/site";

export default function HomePage() {
  return (
    <>
      <Nav />

      <main id="top" className="mx-auto max-w-[1240px] px-5 sm:px-8 lg:px-14">
        {/* Hero */}
        <section className="pt-[clamp(40px,7vw,84px)] pb-[clamp(24px,3vw,40px)]">
          <h1 className="font-display max-w-[16ch] text-[clamp(38px,6.4vw,82px)] leading-[1.0] font-medium tracking-[-0.028em]">
            {site.tagline}
          </h1>
          <p className="text-muted mt-5 text-[clamp(15px,1.5vw,18px)] font-medium">
            {site.subtitle}
          </p>
        </section>

        {/* Specialty strip + live chat and voice demos */}
        <SpecialtyExperience />

        <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
          <a
            href={site.cta.primary.href}
            className="bg-brand-gradient shadow-brand hover:shadow-brand-lg inline-flex items-center gap-2 rounded-full px-8 py-4 text-base font-bold text-white transition-all duration-200 hover:-translate-y-0.5"
          >
            {site.cta.primary.label}
          </a>
          <a
            href={site.cta.secondary.href}
            className="border-line-strong text-ink hover:border-ink inline-flex items-center gap-2 rounded-full border-[1.5px] px-8 py-4 text-base font-bold transition-colors hover:bg-[color:var(--color-ink)]/[0.04]"
          >
            {site.cta.secondary.label}
          </a>
        </div>

        <LeakCalculator />
        <Attribution />
        <HowItWorks />
        <CTA />
      </main>

      <Footer />
    </>
  );
}
