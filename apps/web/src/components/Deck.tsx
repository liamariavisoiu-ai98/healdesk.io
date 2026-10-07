"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, useReducedMotion, type PanInfo } from "motion/react";

import { CircleExpandCard } from "@/components/CircleExpandCard";

/**
 * A 3D deck of portrait cards, one in front at full size, its neighbours
 * receding behind it with scale, opacity and a little rotation, moved by
 * drag, keys, the dots, or a click on a card behind.
 *
 * Modelled on the Framer community component `VerticaImageStackCarousel`
 * (framer.com/m/VerticaImageStackCarousel-VRXTDF.js), reimplemented because
 * it pulls `framer`'s `addPropertyControls` and `framer-motion`, neither of
 * which exists here.
 *
 * It was the specialties deck (NicheStack) until 29 September 2026, when the
 * outcomes section needed the same object with different cards. The deck
 * takes items now and NicheStack maps specialties onto it, so the two
 * sections share one motion vocabulary by construction: the same spring, the
 * same ladder, the same dots and arrowheads, the same flood on the front card.
 *
 * ## Two deliberate departures from the original
 *
 * The original is vertical only. This one recedes along X on desktop and along
 * Y on phones, because a horizontal deck on a 380px screen leaves each card
 * about a thumb wide.
 *
 * The original also advances on wheel events. That is dropped. It listens
 * passively and does not preventDefault, so the page scrolls AND the deck
 * turns, which on a marketing page means the section deals itself while you
 * are trying to get past it. Drag, arrow keys, the dots and clicking a card
 * behind the front one all move it, and none of them fight the scrollbar.
 *
 * ## Controlled or not
 *
 * `index` and `onIndexChange` are optional. Left out, the deck owns its
 * position. Supplied, the parent owns it, which is how the outcomes ledger
 * brings a card forward when a line is hovered, and how a step on the deck
 * moves the highlight on the ledger: one number, two views of it.
 */

