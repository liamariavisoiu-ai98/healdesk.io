"use client";

import { useEffect, useRef, useState } from "react";
import { useAnimationFrame, useInView, type MotionValue } from "motion/react";

import framesA from "../../public/hero-frames/frames.json";
import framesB from "../../public/hero-frames-2/frames.json";
import { useGazeRig } from "@/lib/useGazeRig";
import { usePointerField, type TiltControl } from "@/lib/usePointerField";

/**
 * The frame-mapping renderer: every gaze direction is a whole photograph.
 *
 * The layered renderer next door has to *synthesise* motion, translate an iris
 * over an inpainted socket, slide planes that each redraw content the others
 * carry, feather a lid sprite so it does not read as a box. Every defect in it
 * came from that synthesis. Here there is none: each cell of the grid is a
 * complete, correct image, so there are no mattes to cut, no planes to keep in
 * register and no seams that can open.
 *
 * ## It is a grid, and it is driven by the rig, not the cursor
 *
 * The obvious version of this maps cursor X straight to a frame index. That is
 * wrong twice over on a face that can move continuously: one axis cannot look
 * up as well as sideways, and mapping the cursor directly makes her head a
 * slave to absolute pointer position, zero latency, perfectly linear, moving
 * in lockstep with the mouse, which is the quality the rig exists to avoid.
 *
 * It is not wrong on a 5x3 grid, which is what this renders. There the rig's
 * delays have nothing continuous to hide behind and land as a photograph
 * changing some time after the hand stopped, and its autonomous motion, the
 * look-away, the blink, reads as the picture glitching rather than as life.
 * So which of the two this asks for is a decision, and it is `TRACKING` below.
 *
 * ## Why a canvas and not an <img>
 *
 * Frames are decoded up front and drawn with `drawImage`. Swapping `src` (or
 * `backgroundImage`) per pointer event costs a fetch and a decode the first
 * time each frame is touched, which lands as a stutter exactly when the user
 * starts interacting. Decoding all of them once and drawing from memory keeps
 * the frame cost flat.
 */

/** Each grid is built by bin-frames-by-gaze.py from its own clip. */
const SOURCES = {
  a: { meta: framesA, base: "/hero-frames/" },
  b: { meta: framesB, base: "/hero-frames-2/" },
} as const;

export type HeroFramesVariant = keyof typeof SOURCES;

/**
 * How this renderer is driven. A real trade, not a tuning preference.
 *
 * "lifelike" runs the full rig: a reaction delay, a damped follow, the head
 * trailing the eyes through a deadzone, a periodic look-away, and a blink over
 * each cell change to hide the cut. All of it is designed to stop her reading
 * as a cursor attachment, and all of it assumes a face that can move
 * CONTINUOUSLY. On a 5x3 grid it cannot. The delays land as "nothing, nothing,
 * nothing, then a different photograph"; the deadzone swallows the first 0.28
 * of every movement, so small motions do nothing and the eventual change
 * arrives with no gesture attached; and the look-aways and blinks move her when
 * the hand did not, which reads as the picture glitching rather than as life.
 *
 * "direct" gives that up. Gaze is the cursor, this frame, no filter, and the
 * autonomous motion is off, so nothing changes unless the hand moved. The blend
 * between neighbouring cells is left linear instead of sharpened, so travel
 * between two photographs is a continuous cross-fade rather than a snap, and
 * the drift is opened up so movement inside a cell still shows.
 *
 * What direct CANNOT do is invent gaze positions. Five columns is five
 * photographs; between two of them there is nothing but a cross-fade, and
 * cross-fading two different gazes double-exposes the pupils, which is exactly
 * what the sharpening it turns off was there to hide. Following the cursor
 * closely and not ghosting are in conflict at this density, and no constant
 * resolves it. A denser grid off a longer clip does.
 */
const TRACKING: "direct" | "lifelike" = "direct";

/** How far the whole picture drifts at full deflection, as a percent of its own
 *  box. Small on purpose: it exists to make the motion continuous between cell
 *  changes, not to be seen in its own right. */
const DRIFT_PCT =
  TRACKING === "direct" ? { x: 1.1, y: 0.6 } : { x: 0.9, y: 0.5 };

