"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import {
  motion,
  useMotionValue,
  useMotionValueEvent,
  useTransform,
  type MotionValue,
} from "motion/react";

import { WordmarkGlyphs } from "@/components/Wordmark";

/**
 * The giant healdesk.io behind AVA, and its hand-off into the navbar logo.
 *
 * ## Two marks, not one travelling mark
 *
 * The obvious implementation, one element that flies from the hero into the
 * nav, cannot be built here, and the reason is worth writing down because it
 * looks like it should work.
 *
 * A travelling mark has to end up inside the Nav's flex row, which means
 * `position: fixed` or a portal. Fixed is poisoned twice over. The hero's
 * scaling wrapper is a transformed ancestor, so a fixed descendant is contained
 * BY it rather than by the viewport, and worse, HeroStage flips `willChange`
 * to "transform" at p > 0.001, so that containing block appears and disappears
 * mid-scroll and anything fixed inside it jumps. Meanwhile the Nav's own
 * `backdrop-blur-md` is also a containing block, so a fixed mark cannot escape
 * INTO the nav either. Both ends are closed.
 *
 * So: two marks that hand off. What makes the seam invisible is that neither
 * one is ever resized. The hero mark is the SAME glyphs at the SAME
 * `text-[33.6px]`, `font-display`, `tracking-[-0.02em]` and em-relative `.io` as
 * the nav logo, and it gets its size purely from `scale`. The end scale is
 * therefore exactly 1.0 by construction at every viewport, with nothing
 * measured about the moving element, and at the crossover frame the two marks
 * are geometrically identical. A crossfade between congruent objects doesn't
 * read as a crossfade; it reads as one object resolving.
 *
 * ## The shared value is a size, not a progress
 *
 * `markScale` is "how many times nav-size the hero mark currently is", so 1.0
 * means handed off. That choice is load-bearing: 1.0 is also the correct value
 * for SSR, for the first client frame, for /pricing and /contact where there is
 * no provider at all, for reduced motion, and for the flat phone layout. The
 * safe state costs no special-casing, and a value initialised to 0 would give
 * every non-homepage route a navbar with no logo.
 *
 * It also settles what "no longer visible behind AVA" means in code. Waiting
 * for real geometric occlusion is not implementable. It depends on the alpha
 * of a photographic cutout that parallaxes and breathes. Deriving the fade from
 * the mark's own SIZE gets what the brief actually wants: it is gone by the
 * time it has shrunk to nav size. That is viewport-independent and
 * self-correcting whatever the peak scale turns out to be.
 */

type HeroMarkCtx = {
  /** Hero wordmark size in nav-wordmark multiples. 1 = handed off. */
  markScale: MotionValue<number>;
  /** Nav attaches this so the stage can measure where to converge. */
  navMarkRef: React.RefObject<HTMLSpanElement | null>;
};

const Ctx = createContext<HeroMarkCtx | null>(null);

/** null outside the provider, which is what makes Brand render normally. */
export function useHeroMark(): HeroMarkCtx | null {
  return useContext(Ctx);
}

/**
 * Wrap ONLY <Nav> and <HeroStage>.
 *
 * The Footer imports the same Brand. If the provider reached it, the footer
 * wordmark would fade out along with the hero one.
 */
