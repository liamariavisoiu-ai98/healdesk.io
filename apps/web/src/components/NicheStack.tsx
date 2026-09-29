"use client";

import { Deck } from "@/components/Deck";
import { NICHE_MEDIA } from "@/lib/niche-media";
import type { Specialty } from "@/lib/specialties";

/**
 * The specialties, as a deck.
 *
 * The deck itself lives in Deck.tsx since 29 September 2026, when the
 * outcomes section needed the same object with photographs of the clinic
 * instead of the niches. This file is what is left: the mapping from a
 * specialty and its artwork onto a card.
 *
 * Only niches whose artwork exists are dealt. A card with no image in a deck
 * this large reads as a loading failure, not as a placeholder.
 */
export function NicheStack({
  specialties,
  onOpen,
}: {
  specialties: readonly Specialty[];
  /** Take me to the agent. */
  onOpen: () => void;
}) {
  const items = specialties
    .filter((s) => NICHE_MEDIA[s.id])
    .map((s) => ({
      id: s.id,
      title: s.name,
      body: s.expertise,
      still: NICHE_MEDIA[s.id]!.still,
      video: NICHE_MEDIA[s.id]!.video,
    }));

  return <Deck items={items} label="Specialties we cover" noun="specialty" onOpen={onOpen} />;
}
