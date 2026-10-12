"use client";

import { CircleExpandCard } from "@/components/CircleExpandCard";
import { NICHE_MEDIA } from "@/lib/niche-media";
import type { Specialty } from "@/lib/specialties";

/**
 * The specialties, as a bento: eight cards of three sizes that tile a four by
 * three grid exactly, one big, one tall and six small.
 *
 * It was a four by two mosaic of equal cards from 9 October 2026, and before
 * that a deck. The owner asked on 12 October for the shape they had passed over
 * for "What changes in month one": non-equal cards, the same cards otherwise.
 * Each is still CircleExpandCard, arrow, footage on hover and colour flood
 * included, with the specialty's one-line `hook` under its name; only the
 * size differs, and the big one is set larger (its title, its padding and how
 * far its colour floods, which has to reach the far corner of a tile twice as
 * wide as the others).
 *
 *   four across (from 1024px)       two across
 *   [ big  big ][tall][ s ]         [   big    big   ]
 *   [ big  big ][tall][ s ]         [tall][ s ]
 *   [ s ][ s ][ s ][ s ]            [tall][ s ]
 *                                   [ s ][ s ] [ s ][ s ]
 *
 * The order is the specialties' own (lib/specialties.ts), so the big card is
 * the first, med spa, the one the section's visitors most often are.
 *
 * Only niches whose artwork exists are shown. A tile with no image reads as a
 * loading failure, not as a placeholder. All eight have it, so the grid is
 * exactly full.
 *
 * Every tile's footage is mounted, each preloading its metadata only: the
 * body of a clip is fetched when a hover asks for it.
 */

/** Spans by position: the first is the big card, the second the tall one. */
const SHAPES = [
  { cell: "col-span-2 lg:row-span-2", big: true },
  { cell: "row-span-2", big: false },
] as const;
const SMALL = { cell: "", big: false } as const;

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
    <ul
      className="grid auto-rows-[200px] grid-cols-2 gap-3 sm:auto-rows-[230px] sm:gap-4 lg:auto-rows-[230px] lg:grid-cols-4"
      aria-label="Specialties we cover"
    >
      {tiles.map((s, i) => {
        const shape = SHAPES[i] ?? SMALL;
        return (
          <li key={s.id} className={`relative ${shape.cell}`}>
            <CircleExpandCard
              title={s.name}
              body={s.hook}
              still={NICHE_MEDIA[s.id]!.still}
              video={NICHE_MEDIA[s.id]!.video}
              onActivate={onOpen}
              compact={!shape.big}
              floodScale={shape.big ? 34 : undefined}
            />
          </li>
        );
      })}
    </ul>
  );
}