export function HeroMarkProvider({ children }: { children: React.ReactNode }) {
  // 1, not 0, see the note above.
  const markScale = useMotionValue(1);
  const navMarkRef = useRef<HTMLSpanElement | null>(null);
  const value = useMemo(() => ({ markScale, navMarkRef }), [markScale]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** 0 below `from`, 1 above `to`, linear between. Shared by both marks. */
export function ramp(p: number, from: number, to: number): number {
  return p <= from ? 0 : p >= to ? 1 : (p - from) / (to - from);
}

/**
 * The size window the hand-off happens in, in nav-multiples.
 *
 * Both marks read the SAME window from opposite directions, so they are
 * complementary by construction rather than by two constants agreeing.
 */
export const HANDOFF_FROM = 1.0;
export const HANDOFF_TO = 1.6;

/** useLayoutEffect warns when Next renders a client component on the server. */
const useIsoLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function HeroWordmark({
  scrollYProgress,
  stageRef,
  flat,
  handoffAt,
}: {
  scrollYProgress: MotionValue<number>;
  stageRef: React.RefObject<HTMLDivElement | null>;
  /** Phone / reduced-motion layout: a static watermark, no hand-off. */
  flat: boolean;
  /** Scroll progress at which the mark has fully converged on the nav. */
  handoffAt: number;
}) {
  const ctx = useContext(Ctx);
  const boxRef = useRef<HTMLDivElement>(null);

  // Measurements live in MotionValues rather than React state on purpose. A
  // function transform that closed over state would not re-evaluate on resize
  // until the next scroll event fired, so a resized window would keep a stale
  // peak until the visitor scrolled. As transform SOURCES they re-fire the
  // moment they change, and cost no re-render per resize tick.
  const peak = useMotionValue(1);
  const dx = useMotionValue(0);
  const dy = useMotionValue(0);

  const measure = useCallback(() => {
    const box = boxRef.current?.getBoundingClientRect();
    const nav = ctx?.navMarkRef.current?.getBoundingClientRect();
    const stage = stageRef.current?.getBoundingClientRect();
    if (!box || !nav || !stage || box.width < 1) return;

    // 92% of the stage, so the mark bleeds toward both edges without the
    // descenders of a 9x line clipping. Clamped: a very narrow viewport must
    // not produce a peak below 1, which would run the hand-off backwards.
    peak.set(Math.min(9, Math.max(1, (stage.width * 0.92) / box.width)));

    dx.set(nav.left + nav.width / 2 - (box.left + box.width / 2));
    // box.top - stage.top is the mark's offset INSIDE the stage. At hand-off
    // the stage is pinned at viewport 0, so that offset IS its viewport y.
    dy.set(nav.top + nav.height / 2 - (box.top - stage.top + box.height / 2));
  }, [ctx, dx, dy, peak, stageRef]);

  // Layout effect, not effect: this publishes the real scale before the browser
  // paints, so the nav logo does not flash on at 1.0 and immediately fade out.
  useIsoLayoutEffect(() => {
    measure();
    // Fraunces is display:swap, so the first measurement uses Georgia's
    // metrics. Without this the peak scale AND the convergence delta are both
    // computed from the fallback, and the mark lands off-target when the real
    // font arrives.
    void document.fonts?.ready.then(measure);

    const observer = new ResizeObserver(measure);
    observer.observe(document.documentElement);
    return () => observer.disconnect();
  }, [measure]);

  // Every value below is a FUNCTION transform. The (value, inputRange,
  // outputRange) form gets compiled onto a native ViewTimeline in motion 13,
  // and for a sub-range like [0, 0.2] the offsets are measured against the
  // browser's timeline rather than this scroll target, so the element plays a
  // different curve from the one its own MotionValue reports. HeroStage
  // documents the same trap; do not "simplify" these.

  const markScale = useTransform(
    [scrollYProgress, peak],
    (latest: number[]) => {
      const [p = 0, top = 1] = latest;
      if (flat) return top;
      // Geometric decay: a constant RELATIVE size change per unit of scroll,
      // which is how size is actually perceived across a ~6x range. Lands
      // exactly on 1 at handoffAt, whatever the peak turns out to be.
      return Math.pow(top, 1 - ramp(p, 0, handoffAt));
    },
  );

  const markX = useTransform([scrollYProgress, dx], (latest: number[]) => {
    const [p = 0, delta = 0] = latest;
    return flat ? 0 : delta * ramp(p, 0, handoffAt);
  });

  const markY = useTransform([scrollYProgress, dy], (latest: number[]) => {
    const [p = 0, delta = 0] = latest;
    return flat ? 0 : delta * ramp(p, 0, handoffAt);
  });

  // Fade from SIZE, not progress: gone by the time it is nav-sized.
  const markOpacity = useTransform(markScale, (s) =>
    flat ? 0.1 : ramp(s, HANDOFF_FROM, HANDOFF_TO),
  );

  // Publish, so the nav can fade in as this fades out. `flat` publishes 1 while
  // its own mark sits at peak, publishing the watermark's real scale would
  // leave the nav logo invisible for the whole of every phone session.
  useMotionValueEvent(markScale, "change", (s) => {
    ctx?.markScale.set(flat ? 1 : s);
  });
  useEffect(() => {
    if (flat) ctx?.markScale.set(1);
  }, [flat, ctx]);
  // Leaving the homepage must restore the nav logo.
  useEffect(() => () => ctx?.markScale.set(1), [ctx]);

  return (
    <div
      ref={boxRef}
      // The untransformed probe. Its static translate is fine to measure
      // through; the inner span carries everything that moves. Deliberately
      // NOT a child of the scaling motion.div in HeroStage, in there it would
      // inherit that scale, the lift, the 50%/42% origin and the promotion.
      className="pointer-events-none absolute top-[46%] left-1/2 -translate-x-1/2 -translate-y-1/2 select-none"
      // aria-hidden and not an <a>: two elements announcing "healdesk.io home"
      // is a duplicate landmark link, and the nav one stays reachable.
      aria-hidden
    >
      <motion.span
        // inline-block so the transform applies; the image inside is what
        // actually has a size, and it is the same one the navbar renders.
        className="inline-block leading-none"
        style={{
          scale: markScale,
          x: markX,
          y: markY,
          opacity: markOpacity,
          transformOrigin: "50% 50%",
        }}
      >
        <WordmarkGlyphs />
      </motion.span>
    </div>
  );
}
