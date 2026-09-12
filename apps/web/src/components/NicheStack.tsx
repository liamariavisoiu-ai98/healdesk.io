"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, useReducedMotion, type PanInfo } from "motion/react";

import { CircleExpandCard } from "@/components/CircleExpandCard";
import { NICHE_MEDIA } from "@/lib/niche-media";
import type { Specialty } from "@/lib/specialties";

/**
 * The specialties, as a 3D deck rather than a reel.
 *
 * Modelled on the Framer community component `VerticaImageStackCarousel`
 * (framer.com/m/VerticaImageStackCarousel-VRXTDF.js): one card in front at full
 * size, its neighbours receding behind it with scale, opacity and a little
 * rotation, moved by drag, keys or the dots. Reimplemented rather than imported
 * for the same reasons as the card itself. It pulls `framer`'s
 * `addPropertyControls` and `framer-motion`, neither of which exists here.
 *
 * ## Two deliberate departures
 *
 * The original is vertical only. This one recedes along X on desktop and along
 * Y on phones, because a horizontal deck on a 380px screen leaves each card
 * about a thumb wide.
 *
 * The original also advances on wheel events. That is dropped. It listens
 * passively and does not preventDefault, so the page scrolls AND the deck
 * turns, which on a marketing page means the section deals itself while you are
 * trying to get past it. Drag, arrow keys, the dots and clicking a card behind
 * the front one all move it, and none of them fight the scrollbar.
 */

/** Matches the original: spring 300/30/1. */
const SPRING = { type: "spring", stiffness: 300, damping: 30, mass: 1 } as const;

/** Milliseconds between accepted moves, so a flick does not deal three cards. */
const COOLDOWN_MS = 400;

/** Drag distance that counts as a move. */
const DRAG_THRESHOLD = 50;

type Placement = { offset: number; scale: number; opacity: number; rotate: number; z: number };

/** Depth ladder. Index is |diff| from the front card. */
const LADDER: Placement[] = [
  { offset: 0, scale: 1, opacity: 1, rotate: 0, z: 5 },
  { offset: 1, scale: 0.82, opacity: 0.6, rotate: 9, z: 4 },
  { offset: 2, scale: 0.7, opacity: 0.28, rotate: 16, z: 3 },
];

/** The reviews slider's arrowhead, same shape and same rules. */
function NicheArrow({
  back,
  label,
  onClick,
}: {
  back?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={[
        "text-red-deep hover:text-red -my-2 grid size-11 place-items-center transition-colors",
        back ? "mr-1.5" : "ml-1.5",
      ].join(" ")}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`size-[15px] ${back ? "review-nudge--back" : "review-nudge"}`}
      >
        <path d={back ? "m15 6-6 6 6 6" : "m9 6 6 6-6 6"} />
      </svg>
    </button>
  );
}

