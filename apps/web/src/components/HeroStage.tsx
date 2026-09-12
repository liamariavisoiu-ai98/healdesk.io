"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  motion,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useTransform,
} from "motion/react";

import { HeroFrames } from "@/components/HeroFrames";
import { HeroModel } from "@/components/HeroModel";
import { HeroWordmark } from "@/components/HeroMark";
import { HeroVideo } from "@/components/HeroVideo";
import { HeroPortrait } from "@/components/HeroPortrait";
import { site } from "@/lib/site";
import type { TiltControl } from "@/lib/usePointerField";

/**
 * The banner, and its hand-off into the live demo.
 *
 * ## Structure, which is load-bearing
 *
 *     track   plain div, h-[130svh]   <- useScroll measures THIS
 *       stage sticky, h-[100svh]      <- no transform, no will-change
 *         motion.div                  <- the only thing that scales
 *
 * Three things about that are not stylistic. The scroll ref goes on the track,
 * because a sticky element's clientHeight is one viewport, not the scroll
 * range, and measuring it makes progress hit 1 almost immediately. The stage
 * carries no transform of its own, because transform (and will-change naming
 * it) creates a containing block that traps the sticky positioning it is trying
 * to do. And everything is sized in `svh`, because on iOS Safari `100vh` is the
 * address-bar-hidden height, so a 100vh stage hangs below the fold and jumps
 * when the bar retracts.
 *
 * Nothing here jacks the scroll. The page scrolls at native speed; only the
 * visuals are wired to progress.
 */

/** Where the portrait ends up: small enough to read as a hand-off, large enough
 *  that the compositor is only ever downscaling a texture it already has. */
const END_SCALE = 0.34;

/**
 * Deliberately not full height, see the note at the render site.
 *
 * Narrow viewports size by WIDTH instead, and that is not a nicety. Sizing a
 * landscape frame by height makes it wider than the phone: at `h-[72%]` of an
 * 844px viewport she is 608px tall, which at this grid's 1.256 aspect is 764px
 * wide inside a 390px stage, so a third of her is cropped away by the stage's
 * overflow-hidden. `w-full h-auto` fits the whole frame instead. She lands
 * smaller, but entire, which is the point of a portrait that floats on the page
 * rather than bleeding off it.
 */
const PORTRAIT_SIZE = "w-full h-auto sm:h-[80%] sm:w-auto";

/**
 * Track and stage heights, in svh.
 *
 * These MUST match the `h-[130svh]` and `h-[100svh]` literals below. Tailwind
 * needs a literal class name to compile, so the numbers cannot be interpolated
 * into the className, but the wordmark hand-off has to know where the stage
 * stops being sticky, and computing that from a hard-coded 0.23 would silently
 * break the moment someone edited the track height. Change these together.
 */
const TRACK_SVH = 130;
const STAGE_SVH = 100;

/**
 * Scroll progress at which the sticky stage detaches and starts moving up with
 * the track. The wordmark must have finished converging on the navbar BEFORE
 * this: past it, the nav anchor the mark is aiming at is sliding away, so a
 * hand-off that completed later would land tens of pixels above the bar.
 */
const STICKY_END = (TRACK_SVH - STAGE_SVH) / TRACK_SVH;
const MARK_HANDOFF = STICKY_END * 0.87;

