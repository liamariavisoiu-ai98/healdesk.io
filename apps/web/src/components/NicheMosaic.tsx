"use client";

import { CircleExpandCard } from "@/components/CircleExpandCard";
import { NICHE_MEDIA } from "@/lib/niche-media";
import type { Specialty } from "@/lib/specialties";

/**
 * The specialties, as a mosaic: four across and two down on a desktop, two
 * across on a tablet, one on a phone.
 *
 * It replaced a deck on 9 October 2026, at the owner's request. The deck
 * dealt one specialty at a time, so a visitor saw one and had to work for the
 * other seven; the mosaic puts all eight on screen at once, which is what the
 * section claims, that she already knows all of them. Each tile is the deck's
 * card (CircleExpandCard), arrow, footage on hover and colour flood included,
 * in its compact size, with the specialty's one-line `hook` under its name.
 *
 * Only niches whose artwork exists are shown. A tile with no image reads as a
 * loading failure, not as a placeholder. All eight have it, so the grid is
 * exactly full.
 *
 * Every tile's footage is mounted, each preloading its metadata only: the
 * body of a clip is fetched when a hover asks for it.
 */
export function NicheMosaic({
  specialties,
  onOpen,
}: {
  specialties: readonly Specialty[];
  /** Take me to the agent. */
  onOpen: () => void;
}) {
  const tiles = specialties.filter((s) => NICHE_MEDIA[s.id]);

  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="Specialties we cover">
      {tiles.map((s) => (
        <li key={s.id} className="relative aspect-[4/5] sm:aspect-[3/4]">
          <CircleExpandCard
            title={s.name}
            body={s.hook}
            still={NICHE_MEDIA[s.id]!.still}
            video={NICHE_MEDIA[s.id]!.video}
            onActivate={onOpen}
            compact
          />
        </li>
      ))}
    </ul>
  );
}
