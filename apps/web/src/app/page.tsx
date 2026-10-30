import type { Metadata } from "next";

import { BuyModalProvider } from "@/components/BuyModal";
import { ClosingCta } from "@/components/ClosingCta";
import { Footer } from "@/components/Footer";
import { HeroStage } from "@/components/HeroStage";
import { HomeExperience } from "@/components/HomeExperience";
import { KnowMore } from "@/components/KnowMore";
import { Nav } from "@/components/Nav";
import { Reviews } from "@/components/Reviews";
import { PUBLISHED, summarize } from "@/lib/reviews";
import { SAMPLE } from "@/lib/reviews.sample";

/**
 * The reviews the wall shows: the published ones once there are any, and
 * until then the sample set.
 *
 * ⚠️ The sample set is invented (src/lib/reviews.sample.ts). Until 12
 * October 2026 the wall printed a line above the rating calling it examples;
 * the owner replaced that line with the section's heading that day and will
 * replace the set with real reviews before launch.
 */
const SHOWING_EXAMPLES = PUBLISHED.length === 0;
const REVIEWS = SHOWING_EXAMPLES ? SAMPLE : summarize(PUBLISHED);

/**
 * The homepage is the one page with no metadata of its own, so it declares a
 * canonical here rather than inheriting one from the layout: a canonical set
 * in the layout would be inherited by every route that does not override it,
 * including /get-started and the 404, and point them all at the homepage.
 * healdesk.io without the www is the canonical origin (owner's decision, 3
 * October 2026); `metadataBase` in app/layout.tsx resolves this path against
 * it, and Vercel's own domain settings redirect www there.
 */
export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

/**
 * The homepage, and the whole site's argument.
 *
 * Seven things in order: the claim, AYA working, what changes in month one,
 * the specialties we know, what clinics say, a way to ask, and the two ways
 * in once more. Pricing and contact
 * are their own pages but are reachable only from the footer, so nothing
 * competes with the demo for a visitor's first click.
 *
 * What clinics say is the review wall. Until real reviews are published it
 * shows the sample set (see REVIEWS above). "Leave a review" sits under its
 * score.
 *
 * ## Nothing is parked any more
 *
 * `Attribution`, `HowItWorks`, `LeakCalculator` and `SpecialtyStrip` sat
 * unrendered in src/components for two weeks and were deleted on 23 September
 * 2026; the booked → showed → collected chain they carried is in git history
 * if it comes back. `WhyGoSmart` moved to /why-wait. `CTA`, which closed
 * /pricing, went with that page on 9 October 2026.
 */
export default function HomePage() {
  return (
    /* Wraps everything, so "Get Started" opens the flow in place from the
       navbar and from inside either demo panel. Deliberately outside
       HeroMarkProvider rather than inside it: that one must not reach the
       Footer, this one has no such constraint. */
    <BuyModalProvider>
      <Nav />

      {/* A sibling of <main> so the demo section keeps `scroll-mt` maths
          simple; it carries its own container. The sticky stage and the
          wordmark hand-off that used to live here are gone, see HeroStage. */}
      <HeroStage />

      <main className="mx-auto max-w-page px-5 sm:px-8 lg:px-14">
        {/* Demos (#aya), the niche reel, and "Why go smart?", all driven by
            one selected specialty, so they cannot disagree with each other. */}
        <HomeExperience />

        {/* Social proof sits between the money question and the FAQ on
            purpose: the FAQ then answers whatever the reviews raised. */}
        <Reviews summary={REVIEWS} />

        <KnowMore />

        {/* The two ways in once more, for whoever read to the end (owner,
            12 October 2026). No prices: those are in the buy flow. */}
        <ClosingCta />
      </main>

      <Footer />
    </BuyModalProvider>
  );
}
