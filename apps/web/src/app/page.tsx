import { plans } from "@healdesk/catalog";

import { BuyModalProvider } from "@/components/BuyModal";
import { Footer } from "@/components/Footer";
import { HeroMarkProvider } from "@/components/HeroMark";
import { HeroStage } from "@/components/HeroStage";
import { HomeExperience } from "@/components/HomeExperience";
import { KnowMore } from "@/components/KnowMore";
import { Nav } from "@/components/Nav";
import { Reviews } from "@/components/Reviews";

/**
 * The homepage, and the whole site's argument.
 *
 * Six things in order: AYA's face, AYA working, the specialties we know, what
 * that is worth, who already pays for it, and a way to ask. Pricing and contact
 * are their own pages but are reachable only from the footer, so nothing
 * competes with the demo for a visitor's first click.
 *
 * ⚠️ The reviews are placeholder content and must not ship as written. See the
 * note at the top of src/lib/reviews.ts.
 *
 * ## Parked components
 *
 * `Attribution`, `HowItWorks`, `LeakCalculator` and `SpecialtyStrip` are still
 * in src/components but are no longer rendered anywhere. They are kept on disk
 * rather than deleted because this structure is a first pass, the
 * booked → showed → collected chain in particular is the strongest thing the
 * site has ever said, and it will likely come back somewhere. Delete them once
 * that call is made; do not re-import them without deciding where they go.
 *
 * `CTA` is NOT parked: it closes /pricing. Keep this list accurate, an audit
 * of the funnel read a stale version of it and concluded the checkout button
 * existed nowhere, which sent it looking for a break that was not there.
 */
export default function HomePage() {
  return (
    /* Wraps everything, so "Get Started" opens the flow in place from the
       navbar and from inside either demo panel. Deliberately outside
       HeroMarkProvider rather than inside it: that one must not reach the
       Footer, this one has no such constraint. */
    <BuyModalProvider initialPlan={plans[0]!.id}>
      {/* Wraps ONLY these two. The giant healdesk.io behind AYA and the navbar
          logo are two halves of one hand-off and share a motion value; the
          Footer imports the same Brand, so a provider that reached it would
          fade the footer wordmark out along with the hero one. */}
      <HeroMarkProvider>
        <Nav />

        {/* Full-bleed, and a sibling of <main> rather than a child: breaking
            out of main would mean overflow-x on it, which silently turns it
            into a scroll container and strands the sticky stage. */}
        <HeroStage />
      </HeroMarkProvider>

      <main className="mx-auto max-w-[1240px] px-5 sm:px-8 lg:px-14">
        {/* Demos (#aya), the niche reel, and "Why go smart?", all driven by
            one selected specialty, so they cannot disagree with each other. */}
        <HomeExperience />

        {/* Social proof sits between the money question and the FAQ on
            purpose. WhyGoSmart leaves a reader holding a number they worked out
            themselves, which is the moment they start asking whether anyone
            else believes it; the FAQ then answers whatever the reviews raised. */}
        <Reviews />

        <KnowMore />
      </main>

      <Footer />
    </BuyModalProvider>
  );
}