/**
 * Phones would take the flat layout instead of the scroll-shrink. OFF, and it
 * is off now because it is UNNECESSARY, not because it is too risky.
 *
 * It was added for exactly one problem, and that problem has since been fixed a
 * layer down, in the assets. Variant b's frames used to be the clip's native
 * 16:9 (1280x720) inside a rig sized for a tall figure, and because the portrait
 * is sized by height, only the middle ~36% of every frame survived on a 390px
 * phone: `h-[72%]` of an 844px viewport is 608px tall, which at 16:9 is 1080px
 * wide inside a 390px stage. The shrink choreography then spent a whole extra
 * viewport of scroll to reveal a slightly tighter crop of the same close-up.
 * public/hero-frames-2/frames.json is now 405x720, so that same element is
 * 608px tall and ~342px wide: it fits whole, with paper either side and nothing
 * cropped at all. There is no crop left for the flat layout to spare anyone. The
 * layered renderer never had the problem. HeroPortrait's source is 3:4
 * (1086x1448, see public/hero/hero.json), which keeps ~86% of its frame on that
 * same phone.
 *
 * What anyone reaching for this later still has to know: the flag is
 * RENDERER-BLIND. HeroStage cannot tell which renderer it is hosting, so turning
 * it on removes the sticky shrink from route `/` as well, the production hero,
 * which has no crop to be spared from. So the flat layout stays available and
 * correct, but off, unless someone decides deliberately that mobile should lose
 * the shrink everywhere. `flat` is not dead either way: reduced motion takes the
 * same path, and the transform-pinning it drives is what makes that case static.
 */
const FLATTEN_ON_NARROW = false;