/** How far the whole picture rises on a full inhale, as a percent of its own
 *  box. With `idleMotion: false` nothing moves her between cursor moves but a
 *  blink and the occasional glance away, and a frozen photograph that blinks is
 *  more uncanny than one that never moves at all. A fifth of a percent cannot
 *  carry her across a grid cell, so it buys that without the "her head moved
 *  for no reason" failure that `idleMotion: false` exists to prevent. */
const BREATH_PCT = 0.22;


/** Sub-cell blend resolution. Finer than this and the canvas is re-blitted for
 *  changes nobody can see. Direct tracking wants the finer grain: the whole
 *  point is that a millimetre of hand movement shows, and at 24 steps a slow
 *  drag visibly ratchets. */
const BLEND_STEPS = TRACKING === "direct" ? 96 : 24;

/**
 * How hard to push the blend fraction toward 0 or 1.
 *
 * Cross-fading two photographs of different gaze is a double exposure, and at
 * 50/50 it shows: on a five-column grid the neighbours are far enough apart
 * that the blend renders two sets of pupils. Sharpening the fraction means most
 * cursor positions land on an almost-pure cell and the ambiguous middle is
 * crossed quickly, where it reads as motion blur rather than as a fault.
 *
 * Scaled to the grid, because the artefact is a function of how far apart
 * neighbouring cells look: a fine grid can afford a near-linear blend, a coarse
 * one cannot.
 */
const sharpenFor = (n: number) => (n >= 9 ? 1 : n >= 7 ? 2 : 3);
const sharpen = (t: number, k: number) => {
  let v = t;
  for (let i = 0; i < k; i++) v = v * v * (3 - 2 * v);
  return v;
};

/**
 * Rig output is [-1, 1]; the grid is [0, n-1]. Piecewise-linear through
 * (-1, 0), (0, rest), (1, n-1) rather than the one straight line it used to be,
 * because the grid's axes are the CLIP's observed range and not the world's.
 * The binner normalises gaze over whatever that clip happened to do, so the
 * geometric middle of the grid is "looking down the lens" only by accident.
 * On variant b it is not: rows 0 and 1 are both looking up, pupils high and
 * whites showing beneath, and row 2 is the only level row. Under the straight
 * line, aim (0, 0) landed on `f_1_2`, her looking up and to her right, and
 * that cell was first paint, the permanent reduced-motion still and the static
 * fallback <img>. The commonest thing a visitor saw was a receptionist looking
 * over their shoulder.
 *
 * The price is that the map is ASYMMETRIC wherever `rest` sits off centre: each
 * side of 0 gets the travel the clip actually contains on that side rather than
 * an equal share. On variant b that is one column of leftward travel against
 * three rightward, and no downward travel at all. Honest rather than even,
 * evening it up would mean inventing frames that were never filmed.
 *
 * When rest === (n - 1) / 2 this is ((v + 1) / 2) * (n - 1) for every v, so a
 * grid that names no rest cell renders exactly as it did before.
 */
const axis = (v: number, rest: number, n: number) =>
  n <= 1 ? 0 : v < 0 ? rest + v * rest : rest + v * (n - 1 - rest);

