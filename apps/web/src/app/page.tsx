import { plans } from "@healdesk/catalog";

import { BuyModalProvider } from "@/components/BuyModal";
import { Footer } from "@/components/Footer";
import { HeroStage } from "@/components/HeroStage";
import { HomeExperience } from "@/components/HomeExperience";
import { KnowMore } from "@/components/KnowMore";
import { Nav } from "@/components/Nav";
import { Reviews } from "@/components/Reviews";

/**
 * The homepage, and the whole site's argument.
 *
 * Six things in order: the claim with AYA beside it, AYA working, the
 * specialties we know, what that is worth, who already pays for it, and a way
 * to ask. Pricing and contact
 * are their own pages but are reachable only from the footer, so nothing
 * competes with the demo for a visitor's first click.
 *
 * ⚠️ The reviews are placeholder content and must not ship as written. See the
 * note at the top of src/lib/reviews.ts.
 *
 * ## Nothing is parked any more
 *
 * `Attribution`, `HowItWorks`, `LeakCalculator` and `SpecialtyStrip` sat
 * unrendered in src/components for two weeks and were deleted on 23 September
 * 2026; the booked → showed → collected chain they carried is in git history
 * if it comes back. `WhyGoSmart` moved to /why-wait. `CTA` closes /pricing.
 */
export default function HomePage() {
  return (
    /* Wraps everything, so "Get Started" opens the flow in place from the
       navbar and from inside either demo panel. Deliberately outside
       HeroMarkProvider rather than inside it: that one must not reach the
       Footer, this one has no such constraint. */
    <BuyModalProvider initialPlan={plans[0]!.id}>
      <Nav />

      {/* A sibling of <main> so the demo section keeps `scroll-mt` maths
          simple; it carries its own container. The sticky stage and the
          wordmark hand-off that used to live here are gone, see HeroStage. */}
      <HeroStage />

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
