"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import { CircleExpandCard } from "@/components/CircleExpandCard";
import { NICHE_MEDIA } from "@/lib/niche-media";
import type { Specialty } from "@/lib/specialties";

/**
 * The specialties, as a bento: eight cards of three sizes that tile a four by
 * three grid exactly, one big, one tall and six small, where the card a visitor
 * is on opens in place.
 *
 * It was a four by two mosaic of equal cards from 9 October 2026, and before
 * that a deck. The owner asked on 12 October for the shape they had passed over
 * for "What changes in month one": non-equal cards, the same cards otherwise.
 * Each is still CircleExpandCard, arrow, footage on hover and colour flood
 * included, with the specialty's one-line `hook` under its name.
 *
 * ## One card open, wherever the visitor is (the owner, 12 October)
 *
 * The first card is open by default: larger, its description showing and its
 * footage playing. Resting on another card (or focusing it, or tapping it on a
 * touch screen) opens that one where it is, and the first closes. Nothing is
 * moved or re-ordered. The cards sit in a fixed map, and what changes is the
 * size of the grid's own tracks: the open card's columns and rows grow and the
 * others' shrink, so the whole bento is one CSS transition (globals.css, "The
 * specialties bento") and nothing is measured or animated from here.
 *
 *   four across (from 1024px)       two across
 *   [ 1  1 ][ 2 ][ 3 ]              [   1    1   ]
 *   [ 1  1 ][ 2 ][ 4 ]              [ 2 ][ 3 ]
 *   [ 5 ][ 6 ][ 7 ][ 8 ]            [ 2 ][ 4 ]
 *                                   [ 5 ][ 6 ] [ 7 ][ 8 ]
 *
 * Which tracks a card spans is in the two maps below, and the grid's CSS puts
 * the cards in the same cells. A card on its own track gets all of the boost;
 * the big card, on two, gets half on each. At rest, with nobody on the bento,
 * the boost is half of what a visitor's card gets, so the first card is open
 * without the others looking squeezed.
 *
 * ## Letting a card slide under a pointer without a flicker
 *
 * Tracks move under a pointer that is still, and the card that arrives under
 * it would open in its turn. So a card opens only after the pointer has rested
 * on it for 120ms and is still there, and the open card always grows toward the
 * pointer, never away from it (the default weights make every later column and
 * row start narrower than the first, so a card widens leftwards and upwards
 * over its old place).
 *
 * The bento returns to the first card 0.9s after the pointer or focus leaves
 * it. On a touch screen the first tap opens a card and the second goes to the
 * agent, as a click does with a mouse.
 *
 * The order is the specialties' own (lib/specialties.ts), so the first card is
 * med spa. Only niches whose artwork exists are shown. A tile with no image
 * reads as a loading failure, not as a placeholder. All eight have it, so the
 * grid is exactly full.
 *
 * Every tile's footage is mounted, each preloading its metadata only: the body
 * of a clip is fetched when a card opens or a hover asks for it, and the open
 * card does not fetch until the bento is near the screen.
 */

type Cell = { cols: readonly number[]; rows: readonly number[] };

/** Four across, three down. The tracks each card spans, from zero. */
const FOUR: readonly Cell[] = [
  { cols: [0, 1], rows: [0, 1] },
  { cols: [2], rows: [0, 1] },
  { cols: [3], rows: [0] },
  { cols: [3], rows: [1] },
  { cols: [0], rows: [2] },
  { cols: [1], rows: [2] },
  { cols: [2], rows: [2] },
  { cols: [3], rows: [2] },
];

/** Two across, five down. */
const TWO: readonly Cell[] = [
  { cols: [0, 1], rows: [0] },
  { cols: [0], rows: [1, 2] },
  { cols: [1], rows: [1] },
  { cols: [1], rows: [2] },
  { cols: [0], rows: [3] },
  { cols: [1], rows: [3] },
  { cols: [0], rows: [4] },
  { cols: [1], rows: [4] },
];

/** `fr` sizes for a layout's columns and rows with card `active` open. */
function tracks(map: readonly Cell[], active: number, shape: [number, number], boost: [number, number], strength: number) {
  const cell = map[active] ?? map[0]!;
  const size = (count: number, spanned: readonly number[], by: number) =>
    Array.from({ length: count }, (_, i) => `${(1 + (spanned.includes(i) ? (by * strength) / spanned.length : 0)).toFixed(3)}fr`).join(" ");
  return { cols: size(shape[0], cell.cols, boost[0]), rows: size(shape[1], cell.rows, boost[1]) };
}

