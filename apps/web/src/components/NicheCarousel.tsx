"use client";

import { NicheStack } from "@/components/NicheStack";
import type { Specialty } from "@/lib/specialties";

/**
 * The specialties section. Two lines of heading and the deck, nothing else.
 *
 * It replaced a marquee, and the shape change is the argument. A reel implies
 * a list you are meant to scan. A deck implies one thing at a time, which is
 * what this section actually claims: not "here are seven products" but "here
 * is the one agent, and here is a phone she knows, and another".
 *
 * The pricing disclaimer that used to sit under the deck has gone. The cards
 * still quote figures, so the claim has to live somewhere: it is in the
 * footer, on every page, as "Pricing figures shown in demos are approximate
 * industry ranges, not quotes." Do not remove that one too.
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

        <h2 className="font-display mx-auto mt-5 text-[clamp(33.6px,4.8vw,55.2px)] leading-[1.06] font-medium tracking-[-0.026em] text-balance">
          Explore the specialties we cover
        </h2>
      </div>

      <div className="mt-12">
        <NicheStack specialties={specialties} onOpen={onSelect} />
      </div>
    </section>
  );
}
