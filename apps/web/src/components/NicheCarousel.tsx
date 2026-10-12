"use client";

import { NicheMosaic } from "@/components/NicheMosaic";
import type { Specialty } from "@/lib/specialties";

/**
 * The specialties section. Two lines of heading and the mosaic, nothing else.
 *
 * It replaced a marquee, and then a deck, and each change of shape was the
 * argument. A reel implies a list you are meant to scan; a deck, one thing at
 * a time. Since 9 October 2026 it is a 4×2 mosaic (NicheMosaic.tsx), at the
 * owner's request: all eight on screen at once, because the claim is "here is
 * the one agent, and here are the phones she already knows". The name of the
 * file is the old one, kept so the history follows it.
 *
 * The pricing disclaimer that used to sit under the deck moved to the footer,
 * and left it on 12 October 2026, at the owner's request. The demos still
 * quote figures; the contact page says they are ranges, not quotes.
 */
export function NicheCarousel({
  specialties,
  onSelect,
}: {
  specialties: readonly Specialty[];
  /** Take me to the agent. There is nothing to select. She covers them all. */
  onSelect: () => void;
}) {
  return (
    <section id="specialties" className="scroll-mt-24 py-20 sm:py-24">
      {/* Centred to sit over the deck, which is centred too. */}
      <div className="mx-auto max-w-[52ch] text-center">
        <p className="eyebrow-tag">
          Where you can trust us
        </p>
        {/* Hairline divider. Solid at the middle, gone at both ends, so it
            reads as a mark under the eyebrow rather than a rule boxing the
            heading in. Decorative, so it is hidden from assistive tech. */}
        <span
          aria-hidden
          className="bg-gradient-to-r from-transparent via-orange to-transparent mx-auto mt-5 block h-px w-full max-w-[200px]"
        />

        <h2 className="heading-section mx-auto mt-5">
          Explore the specialties we cover
        </h2>
      </div>

      <div className="mt-12">
        <NicheMosaic specialties={specialties} onOpen={onSelect} />
      </div>
    </section>
  );
}