/** How long a pointer rests on a card before it opens, and how long after leaving the bento returns to the first. */
const INTENT_MS = 120;
const RETURN_MS = 900;

export function NicheMosaic({
  specialties,
  onOpen,
}: {
  specialties: readonly Specialty[];
  /** Take me to the agent. */
  onOpen: () => void;
}) {
  const tiles = specialties.filter((s) => NICHE_MEDIA[s.id]);
  const grid = useRef<HTMLUListElement>(null);
  const [active, setActive] = useState(0);
  /** A visitor has a card of their own open, not the default. */
  const [engaged, setEngaged] = useState(false);
  /** Near the screen: an open card may now fetch and play its footage. */
  const [live, setLive] = useState(false);
  const rest = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const intent = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /**
   * The last press: whether it was a finger, and whether its card was already
   * the open one when it landed. Read at pointer-down, because focus follows
   * straight after and opens the card before the click arrives.
   */
  const press = useRef({ touch: false, wasOpen: true });

  useEffect(() => {
    const el = grid.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      // Nothing to wait for: play from the start.
      const id = window.setTimeout(() => setLive(true), 0);
      return () => window.clearTimeout(id);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setLive(true);
          observer.disconnect();
        }
      },
      { rootMargin: "160px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(
    () => () => {
      clearTimeout(rest.current);
      clearTimeout(intent.current);
    },
    [],
  );

  const open = useCallback((index: number) => {
    clearTimeout(rest.current);
    setActive(index);
    setEngaged(true);
  }, []);

  /** Back to the first card, a moment after the pointer and focus have both left. */
  const settle = useCallback(() => {
    clearTimeout(intent.current);
    clearTimeout(rest.current);
    rest.current = setTimeout(() => {
      setActive(0);
      setEngaged(false);
    }, RETURN_MS);
  }, []);

  const strength = engaged ? 1 : 0.5;
  const four = tracks(FOUR, active, [4, 3], [0.9, 0.9], strength);
  const two = tracks(TWO, active, [2, 5], [0.5, 0.9], strength);
  const style = {
    ["--lg-cols" as string]: four.cols,
    ["--lg-rows" as string]: four.rows,
    ["--sm-cols" as string]: two.cols,
    ["--sm-rows" as string]: two.rows,
  } as CSSProperties;

  return (
    <ul
      ref={grid}
      className="bento"
      style={style}
      aria-label="Specialties we cover"
      onPointerEnter={() => clearTimeout(rest.current)}
      onPointerLeave={(event) => {
        if (event.pointerType !== "touch") settle();
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) settle();
      }}
    >
      {tiles.map((s, i) => (
        <li
          key={s.id}
          onPointerDown={(event) => {
            press.current = { touch: event.pointerType === "touch", wasOpen: active === i };
          }}
          onKeyDown={() => {
            press.current = { touch: false, wasOpen: true };
          }}
          onPointerEnter={(event) => {
            if (event.pointerType === "touch") return;
            const li = event.currentTarget;
            clearTimeout(intent.current);
            intent.current = setTimeout(() => {
              if (li.matches(":hover")) open(i);
            }, INTENT_MS);
          }}
          onPointerLeave={() => clearTimeout(intent.current)}
          onFocus={() => open(i)}
          onClickCapture={(event) => {
            // On a touch screen the first tap opens the card; the second goes on.
            const { touch, wasOpen } = press.current;
            press.current = { touch: false, wasOpen: true };
            if (touch && !wasOpen) {
              event.preventDefault();
              event.stopPropagation();
              open(i);
            }
          }}
        >
          <CircleExpandCard
            title={s.name}
            body={s.hook}
            still={NICHE_MEDIA[s.id]!.still}
            placeholder={NICHE_MEDIA[s.id]!.blur}
            video={NICHE_MEDIA[s.id]!.video}
            onActivate={onOpen}
            compact
            expanded={active === i}
            live={live}
            floodScale={36}
          />
        </li>
      ))}
    </ul>
  );
}