export function HeroStage() {
  const trackRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const prefersReduce = useReducedMotion() ?? false;
  const [tilt, setTilt] = useState<TiltControl | null>(null);

  const { scrollYProgress } = useScroll({
    target: trackRef,
    offset: ["start start", "end start"],
  });

  const willChange = useMotionValue<"auto" | "transform">("auto");

  // useScroll's first measurement lands a frame after mount, so a reload that
  // restores a mid-page scroll position would paint one frame at progress 0,
  // the full-size portrait flashing over content it has already scrolled past.
  // Reveal on the next frame, by which time that measurement has happened.
  //
  // Deliberately NOT gated on a "change" event: at the top of the page progress
  // is 0 and never changes, so the hero would stay hidden forever.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // useReducedMotion() returns null on the server but the REAL preference on
  // the client's very first render, so branching markup on it directly hydrates
  // mismatched className and style, and React does not repair either on a
  // plain DOM node, so the stage would keep the server's visibility:hidden
  // forever and reduced-motion visitors would see two viewports of blank paper.
  // Applying it only from the second render is the frame the reveal already
  // waits for, so React sees a genuine prop change and writes the correction.
  const reduce = ready && prefersReduce;

  // 639px is the last pixel below Tailwind's `sm`, which is the breakpoint
  // PORTRAIT_SIZE itself switches on, so the layout decision and the sizing agree
  // about what counts as narrow. Read in an effect and held in state rather than
  // during render, for exactly the reason spelled out above `reduce`: matchMedia
  // does not exist on the server, so deciding the layout during the first client
  // render contradicts the server's markup on a node React will not repair, and
  // the stage keeps its visibility:hidden forever, two viewports of blank paper
  // on every phone. Subscribing to `change` is what makes a rotation or a
  // resized window re-pick the layout instead of being stuck with whichever one
  // the first paint happened to measure.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // Layout AND the pin for every scroll transform below, because a flattened
  // stage is not static by itself. Flattening drops the track's `h-[130svh]`,
  // but the in-flow child it leaves behind is `relative h-[70svh]`, so the
  // track is still ~70svh tall, and useScroll measures the TARGET, so progress
  // still sweeps a full 0 -> 1 across those 70svh. Transforms left branching on
  // `reduce` would therefore replay the entire shrink-and-fade inside the
  // shorter box: ~24svh of scroll puts progress at 0.34, which is copyFade at 0
  // (headline hidden while its block is still mid-screen) with the portrait
  // mid-shrink at scale ~0.78, lifted off the bottom edge it was `items-end`
  // against, and figureFade starting to remove her altogether ~43svh in, with
  // ~27svh of the 70svh stage still on screen. That is exactly the
  // choreography flattening exists to suppress, so the transforms below pin
  // themselves on `flat` explicitly rather than trusting a short track to
  // produce no progress.
  const flat = reduce || (ready && narrow && FLATTEN_ON_NARROW);

  // Promote only while it is actually moving. A full-viewport promoted layer
  // costs w x h x 4 x DPR^2 bytes of GPU memory; leaving it on for the life of
  // the page is how a hero quietly eats 20MB.
  //
  // `flat` has to be in the test for the same reason the transforms below pin
  // themselves on it: a flattened track still sweeps progress 0 -> 1, so without
  // this a reduced-motion visitor pays for a promoted layer over an element
  // whose scale and y are both pinned to their identity.
  useMotionValueEvent(scrollYProgress, "change", (p) => {
    willChange.set(!flat && p > 0.001 && p < 0.995 ? "transform" : "auto");
  });
  // The subscriber only runs on a scroll change, so a flip to flat while the
  // page is still would otherwise leave the last "transform" it wrote standing.
  useEffect(() => {
    if (flat) willChange.set("auto");
  }, [flat, willChange]);

  // Reduced motion neutralises the OUTPUT, never the hook, the globals.css
  // prefers-reduced-motion block only touches CSS animation and transition
  // durations, and motion drives these values from JS, so it sails straight
  // past that rule.
  //
  // These are FUNCTION transforms, not the (value, inputRange, outputRange)
  // form, and that is load-bearing. motion 13 accelerates the range form onto a
  // native ViewTimeline by turning the input range into WAAPI keyframe offsets.
  // For a full [0, 1] range that is equivalent, but for a sub-range like
  // [0, 0.34] the offsets are measured against the browser's timeline instead
  // of this scroll target, so the element plays a different curve from the one
  // the MotionValue reports, the headline sat at full opacity while its own
  // value read 0. A function transform cannot be expressed as keyframes, so it
  // stays on the JS path and the DOM matches the value.
  const ramp = (p: number, from: number, to: number) =>
    p <= from ? 0 : p >= to ? 1 : (p - from) / (to - from);

  const scale = useTransform(scrollYProgress, (p) => (flat ? 1 : 1 + p * (END_SCALE - 1)));
  // Only a slight lift: pulling her too far up leaves a growing well of
  // empty white beneath her as she shrinks.
  const lift = useTransform(scrollYProgress, (p) => (flat ? "0%" : `${p * -7}%`));
  const figureFade = useTransform(scrollYProgress, (p) =>
    flat ? 1 : 1 - ramp(p, 0.62, 0.95),
  );
  const copyFade = useTransform(scrollYProgress, (p) => (flat ? 1 : 1 - ramp(p, 0.05, 0.34)));

  // As she shrinks toward the demo she looks DOWN, at the content she is handing
  // the visitor off to. Without it the shrink is just an animation that happens
  // to her; with it the shrink is a hand-off she performs, and her attention
  // arrives at the demo slightly before the visitor does. 0.55 is sized to be
  // about half a row on a three-row grid, which the blend's sharpening would
  // then carry most of the way onto the row beneath, a glance, not a stare at
  // her own feet.
  //
  // How far it can actually carry her depends on the grid, so temper the
  // expectation before looking for it in a browser. HeroFrames resolves aim 0 to
  // the cell the manifest names in `rest`, and variant b's rest row is row 2 of
  // 3, the BOTTOM one, because row 2 is the only row in that clip where she is
  // level with the lens; rows 0 and 1 are all looking up. So there is no row
  // beneath level to travel onto: the bias cannot take her past meeting the
  // viewer. What it still does, and what the glance amounts to today, is walk
  // her back DOWN to level from wherever she was looking up, which is most of
  // the time, since the cursor sits on the headline or the nav while you start
  // scrolling. On variant a, a single row, the vertical index is identically 0
  // and nothing moves it at all. A clip that genuinely looks down would extend
  // this past level with no change here, which is why the bias stays.
  //
  // A function transform for the same reason as the rest: the range form would be
  // accelerated onto a ViewTimeline and her gaze would drift out of step with
  // the scale it is supposed to accompany.
  const gazeBiasY = useTransform(scrollYProgress, (p) => (flat ? 0 : ramp(p, 0.1, 0.7) * 0.55));

  // copyFade reaches 0 at progress 0.34 while the stage is still sticky, so the
  // headline block would otherwise stay a live click target and a live tab stop
  // floating over the content that has scrolled into its place, the "Tilt your
  // phone to look around" button stays focusable and clickable at opacity 0.
  // visibility:hidden removes it from hit-testing, from the accessibility tree
  // and from the tab order in one property, where pointer-events would have
  // needed tabIndex wrangling beside it to cover the keyboard case. An epsilon
  // rather than === 0 because the fade is floating-point arithmetic on a scroll
  // ratio, and a block left clickable because the value settled at 1e-9 is a bug
  // nobody can reproduce on purpose.
  const [copyFaded, setCopyFaded] = useState(false);
  useMotionValueEvent(copyFade, "change", (v) => setCopyFaded(v < 0.001));

  const onTilt = useCallback((t: TiltControl) => setTilt(t), []);

  // Renderers over one rig, selected at runtime rather than swapped in the
  // source so they can be compared against each other on the same page.
  //
  // `model` is the default and the others are now history kept reachable:
  // ?hero=layers for the 2.5D sprite stack, ?hero=frames/frames2 for the
  // photographed grids, ?hero=video/video2 for the scrubbed clips. All four of
  // those answer "which way is she looking?" by picking from something baked,
  // and all four are bounded by what was baked, HeroFrames' own header spells
  // out why its grid cannot be made denser without a longer clip than the five
  // seconds that exist. The mesh has no cells to run out of.
  const [renderer, setRenderer] = useState<
    "model" | "layers" | "frames" | "frames2" | "video" | "video2"
  >("model");
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("hero");
    if (
      q === "layers" ||
      q === "frames" ||
      q === "frames2" ||
      q === "video" ||
      q === "video2"
    )
      setRenderer(q);
  }, []);

  return (
    <div
      id="top"
      ref={trackRef}
      // The page's own paper. Every hero asset is keyed and feathered to this
      // EXACT colour by its build script, so there is no edge between her and
      // the page at all, a portrait keyed to one white sitting on another
      // reads as pasted on however well the cutout is done, because the
      // giveaway is a flat tonal offset and no amount of feathering hides one.
      //
      // Which makes `--color-paper` in globals.css a cross-cutting constant, not
      // a colour choice: changing it silently un-mattes every hero, and they
      // have to be rebuilt with the new value passed as `--bg`. It has already
      // happened once, the palette moved to #fdfdfd and the grids, still baked
      // to the old warm #FBF4EA, went back to reading as rectangles floating on
      // the page. hero-frames-2 is rebuilt; `public/hero-frames/` (variant a)
      // is still on the old colour and still shows it.
      className={`relative bg-paper ${flat ? "" : "h-[130svh]"}`}
    >
      <div
        ref={stageRef}
        className={[
          // z-10 keeps it under the z-50 Nav. pointer-events-none so the stage
          // never swallows clicks meant for the content scrolling underneath.
          "pointer-events-none z-10 flex items-center justify-center overflow-hidden",
          flat ? "relative h-[70svh]" : "sticky top-0 h-[100svh]",
        ].join(" ")}
        style={{ visibility: ready || flat ? "visible" : "hidden" }}
      >
        {/* First child, so painting order puts it under the portrait and under
            the scrim, the same positioned-sibling argument the scrim comment
            below makes, run the other way. It sits above the paper for free:
            bg-paper is a background-color on the track, and an ancestor's
            background always paints below every descendant. */}
        <HeroWordmark
          scrollYProgress={scrollYProgress}
          stageRef={stageRef}
          flat={flat}
          handoffAt={MARK_HANDOFF}
        />

        {/* One transformed wrapper for everything. Promoting each of the five
            image layers separately would multiply the texture cost for no gain
            static children inherit a parent transform for free. */}
        <motion.div
          className="relative h-full w-full"
          style={{ scale, y: lift, willChange, transformOrigin: "50% 42%" }}
        >
          {/* Off-centre and well under full height. Two reasons, both of them
              things the full-bleed version got wrong: a near-lifesize face
              holding eye contact is confrontational rather than welcoming, and
              filling 100svh forced the browser to upscale past the source
              resolution, which is most of why it looked soft. At this size the
              portrait renders at or below native. */}
          <motion.div
            className="absolute inset-0 flex items-end justify-center sm:justify-end sm:pr-[6vw] lg:pr-[10vw]"
            style={{ opacity: figureFade }}
          >
            {/* Sized by height at every breakpoint, so anything that does not
                fit is lost from the sides rather than off the top. The supplied
                layers end square at the top of the canvas, and any fit that puts
                the whole image on screen shows that as a straight edge across her
                hair. What height-sizing costs depends on the source: the 3:4
                layers give up a sliver of width on a 390px phone, and both frame
                grids are 9:16, so they give up nothing and sit whole in the stage
                with paper either side. It was variant b's old 16:9 crop that made
                this a tight close-up on a narrow phone, and that is gone. */}
            {renderer === "model" ? (
              <HeroModel
                className={PORTRAIT_SIZE}
                onTiltAvailable={onTilt}
                gazeBiasY={gazeBiasY}
              />
            ) : renderer === "video" || renderer === "video2" ? (
              <HeroVideo
                className={PORTRAIT_SIZE}
                variant={renderer === "video2" ? "b" : "a"}
                onTiltAvailable={onTilt}
              />
            ) : renderer === "frames" || renderer === "frames2" ? (
              <HeroFrames
                className={PORTRAIT_SIZE}
                variant={renderer === "frames2" ? "b" : "a"}
                onTiltAvailable={onTilt}
                gazeBiasY={gazeBiasY}
              />
            ) : (
              <HeroPortrait className={PORTRAIT_SIZE} onTiltAvailable={onTilt} />
            )}
          </motion.div>
        </motion.div>

        {/* Copy sits outside the scaling wrapper so the type never scales, a
            scaled headline is the giveaway that a hero is one big image. The
            scrim is a SIBLING painted after the portrait rather than a -z-10
            child of the copy: negative z would put it behind the portrait at
            progress 0, which is the one state every visitor sees, leaving the
            tagline sitting directly on her hair. */}
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-[30%] bg-gradient-to-t from-paper via-paper/75 to-transparent"
          style={{ opacity: copyFade }}
        />
        <motion.div
          className="pointer-events-auto absolute inset-x-0 bottom-0 mx-auto max-w-[1240px] px-5 pb-[clamp(28px,6vh,72px)] sm:px-8 sm:pr-[42%] lg:px-14 lg:pr-[46%]"
          style={{
            opacity: copyFade,
            // Left undefined rather than set to "visible" when it is on screen:
            // the stage above is visibility:hidden until `ready`, and an explicit
            // "visible" on a descendant beats that, flashing the headline during
            // the exact frame the reveal exists to skip. The guard tests `flat`,
            // not `reduce`, because `flat` is what pins copyFade at 1: a
            // flattened stage still produces a full 0 -> 1 progress sweep over
            // its ~70svh, so a `reduce`-only guard would hide the headline a
            // quarter of a viewport into the scroll, mid-screen, on exactly the
            // phones flattening was meant to spare.
            visibility: copyFaded && !flat ? "hidden" : undefined,
          }}
        >
          <h1 className="font-display max-w-[16ch] text-[clamp(45.6px,7.68vw,98.4px)] leading-[1.0] font-medium tracking-[-0.028em]">
            {site.tagline}
          </h1>
          <p className="text-muted mt-5 text-[clamp(18px,1.8vw,21.6px)] font-medium">
            {site.subtitle}
          </p>

          {/* Tilt is opt-in, never the mobile default: it needs a permission
              modal that cannot be re-shown after a refusal, and it is exactly
              the motion that prefers-reduced-motion exists to suppress. Touch
              and pointer already work with no prompt at all. */}
          {tilt?.supported && tilt.needsPermission && !tilt.granted && !tilt.denied && !reduce ? (
            <button
              type="button"
              onClick={tilt.request}
              className="border-line-strong text-muted hover:border-ink hover:text-ink mt-6 inline-flex items-center gap-2 rounded-full border px-4 py-2 text-[15.6px] font-semibold transition-colors"
            >
              Tilt your phone to look around
            </button>
          ) : null}
        </motion.div>
      </div>
    </div>
  );
}
