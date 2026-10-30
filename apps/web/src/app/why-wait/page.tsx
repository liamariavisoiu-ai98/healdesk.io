import type { Metadata } from "next";

import { TrackView } from "@/components/analytics/TrackView";
import { BuyModalProvider } from "@/components/BuyModal";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { WhyWaitExperience } from "@/components/WhyWaitExperience";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  alternates: { canonical: "/why-wait" },
  title: "Why wait?",
  description:
    "Work out what the calls your practice never hears about are worth, with your " +
    `own numbers, then talk to ${site.agent}.`,
};

/**
 * /why-wait: the revenue calculator, on its own page, reached from the navbar.
 *
 * See WhyWaitExperience for why it left the homepage. This file is the server
 * shell: metadata, the frame, and the provider the navbar's buy button needs.
 */
export default function WhyWaitPage() {
  return (
    <BuyModalProvider>
      <TrackView event="why_wait_viewed" />
      <Nav />
      <main className="mx-auto max-w-page px-5 sm:px-8 lg:px-14">
        <WhyWaitExperience />
      </main>
      <Footer />
    </BuyModalProvider>
  );
}