export type DeckItem = {
  id: string;
  /** The line on the floor of the front card. */
  title: string;
  /** Opens under the title on hover. */
  body: string;
  /** Poster frame, 720x990, the same crop as the video's first frame. */
  still: string;
  /** Sources without extensions, `.webm` and `.mp4` are both offered. */
  video?: string;
};

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
function DeckArrow({ back, label, onClick }: { back?: boolean; label: string; onClick: () => void }) {
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

export function Deck({
  items,
  label,
  noun,
  onOpen,
  index: controlled,
  onIndexChange,
  spread = "wide",
}: {
  items: readonly DeckItem[];
  /** What the carousel is, for assistive tech: "Specialties we cover". */
  label: string;
  /** One item, for the arrow labels: "specialty", "outcome". */
  noun: string;
  /** The front card's click. Take me to the agent. */
  onOpen: () => void;
  /** Supplied by a parent that owns the position; omitted, the deck owns it. */
  index?: number;
  onIndexChange?: (index: number) => void;
  /**
   * How far the receding cards fan out on a desktop.
   *
   * `wide` is the specialties deck, centred in a full-width row with room on
   * both sides. `tight` is for a deck that shares its row with something,
   * the outcomes ledger: the fan stays within about 620px so the cards behind
   * never run under the column beside them. Phones always stack vertically
   * and ignore this.
   */
  spread?: "wide" | "tight";
}) {
  const [inner, setInner] = useState(0);
  const index = controlled ?? inner;
  const setIndex = useCallback(
    (next: number) => {
      setInner(next);
      onIndexChange?.(next);
    },
    [onIndexChange],
  );

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

  // A controlled index that changes from outside (the ledger) is a move too,
  // and the front card must wait for it to land before it goes live. It is
  // caught while rendering, against the last index kept in state, rather than
  // in an effect: an effect runs after the commit, so the incoming card went
  // live for one render before being taken back.
  const [lastIndex, setLastIndex] = useState(index);
  if (lastIndex !== index) {
    setLastIndex(index);
    if (!reduce) setSettled(false);
  }

  /**
   * Orientation, read in an effect rather than during render.
   *
   * matchMedia does not exist on the server, so deciding this while rendering
   * contradicts the server's markup on nodes React will not repair. Defaulting
   * to the vertical layout means the pre-hydration paint is the mobile one,
   * which is the safer of the two to be briefly wrong about.
   */
  const [horizontal, setHorizontal] = useState(false);
  // A second threshold for the wide fan: between 768 and 1023px the cards
  // recede sideways but the 333px-a-side spread of the specialties deck runs
  // past the viewport and gives the page a horizontal scrollbar, so tablets
  // get the tight fan whatever the caller asked for.
  const [roomy, setRoomy] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const wide = window.matchMedia("(min-width: 1024px)");
    const sync = () => {
      setHorizontal(mq.matches);
      setRoomy(wide.matches);
    };
    sync();
    mq.addEventListener("change", sync);
    wide.addEventListener("change", sync);
    return () => {
      mq.removeEventListener("change", sync);
      wide.removeEventListener("change", sync);
    };
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
      setIndex((index + delta + count) % count);
    },
    [count, index, reduce, setIndex],
  );

  const onDragEnd = useCallback(
    (_: unknown, info: PanInfo) => {
      // Always the horizontal offset, even where the cards stack vertically.
      // Dragging on the Y axis made motion write `touch-action: pan-x` on the
      // element, which handed every vertical touch to the drag gesture: on a
      // phone the page could not be scrolled by swiping over the deck. A
      // sideways swipe is the carousel gesture anyway, and with drag on X the
      // browser keeps vertical scrolling for itself.
      const travelled = info.offset.x;
      if (Math.abs(travelled) < DRAG_THRESHOLD) return;
      // Drag left to advance, which is the direction the next card arrives from.
      step(travelled < 0 ? 1 : -1);
    },
    [step],
  );

  if (count === 0) return null;

  const cardW = horizontal ? 340 : 280;
  const cardH = horizontal ? 470 : 390;
  const span = horizontal ? cardW : cardH;
  // Vertical gaps were 0.4 / 0.7 of the card, which put the second card back
  // 273px above the front one: straight through the section heading on every
  // phone. At 0.16 / 0.28 the cards behind peek out by a few dozen pixels,
  // which reads as a stack rather than a spread, and the wrapper below
  // reserves exactly that overflow so nothing above or below is covered.
  const tight = spread === "tight" || !roomy;
  const gaps = horizontal ? (tight ? [0, 0.26, 0.46] : [0, 0.56, 0.98]) : [0, 0.16, 0.28];
  // How far the farthest card actually pokes out past the front card's box:
  // its offset, less the half of its own size that scaling took off. Reserving
  // the raw offset put the dots 140px under the card on a phone for a stack
  // that overflows by 50.
  const farthest = LADDER[LADDER.length - 1]!;
  const reach = Math.max(0, gaps[gaps.length - 1]! * span - ((1 - farthest.scale) * span) / 2);

  return (
    <div
      role="group"
      aria-roledescription="carousel"
      aria-label={label}
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
        drag="x"
        dragConstraints={{ top: 0, bottom: 0, left: 0, right: 0 }}
        dragElastic={0.16}
        dragMomentum={false}
        onDragEnd={onDragEnd}
        style={{
          perspective: 1200,
          width: cardW,
          height: cardH,
          // The fan is drawn outside the box. Reserve it where it would
          // otherwise land on something: a vertical stack above the heading,
          // a tight horizontal fan in the column next to it. The wide fan
          // sits centred in a full-width row and reserving 333px a side there
          // would push it past the container on a tablet.
          marginBlock: horizontal ? 0 : reach,
          marginInline: horizontal && tight ? reach : 0,
        }}
        className="relative select-none"
      >
        {items.map((item, i) => {
          // Shortest way round, so the deck wraps instead of dead-ending.
          let diff = i - index;
          if (diff > count / 2) diff -= count;
          if (diff < -count / 2) diff += count;

          const depth = Math.min(Math.abs(diff), LADDER.length - 1);
          const rung = LADDER[depth]!;
          const beyond = Math.abs(diff) > 2;
          const sign = Math.sign(diff);
          const shift = sign * gaps[depth]! * span;
          const isFront = diff === 0;

          return (
            <motion.div
              key={item.id}
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
                  title={item.title}
                  body={item.body}
                  still={item.still}
                  video={item.video}
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
                  aria-label={`Show ${item.title}`}
                  className="absolute inset-0 overflow-hidden rounded-[24px]"
                >
                  <img
                    src={item.still}
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
          dots, the forward one leaning on a slow loop. */}
      <div className="mt-8 flex items-center gap-2">
        <DeckArrow back label={`Previous ${noun}`} onClick={() => step(-1)} />

        {items.map((item, i) => (
          <button
            key={item.id}
            type="button"
            onClick={() => step(i - index)}
            aria-label={item.title}
            aria-current={i === index}
            className={[
              "h-2 rounded-full transition-all duration-300",
              i === index ? "bg-red w-6" : "bg-line-strong hover:bg-muted w-2",
            ].join(" ")}
          />
        ))}

        <DeckArrow label={`Next ${noun}`} onClick={() => step(1)} />
      </div>
    </div>
  );
}