export function NicheStack({
  specialties,
  onOpen,
}: {
  specialties: readonly Specialty[];
  /** Take me to the agent. */
  onOpen: () => void;
}) {
  // Only niches whose artwork exists. A card with no image in a deck this
  // large reads as a loading failure, not as a placeholder.
  const items = specialties.filter((s) => NICHE_MEDIA[s.id]);

  const [index, setIndex] = useState(0);
  /**
   * False while the deck is springing a new card into place.
   *
   * A card becomes the front card the moment the index changes, but it is
   * still travelling. Without this the flood could be set off by a pointer the
   * card simply slid underneath, which reads as the card reacting to nothing.
   * Starts true because the first render animates nothing.
   */
  const [settled, setSettled] = useState(true);
  const lastMove = useRef(0);
  const reduce = useReducedMotion() ?? false;

  /**
   * Orientation, read in an effect rather than during render.
   *
   * matchMedia does not exist on the server, so deciding this while rendering
   * contradicts the server's markup on nodes React will not repair, the same
   * trap HeroStage documents at length. Defaulting to the vertical layout means
   * the pre-hydration paint is the mobile one, which is the safer of the two to
   * be briefly wrong about.
   */
  const [horizontal, setHorizontal] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const sync = () => setHorizontal(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const count = items.length;

  const step = useCallback(
    (delta: number) => {
      const now = Date.now();
      if (now - lastMove.current < COOLDOWN_MS) return;
      lastMove.current = now;
      // Reduced motion runs the move at zero duration. Never withhold the
      // hover there: if the completion callback did not fire for any reason,
      // the card would be permanently inert with no way back.
      if (!reduce) setSettled(false);
      setIndex((current) => (current + delta + count) % count);
    },
    [count, reduce],
  );

  const onDragEnd = useCallback(
    (_: unknown, info: PanInfo) => {
      const travelled = horizontal ? info.offset.x : info.offset.y;
      if (Math.abs(travelled) < DRAG_THRESHOLD) return;
      // Drag left / up to advance, which is the direction the next card
      // arrives from.
      step(travelled < 0 ? 1 : -1);
    },
    [horizontal, step],
  );

  if (count === 0) return null;

  const cardW = horizontal ? 340 : 280;
  const cardH = horizontal ? 470 : 390;
  const span = horizontal ? cardW : cardH;
  const gaps = horizontal ? [0, 0.56, 0.98] : [0, 0.4, 0.7];

  return (
    <div
      role="group"
      aria-roledescription="carousel"
      aria-label="Specialties we cover"
      onKeyDown={(event) => {
        const back = event.key === "ArrowLeft" || event.key === "ArrowUp";
        const fwd = event.key === "ArrowRight" || event.key === "ArrowDown";
        if (!back && !fwd) return;
        event.preventDefault();
        step(fwd ? 1 : -1);
      }}
      className="flex flex-col items-center"
    >
      <motion.div
        drag={horizontal ? "x" : "y"}
        dragConstraints={{ top: 0, bottom: 0, left: 0, right: 0 }}
        dragElastic={0.16}
        dragMomentum={false}
        onDragEnd={onDragEnd}
        style={{ perspective: 1200, width: cardW, height: cardH }}
        className="relative touch-pan-y select-none"
      >
        {items.map((specialty, i) => {
          // Shortest way round, so the deck wraps instead of dead-ending.
          let diff = i - index;
          if (diff > count / 2) diff -= count;
          if (diff < -count / 2) diff += count;

          const depth = Math.min(Math.abs(diff), LADDER.length - 1);
          const rung = LADDER[depth]!;
          const beyond = Math.abs(diff) > 2;
          const sign = Math.sign(diff);
          const shift = sign * gaps[depth]! * span;
          const media = NICHE_MEDIA[specialty.id]!;
          const isFront = diff === 0;

          return (
            <motion.div
              key={specialty.id}
              // Cards behind the front one are inert to the pointer except for
              // the click that promotes them, and out of the tab order, the
              // front card is the only one whose copy is legible.
              aria-hidden={!isFront}
              animate={{
                x: horizontal ? shift : 0,
                y: horizontal ? 0 : shift,
                rotateY: horizontal ? -sign * rung.rotate : 0,
                rotateX: horizontal ? 0 : sign * rung.rotate,
                scale: rung.scale,
                opacity: beyond ? 0 : rung.opacity,
                zIndex: beyond ? 0 : rung.z,
              }}
              transition={reduce ? { duration: 0 } : SPRING}
              // Only the incoming front card reports, so one settle per move.
              onAnimationComplete={() => {
                if (isFront) setSettled(true);
              }}
              className="absolute inset-0"
              style={{ pointerEvents: beyond ? "none" : "auto" }}
            >
              {isFront ? (
                <CircleExpandCard
                  title={specialty.name}
                  body={specialty.expertise}
                  still={media.still}
                  video={media.video}
                  onActivate={onOpen}
                  active
                  interactive={settled}
                />
              ) : (
                // A card in the deck is a picture, not a control: promoting it
                // is the only thing it does, and it should not announce a
                // title a screen reader has already heard from the front card.
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => step(diff)}
                  aria-label={`Show ${specialty.name}`}
                  className="absolute inset-0 overflow-hidden rounded-[24px]"
                >
                  <img
                    src={media.still}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="size-full object-cover"
                  />
                  <span className="absolute inset-0 bg-ink/35" />
                </button>
              )}
            </motion.div>
          );
        })}
      </motion.div>

      {/* Same controls as the reviews slider: an arrowhead either side of the
          dots, the forward one leaning on a slow loop. The two round bordered
          step buttons that used to flank this row are gone, here and there, for
          the same reason: a deck that already shows where you are does not need
          a bordered button on each side of it as well. */}
      <div className="mt-8 flex items-center gap-2">
        <NicheArrow back label="Previous specialty" onClick={() => step(-1)} />

        {items.map((specialty, i) => (
          <button
            key={specialty.id}
            type="button"
            onClick={() => step(i - index)}
            aria-label={specialty.name}
            aria-current={i === index}
            className={[
              "h-2 rounded-full transition-all duration-300",
              i === index ? "bg-red w-6" : "bg-line-strong hover:bg-muted w-2",
            ].join(" ")}
          />
        ))}

        <NicheArrow label="Next specialty" onClick={() => step(1)} />
      </div>
    </div>
  );
}

