import { plans } from "@healdesk/catalog";
import type { Metadata } from "next";

import { BuyModalProvider } from "@/components/BuyModal";
import { Footer } from "@/components/Footer";
import { HeroStage } from "@/components/HeroStage";
import { HomeExperience } from "@/components/HomeExperience";
import { KnowMore } from "@/components/KnowMore";
import { LeaveReview } from "@/components/LeaveReview";
import { Nav } from "@/components/Nav";
import { Reviews } from "@/components/Reviews";
import { PUBLISHED, summarize } from "@/lib/reviews";
import { SAMPLE } from "@/lib/reviews.sample";

/**
 * The reviews the wall shows.
 *
 * ⚠️ The sample set is invented and is for `next dev` only. Every build,
 * Vercel's previews included, runs with NODE_ENV "production" and gets the
 * published reviews, which hides the section while there are none.
 * src/lib/reviews.test.ts pins this line.
 */
const REVIEWS =
  process.env.NODE_ENV === "production" ? summarize(PUBLISHED) : SAMPLE;

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
 * Six things in order: the claim, AYA working, what changes in month one,
 * the specialties we know, what clinics say, and a way to ask. Pricing and contact
 * are their own pages but are reachable only from the footer, so nothing
 * competes with the demo for a visitor's first click.
 *
 * What clinics say is the review wall, and it is there only when there are
 * reviews to put on it (see REVIEWS above). While it is hidden, "leave a
 * review", which normally sits in the wall's header, moves under the FAQ so
 * customers can still reach it.
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
            purpose: the FAQ then answers whatever the reviews raised. */}
        {REVIEWS.reviews.length > 0 && <Reviews summary={REVIEWS} />}

        <KnowMore />

        {REVIEWS.reviews.length === 0 && (
          <div className="border-line border-t pt-8 pb-24 sm:pb-28">
            <LeaveReview />
          </div>
        )}
      </main>

      <Footer />
    </BuyModalProvider>
  );
}