export function HeroFrames({
  className = "",
  variant = "a",
  onTiltAvailable,
  gazeBiasY,
}: {
  className?: string;
  variant?: HeroFramesVariant;
  onTiltAvailable?: (tilt: TiltControl) => void;
  /** Scroll-linked downward bias on the gaze, positive = down, in the same
   *  [-1, 1] units the rig emits. Owned by HeroStage, which ties it to scroll
   *  progress so she looks toward the content the hero hands off to. */
  gazeBiasY?: MotionValue<number>;
}) {
  const { meta, base: BASE } = SOURCES[variant];
  const { cols, rows, width, height } = meta;
  // Two manifest shapes. The original addresses a file per cell by name pattern,
  // which is fine while every cell has its own frame. A dense grid does not: the
  // clip's gaze path is a curve through 2-D space, so most of a 15x7 rectangle
  // is places she never looked, and their nearest frame is one an occupied cell
  // already claimed, 105 cells resolve to 42 distinct photographs. So the newer
  // shape ships each frame ONCE in `frames` and lets `cells` point at it, which
  // is the difference between 42 decoded bitmaps and 105 mostly-identical ones.
  const cells: number[][] | undefined = (meta as { cells?: number[][] }).cells;
  const fileList: string[] | undefined = (meta as { frames?: string[] }).frames;
  const pattern: string | undefined = (meta as { pattern?: string }).pattern;
  /** Which decoded image a grid cell shows. */
  const slotOf = (row: number, col: number) => (cells ? cells[row]![col]! : row * cols + col);
  const slotCount = fileList ? fileList.length : rows * cols;
  const BLINKS: number = (meta as { blinks?: number }).blinks ?? 0;
  // Which cell has her looking at the lens, picked by eye off a contact sheet
  // and carried in the grid's own metadata, because only the clip knows. The
  // default is the geometric centre as a possibly-fractional index rather than
  // a rounded one, and that is load-bearing: it is what makes `axis` collapse
  // to the old straight-line map on any grid with no `rest` field. Variant a
  // has none and has to come out bit-identical.
  //
  // Clamped on read because the field is hand-authored: docs/hero-frames.md
  // tells a person to pick the cell by eye off a contact sheet, and a 1-based
  // off-by-one there would otherwise name a frame that does not exist, the
  // preload would 404 twice, `ready` would never flip, and the <img> beneath
  // the canvas would request the same missing file, leaving an empty box that
  // still announces itself as a portrait. A bad manifest should degrade to the
  // wrong cell, not to no hero.
  const rest = (meta as { rest?: { row: number; col: number } }).rest;
  const clampIdx = (v: number, n: number) => (n <= 1 ? 0 : Math.max(0, Math.min(n - 1, v)));
  const restRow = clampIdx(rest?.row ?? (rows - 1) / 2, rows);
  const restCol = clampIdx(rest?.col ?? (cols - 1) / 2, cols);
  const frameSrc = (row: number, col: number) =>
    fileList
      ? BASE + fileList[slotOf(row, col)]!
      : BASE + pattern!.replace("{row}", String(row)).replace("{col}", String(col));
  /** By slot rather than by cell, for the preload, a shared frame loads once. */
  const slotSrc = (slot: number) =>
    fileList
      ? BASE + fileList[slot]!
      : BASE +
        pattern!
          .replace("{row}", String(Math.floor(slot / cols)))
          .replace("{col}", String(slot % cols));
  // The rest cell as a real frame index. Hoisted because three things have to
  // name the same frame, first paint, the reduced-motion still and the <img>
  // under the canvas, and computing it in three places is how they drift
  // apart. Rounded, so that a fractional default still resolves to a cell that
  // exists on an even-sided grid.
  const restRowIdx = Math.round(restRow);
  const restColIdx = Math.round(restCol);
  const restIndex = slotOf(restRowIdx, restColIdx);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inView = useInView(stageRef, { margin: "150px" });
  const field = usePointerField(stageRef);
  // gazeBreak is derived from the assets, not hardcoded: the look-away is a cut
  // between two whole photographs of her head, so it is only affordable where
  // there are blink frames to draw over both ends of it. Variant b ships five;
  // variant a ships none, and there the break played as an uncovered swap to a
  // different photograph and back, for about a second, with no cursor motion to
  // explain it. Same rule HeroVideo states for itself, expressed as a number the
  // grid already carries.
  const { gazeX, gazeY, headX, headY, blink, breath } = useGazeRig(field, inView, {
    idleMotion: false,
    follow: TRACKING === "direct" ? "direct" : "smooth",
    gazeBreak: TRACKING === "lifelike" && BLINKS > 0,
  });

  const images = useRef<(HTMLImageElement | null)[]>([]);
  // Blink frames harvested from the same clip as the grid, ordered open ->
  // shut. Kept separate because blinking cannot share the gaze axis: if a cell
  // is indexed by where she is looking there is no dimension left for eyelids,
  // and a full blink x gaze grid is combinatorial. Drawing them over whatever
  // cell is current works because a blink lasts ~275ms, far too short to
  // notice that her head is a few degrees off during it.
  const blinkImages = useRef<(HTMLImageElement | null)[]>([]);
  const [ready, setReady] = useState(false);
  const drawn = useRef(-1);
  const blendKey = useRef("");
  // Whether the blink branch took the last frame. `drawn` cannot answer that:
  // the blend path writes -999 into it, so "negative" does not mean "blinking".
  const blinking = useRef(false);

  useEffect(() => {
    // A different grid means every cached index is meaningless, and the blink
    // frames are harvested from the same clip as the grid, so a surviving set
    // would blink her with the other clip's face.
    drawn.current = -1;
    blendKey.current = "";
    blinkImages.current = [];
    setReady(false);
  }, [variant]);

  useEffect(() => {
    onTiltAvailable?.(field.tilt);
  }, [field.tilt, onTiltAvailable]);

  /* --------------------------------------------------------------- preload */
  useEffect(() => {
    let cancelled = false;
    images.current = new Array(slotCount).fill(null);

    // Resolves whether the bitmap is usable, not merely that the attempt
    // finished. Resolving the same way for a decoded frame and for a 404 is
    // what let `ready` flip on a hero that had nothing to draw.
    const load = (i: number) =>
      new Promise<boolean>((resolve) => {
        const img = new Image();
        img.decoding = "async";
        img.src = slotSrc(i);
        // decode() rather than onload: onload fires before the bitmap is ready,
        // so the first drawImage of each frame would still pay decode cost.
        img
          .decode()
          .then(() => {
            if (!cancelled) images.current[i] = img;
            resolve(true);
          })
          .catch(() => resolve(false));
      });

    const loadBlink = (i: number) =>
      new Promise<void>((resolve) => {
        const img = new Image();
        img.decoding = "async";
        img.src = `${BASE}blink_${i}.webp`;
        img
          .decode()
          .then(() => {
            if (!cancelled) blinkImages.current[i] = img;
          })
          .catch(() => {})
          .finally(resolve);
      });

    // The rest frame first so something correct is on screen immediately, then
    // the rest of the grid. The remaining cells are each allowed to fail: the
    // blend renormalises over whatever loaded, so a missing neighbour costs a
    // little smoothness, and blocking the whole hero on one of them costs
    // everything.
    //
    // The rest frame is the one that cannot be missing, and it gets one
    // retry because a lone failed decode is usually a transient fetch. If it
    // still will not decode, `ready` stays false deliberately: flipping it
    // fades the canvas up over the <img> below, and a canvas whose blend has no
    // layers to composite draws nothing at all, an invisible hero that
    // nevertheless reports itself loaded. Not-ready leaves the static <img> as
    // the hero, which is the correct degraded state.
    load(restIndex)
      .then((ok) => ok || load(restIndex))
      .then((ok) => {
        if (cancelled) return;
        if (ok) setReady(true);
        void Promise.all([
          ...Array.from({ length: slotCount }, (_, i) => (i === restIndex ? null : load(i))),
          ...Array.from({ length: BLINKS }, (_, i) => loadBlink(i)),
        ]);
      });
    return () => {
      cancelled = true;
    };
  }, [variant]);

  /* ------------------------------------------------------------------ draw */
  useAnimationFrame(() => {
    if (!ready || !inView) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // The cross-fade composites scaled bitmaps, and the default filter is the
    // cheap one. This is the whole of what can be done here: the backing store
    // is already the source size, so any min(source, css * dpr) scheme could
    // only shrink it below source, the residual softness is an upscale past
    // 720p and only larger frames fix it.
    ctx.imageSmoothingQuality = "high";

    // Reduced motion: draw the straight-ahead cell once, then nothing, ever.
    // The rig already freezes the gaze, but it goes on scheduling blinks, and a
    // blink in this renderer is a whole-photograph swap, the largest motion
    // the component makes, and precisely what the preference asks to be spared.
    // Bailing here and not below also means no breath and no per-frame
    // transform write, so she is genuinely still rather than subtly alive.
    if (field.reduced) {
      if (drawn.current === restIndex) return;
      const still = images.current[restIndex];
      if (!still) return;
      ctx.globalAlpha = 1;
      ctx.drawImage(still, 0, 0, canvas.width, canvas.height);
      drawn.current = restIndex;
      return;
    }

    // The head carries most of the visible turn and the eyes add the rest, so
    // the cell is chosen from their sum rather than from gaze alone, otherwise
    // the head would never appear to move between adjacent columns.
    const x = Math.max(-1, Math.min(1, headX.get() * 0.7 + gazeX.get() * 0.3));
    // The scroll bias joins the sum INSIDE the clamp, in the rig's own units,
    // so it competes for the same deflection range instead of being able to
    // push the picture past full travel or `fy` past the last row. And it lands
    // in `y` rather than only in the drift because the point of it is that she
    // actually looks down at what the hero is handing the visitor off to, which
    // means the chosen cell has to change, not just the offset.
    //
    // What it can actually reach depends on the grid, and on variant b that is
    // less than it sounds. Its rest row is 2 of 3, the BOTTOM row, because
    // the clip's vertical range runs level-to-up and it never once looked down.
    // So for y > 0 `axis(y, 2, 3)` is 2 + y * (3 - 1 - 2) = 2: the bias cannot
    // take her BELOW level, and it cannot overshoot either, since y is clamped
    // to 1 and `axis(1, rest, n)` is exactly n - 1.
    //
    // It is not inert, though. Whenever she is looking UP, a cursor parked on
    // the headline or the nav, which is where it sits while you start scrolling
    //, the bias walks y back toward 0 and the row back down toward level, and
    // that is a real cell change. Which is the hand-off, rendered with the only
    // downward range this clip has: from wherever she was looking up, back to
    // meeting the viewer. A clip that genuinely looks down, binned with rows
    // beneath its rest row, would extend it past level with nothing changed
    // here. On variant a (one row) `axis` returns 0 whatever y is, so there it
    // really does render as the sub-percent drift and nothing else.
    const y = Math.max(
      -1,
      Math.min(1, headY.get() * 0.7 + gazeY.get() * 0.3 + (gazeBiasY?.get() ?? 0)),
    );

    // Continuous drift of the whole picture, on the GPU. This is the half of
    // the smoothness that frame selection cannot provide: however finely the
    // grid is divided, choosing a cell is a step function, and between steps
    // nothing moves at all. A few pixels of translate3d gives the eye something
    // continuous to follow, so the cell changes land inside motion that is
    // already happening rather than being the only thing that happens.
    //
    // Breath is SUBTRACTED: it runs 0 -> 1 on the inhale and positive Y here is
    // downward, so adding it would sink her as her chest fills.
    const shiftY = y * DRIFT_PCT.y - breath.get() * BREATH_PCT;
    canvas.style.transform =
      `translate3d(${(x * DRIFT_PCT.x).toFixed(3)}%, ${shiftY.toFixed(3)}%, 0)`;

    // A blink overrides the grid entirely, the eyes are shut, so where she was
    // looking no longer matters for that quarter of a second.
    const b = blink.get();
    if (BLINKS > 0 && TRACKING === "lifelike" && b > 0.08) {
      blinking.current = true;
      const i = -1 - Math.min(BLINKS - 1, Math.round(b * (BLINKS - 1)));
      if (i === drawn.current) return;
      const img = blinkImages.current[-1 - i];
      if (!img) return;
      ctx.globalAlpha = 1;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      drawn.current = i;
      return;
    }

    // The first frame after a blink must redraw unconditionally. The blink
    // branch above replaces the whole canvas but leaves `blendKey` describing
    // the blend that is no longer on screen, and with `idleMotion: false` and a
    // still cursor the gaze settles to exactly the value it had, so the key
    // below matches, the early-out fires, and the last blink frame drawn
    // (blink_0, eyes half shut) stays on screen until the pointer moves.
    if (blinking.current) {
      blinking.current = false;
      blendKey.current = "";
    }

    // Bilinear cross-fade instead of rounding to one cell. Rounding is what
    // makes a grid look stepped: the rig's value is perfectly smooth and the
    // renderer throws that away. Blending the neighbours puts it back.
    const fx = axis(x, restCol, cols);
    const fy = axis(y, restRow, rows);
    const c0 = Math.max(0, Math.min(cols - 1, Math.floor(fx)));
    const r0 = Math.max(0, Math.min(rows - 1, Math.floor(fy)));
    const c1 = Math.min(cols - 1, c0 + 1);
    const r1 = Math.min(rows - 1, r0 + 1);
    // Linear under direct tracking. `sharpenFor` pushes the fraction toward 0
    // or 1 so most cursor positions land on an almost-pure cell, which is what
    // makes travel read as a snap between photographs rather than as movement.
    // Turning it off buys continuity and pays for it in double-exposed pupils
    // across the middle of each crossing; see TRACKING.
    const k = TRACKING === "direct" ? 0 : 1;
    const tx = sharpen(fx - c0, k * sharpenFor(cols));
    const ty = sharpen(fy - r0, k * sharpenFor(rows));

    // Quantised so an imperceptible change does not trigger a redraw; without
    // this the canvas is re-blitted on every frame the cursor is in motion.
    const key = `${c0},${r0},${Math.round(tx * BLEND_STEPS)},${Math.round(ty * BLEND_STEPS)}`;
    if (key === blendKey.current) return;

    const parts: { img: HTMLImageElement; w: number }[] = [];
    const push = (r: number, c: number, w: number) => {
      const img = images.current[slotOf(r, c)];
      if (img && w > 0.02) parts.push({ img, w });
    };
    push(r0, c0, (1 - tx) * (1 - ty));
    push(r0, c1, tx * (1 - ty));
    push(r1, c0, (1 - tx) * ty);
    push(r1, c1, tx * ty);
    if (!parts.length) return;

    // Sequential compositing needs each layer's alpha to be its share of the
    // weight accumulated SO FAR, not its raw weight, drawing four images at
    // their bilinear weights in turn would leave the first barely visible.
    let acc = 0;
    for (const part of parts) {
      acc += part.w;
      ctx.globalAlpha = part.w / acc;
      ctx.drawImage(part.img, 0, 0, canvas.width, canvas.height);
    }
    ctx.globalAlpha = 1;
    blendKey.current = key;
    drawn.current = -999; // a blend, not a single cell
  });

  return (
    <div
      ref={stageRef}
      className={`relative select-none ${className}`}
      style={{ aspectRatio: `${width} / ${height}` }}
      role="img"
      aria-label="A receptionist looking towards you"
    >
      {/* The rest frame as plain markup, mounted for the life of the
          component. It is the reduced-motion presentation, the canvas above
          draws this same cell once and then stops, and it is what remains if
          the canvas never paints: JS that did not run, a decode that failed, or
          the preload's give-up path, where `ready` stays false on purpose. It
          costs no extra bytes, because the preload's `new Image()` for this URL
          hits the same cache entry. It is NOT an LCP win: HeroStage chooses the
          renderer in an effect, so none of this is in the server HTML on the
          `?hero=` routes. It would become one only if a frame renderer ever
          became the default. */}
      <img
        src={frameSrc(restRowIdx, restColIdx)}
        // The wrapper already carries role="img" and the accessible name; a
        // second name here would have a screen reader announce her twice.
        alt=""
        aria-hidden
        width={width}
        height={height}
        className="absolute inset-0 h-full w-full"
        fetchPriority="high"
      />
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        aria-hidden
        className="absolute inset-0 h-full w-full"
        style={{
          // No CSS mask here on purpose. The edge blur and fade to white are
          // baked into the frames by build-hero-frames.py --feather, because a
          // masked canvas has to re-composite its entire layer every time
          // drawImage touches it, which is precisely when the cursor is moving
          // and a new cell is being blitted. Baking costs nothing at runtime.
          // translate3d already promotes this to its own layer; naming it
          // keeps the promotion stable rather than re-created on first move.
          // Justified here because it animates for as long as the hero is on
          // screen, which is the one case where the memory cost is earned.
          willChange: "transform",
          opacity: ready ? 1 : 0,
          transition: "opacity 200ms linear",
        }}
      />
    </div>
  );
}
