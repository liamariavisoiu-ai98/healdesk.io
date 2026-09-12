"use client";

import { useRef } from "react";
import { useAnimationFrame, useMotionValue, type MotionValue } from "motion/react";

import type { AimField } from "@/lib/usePointerField";

/**
 * The oculomotor model: what a face has to do to read as alive.
 *
 * Deliberately independent of how the face is drawn. It emits normalised
 * signals, gaze, head, blink, breath, roll, and knows nothing about sprites,
 * frame grids or meshes, so the same timing can drive a layered 2.5D portrait,
 * a photographed frame grid, or bone rotations on a 3D model. The renderer is
 * the cheap half; this is the half that makes it convincing.
 *
 * ## What actually reads as alive
 *
 * Not head rotation, ocular timing. Four things carry almost all of it,
 * ordered by how badly their absence shows:
 *
 * 1. **Saccades are ballistic, and they are late.** Human eyes do not glide
 *    onto a target, they snap after a ~200ms reaction latency, in 21 + 2.2A ms,
 *    and cannot be corrected mid-flight. A spring-driven iris looks underwater;
 *    an iris that moves on the same frame as the cursor looks like a cursor
 *    attachment. So this runs a real saccade/pursuit state machine.
 * 2. **The eyes lead and the head trails**, and the pupils then slide back
 *    toward the orbital centre as the head catches up while gaze stays locked.
 *    That counter-rotation is the vestibulo-ocular reflex, and it is the single
 *    highest-value detail here: `gaze = eyes - headContribution`.
 * 3. **Nothing ever holds perfectly still.** Fixational drift and microsaccades
 *    separate a living eye from a photograph of one.
 * 4. **Blinks are Poisson-ish, not periodic**, and asymmetric, closing runs
 *    about 2.4x faster than opening. That ratio is what makes a blink read as
 *    flesh rather than as a shutter.
 */

/** Pointer deflection is amplified slightly so the eyes reach their limit
 *  before the cursor reaches the edge of the screen. */
const GAZE_GAIN = 1.35;
/** Full deflection corresponds to roughly this much gaze rotation, which is
 *  what turns an amplitude into a main-sequence duration. */
const GAZE_RANGE_DEG = 14;
/** Visually-guided saccade latency. The delay is a primary aliveness cue. */
const SACCADE_LATENCY_MS = { min: 170, max: 240 };
/** Inter-saccadic refractory floor; back-to-back saccades read as a stutter. */
const SACCADE_REFRACTORY_MS = 150;
/** Below this the residual is tracked by smooth pursuit. */
const SACCADE_TRIGGER = 0.06;
/** Pursuit gain is deliberately under 1: the residual error it leaves is what
 *  produces natural catch-up saccades during continuous cursor motion. */
const PURSUIT_GAIN = 0.9;
const PURSUIT_TAU = 0.12;

/** Eye-head latency in "ocular" mode, exaggerated past the physiological
 *  20-50ms because at these amplitudes a real head would not move at all and
 *  the ordering has to be legible. */
const HEAD_LAG_MS = 150;
/** Eye-head latency in "smooth" mode, which needs more of it. There the eyes
 *  arrive on a ramp instead of a snap, so nothing else in the motion marks where
 *  the eyes finished and the head started, the whole eyes-then-head ordering
 *  has to come out of the lag. At the ocular 150ms the two read as one rigid
 *  part swinging together.
 *
 *  Down from 210 because it is the third of three stacked delays and only the
 *  sum is visible, see SMOOTH_TAU for the chain and the measured timings. It is
 *  the lag that is cut rather than the reaction delay because this one buys
 *  ordering, which survives being shortened, while the reaction delay buys "she
 *  noticed", which does not. */
const SMOOTH_HEAD_LAG_MS = 180;
/** Gaze shifts smaller than this do not recruit the head. A head that answers
 *  every 1px cursor twitch is the strongest single puppet signal in the rig. */
const HEAD_DEADZONE = 0.28;
/** How much of the gaze the head accounts for at full deflection, the term the
 *  VOR subtracts back out of the eyes. */
export const HEAD_GAZE_SHARE = 0.35;
export const ROLL_MAX_DEG = 1.4;

const IDLE_AFTER_MS = 4000;
/** Unbroken mutual gaze past a few seconds reads as staring, so she looks away
 *  even while the cursor is still being tracked. */
const GAZE_BREAK_AFTER_MS = 8000;

const clamp1 = (v: number) => (v < -1 ? -1 : v > 1 ? 1 : v);
const smoothstep = (t: number) => t * t * (3 - 2 * t);
/** Gamma-ish waiting time: a sum of exponentials. A pure exponential produces
 *  too many near-zero gaps, which reads as a twitch rather than a blink. */
const gammaWait = (mean: number) =>
  (-Math.log(1 - Math.random()) - Math.log(1 - Math.random()) - Math.log(1 - Math.random())) *
  (mean / 3);

type RigState = {
  gx: number;
  gy: number;
  /** Ballistic saccade in flight: endpoint locked at launch. */
  sac: { t: number; dur: number; fx: number; fy: number; tx: number; ty: number } | null;
  /** Latency timer between deciding to look and actually moving. */
  pending: number | null;
  /** "ocular" only. It gates the inter-saccadic refractory, and nothing that
   *  is not a saccade may borrow it as a generic "last event" stamp. */
  lastSacEnd: number;
  /** Ring buffer of gaze samples, so the head reads a genuinely delayed signal
   *  rather than approximating the lag with a slower spring. */
  hist: { t: number; x: number; y: number }[];
  /** The same buffer for the aim itself. "smooth" mode has no saccade latency of
   *  its own, so this is where its reaction delay comes from. */
  aimHist: { t: number; x: number; y: number }[];
  nextMicro: number;
  driftX: number;
  driftY: number;
  nextBlink: number;
  blinkStart: number | null;
  /** "smooth" only. Where the delayed aim stood when the last gaze-evoked blink
   *  was triggered, and the origin the next one measures its traverse from. */
  blinkAnchorX: number;
  blinkAnchorY: number;
  /** "smooth" only. When the last gaze-evoked blink was scheduled, for its
   *  cooldown. Separate from `lastSacEnd` on purpose: that one belongs to the
   *  saccade machinery this mode does not run. */
  blinkEvokedAt: number;
  lastAim: { x: number; y: number; t: number };
  /** Last frame the aim actually changed, for a sustained "being tracked" state. */
  movedAt: number;
  trackingSince: number;
  breakUntil: number;
  /** Where she looks during a break when the sine wander is unavailable. Chosen
   *  once at onset and held: re-rolling it per frame would walk a photo-grid
   *  renderer across cells with nothing on screen to explain the motion. */
  breakX: number;
  breakY: number;
  /** When to blink on the way back, so the lids are shut as the return starts. */
  breakEndBlinkAt: number | null;
};

export type GazeRig = {
  /** Eye deflection in [-1, 1], VOR already subtracted. */
  gazeX: MotionValue<number>;
  gazeY: MotionValue<number>;
  /** Head deflection in [-1, 1], trailing the eyes and dead-zoned. */
  headX: MotionValue<number>;
  headY: MotionValue<number>;
  /** Head roll in degrees; real head turns carry a small correlated roll. */
  roll: MotionValue<number>;
  /** Lid closure in [0, 1]. */
  blink: MotionValue<number>;
  /** Breath phase in [0, 1], not a sine; see below. */
  breath: MotionValue<number>;
};

export type GazeRigOptions = {
  /**
   * Whether she keeps moving once the cursor stops, the slow wander and
   * fixational drift. It no longer decides WHETHER she breaks eye contact (see
   * `gazeBreak`), only whether the wander is what she breaks it with.
   *
   * On for a renderer whose frames differ only in iris position: there it is
   * sub-pixel, and its absence is what makes a portrait read as a photograph
   * rather than a person. Off for one that selects whole photographs, because
   * consecutive frames there differ in head pose and hair too, so the same tiny
   * signal moves her entire head, motion with no cause the viewer can see.
   */
  idleMotion?: boolean;
  /**
   * Whether she ever breaks eye contact on her own.
   *
   * Deliberately NOT part of `idleMotion`, and on by default. The look-away was
   * gated on the wander, which meant the renderers that select whole
   * photographs, the ones where unbroken mutual gaze is most uncomfortable,
   * because there is a real face holding it, were the only ones that never got
   * it. What a break *looks* like still depends on `idleMotion`: a wander where
   * the frames can carry one, a single held offset where they cannot.
   *
   * The rule the call sites follow: a break is affordable only where the
   * renderer can hide both its onset and its return behind a blink, because
   * for them it is a cut between two photographs rather than a drift of the
   * eyes. So it is on for a frame grid that ships blink frames, and off for the
   * scrubbed video and for a grid whose clip never blinked.
   */
  gazeBreak?: boolean;
  /**
   * How the gaze reaches its target.
   *
   * "ocular" is the physiological model: a reaction delay, then a ballistic
   * jump that cannot be corrected in flight, with smooth pursuit closing the
   * residual. It is what makes an iris read as an eye rather than a cursor
   * attachment, but it is, by design, not smooth. Every saccade is a snap.
   *
   * "smooth" keeps the reaction delay, the one part of the model that still
   * reads when every frame is a whole photograph, and replaces the ballistic
   * flight with a single critically-damped follow: she notices late, then
   * tracks, with no jump and no overshoot. It reads as less biologically real
   * and more deliberate, which is the right trade when each step also moves her
   * whole head, as it does for a scrubbed video or a grid of stills.
   */
  /**
   * "direct" is the third option and it is the one the other two exist to
   * avoid: gaze IS the cursor, sampled this frame. No reaction delay, no
   * exponential, no head lag, no deadzone, no VOR, `head` and `gaze` are both
   * set to the raw aim so a renderer mixing them at any ratio gets exactly the
   * pointer back. It reads as mechanical, because it is.
   *
   * It exists because on a coarse frame grid the physiology fights the
   * representation. Every delay in "smooth" is invisible on a face that moves
   * continuously, but here it lands as: nothing, nothing, nothing, then a whole
   * different photograph. And the deadzone makes it worse, a cursor move under
   * 0.28 produces no response at all, so small movements are simply swallowed
   * and the eventual change arrives with no gesture attached to it. Direct at
   * least ties every step to something the hand did.
   */
  follow?: "ocular" | "smooth" | "direct";
};

/** Time constant of the smooth follow. Long enough that pointer jitter never
 *  reaches her, and slower than it looks like it should be: the frame-grid
 *  renderer picks its cell from `headX * 0.7 + gazeX * 0.3`, so the thing the
 *  viewer sees moving is a HEAD, and a head orients in 400-600ms. At 200ms she
 *  swung onto the cursor like a turret.
 *
 *  0.18 and not the 0.28 this started at, because THREE delays stack here and
 *  the viewer only ever sees the sum: SMOOTH_REACTION_MS of dead time, then this
 *  lag, then SMOOTH_HEAD_LAG_MS again on the copy the head reads, and on top of
 *  that HEAD_DEADZONE holds the head completely still until the gaze has cleared
 *  0.28, so the head's share starts later still. Stepped through the real 60fps
 *  loop for the five-column variant, where the dominant cell changes as the
 *  composite passes 0.25, and with the VOR included, because the renderer reads
 *  the POST-VOR gaze and the mix is therefore really `0.595 * head + 0.3 * gaze`:
 *
 *    0.28 / 210ms: first cell change ~435ms at full deflection, ~815ms at half,
 *                  90% settled at ~1.0s, about twice the envelope above.
 *    0.18 / 180ms: first cell change ~365ms at full deflection, ~600ms at half,
 *                  90% settled at ~715ms.
 *
 *  Which straddles the envelope rather than sitting inside it: a full-deflection
 *  move is ~35ms early and a half-deflection one lands right at the far end. The
 *  spread between the two is not the time constant's to close either. It is the
 *  deadzone again, which a small move has to climb out of before the head
 *  contributes anything. Shortening this further to centre the half-amplitude
 *  case would pull the full-amplitude one back toward the turret.
 *
 *  One thing retuning cannot buy: the smallest cursor move that changes the cell
 *  at all is ~0.43 of full deflection at any timing, because HEAD_DEADZONE eats
 *  the head's first 0.28 and the 0.3 of gaze left over cannot reach 0.25 alone.
 *  That is the deadzone's doing, and the deadzone is shared with the ocular path,
 *  so it is not retunable from here. */
const SMOOTH_TAU = 0.18;
/** The reaction delay "smooth" mode would otherwise have thrown away with the
 *  rest of the saccade machinery, and it is the half that mattered. An
 *  integrator chasing the live aim starts moving on the same frame the mouse
 *  does, which reads as a cursor attachment however gently it then glides.
 *
 *  Held at 140 while SMOOTH_TAU and SMOOTH_HEAD_LAG_MS were cut to bring the
 *  stacked total back to the 400-600ms head-orienting envelope it had drifted to
 *  twice. Dead time is the
 *  cheapest third of that total. It delays the start of the move without
 *  slowing the move itself, and it is the only third that stops the
 *  cursor-attachment read, so it is the last thing that should be spent. */
const SMOOTH_REACTION_MS = 140;
/** Traverse that recruits a blink in "smooth" mode, in the rig's [-1, 1] gaze
 *  space. It is deliberately expressed in rig units and not in cells, because
 *  this file knows nothing about grids, but that means it only APPROXIMATES a
 *  cell, and how well depends on the renderer.
 *
 *  It was sized when the frame grid mapped gaze to cells on one straight line,
 *  where a five-column grid put a cell at 0.5 and this fired at roughly 0.8 of
 *  one. That map is now piecewise: HeroFrames anchors aim 0 on the cell where
 *  the clip actually looks down the lens, so each side of centre gets the travel
 *  that clip contains rather than an equal share. On the grid that ships, one
 *  column is 1.0 rig units to her left of rest and 0.333 to her right, so this
 *  threshold is ~0.4 of a column leftward and ~1.2 rightward.
 *
 *  Left as one number on purpose. Covering every crossing would mean handing the
 *  rig the renderer's geometry, and it would not buy much: SMOOTH_BLINK_COOLDOWN_MS
 *  already caps this at one blink per 800ms, so a fast sweep across three columns
 *  has crossings the masking cannot reach whatever the threshold is. It hides the
 *  first cut of a traverse, which is the one the eye is waiting for; a denser,
 *  symmetric grid off a longer clip is what would let it hide the rest.
 *
 *  Measured as distance from where the aim was at the last evoked blink. NOT
 *  as the integrator's tracking error. Error is the wrong quantity however much
 *  it looks like the right one: for a ramp into this lag plus dead time the error
 *  settles at v * (SMOOTH_TAU + SMOOTH_REACTION_MS), so testing it is a cursor
 *  SPEED limit wearing an amplitude's clothes, and anything past
 *  0.4 / 0.32 = 1.2 gaze units/s, about 600 px/s on a 1440px viewport, an
 *  ordinary deliberate sweep, sits permanently over the line for as long as the
 *  hand keeps moving. */
const SMOOTH_BLINK_TRIGGER = 0.4;
/** Floor between two gaze-evoked blinks. A blink is ~275ms of lid movement and
 *  the frame renderer paints it over the whole canvas, so back-to-back evoked
 *  blinks do not read as blinking. They read as a strobe with the gaze frozen
 *  behind it. Deliberately its own timer and not SACCADE_REFRACTORY_MS, which is
 *  both far too short to bound a blink and the ocular path's state. */
const SMOOTH_BLINK_COOLDOWN_MS = 800;

export function useGazeRig(
  field: AimField,
  active: boolean,
  { idleMotion = true, follow = "ocular", gazeBreak = true }: GazeRigOptions = {},
): GazeRig {
  const { reduced } = field;
  // Per-mode head lag rather than a globally slower head: raising it for
  // "ocular" too would blunt the eyes-lead-head ordering on the layered
  // portrait, where the saccade already makes that ordering readable.
  const headLag = follow === "smooth" ? SMOOTH_HEAD_LAG_MS : HEAD_LAG_MS;

  const gazeX = useMotionValue(0);
  const gazeY = useMotionValue(0);
  const blink = useMotionValue(0);
  const headX = useMotionValue(0);
  const headY = useMotionValue(0);
  const roll = useMotionValue(0);
  const breath = useMotionValue(0);

  const rig = useRef<RigState>({
    gx: 0,
    gy: 0,
    sac: null,
    pending: null,
    lastSacEnd: 0,
    hist: [],
    aimHist: [],
    nextMicro: 0,
    driftX: 0,
    driftY: 0,
    nextBlink: 900,
    blinkStart: null,
    blinkAnchorX: 0,
    blinkAnchorY: 0,
    blinkEvokedAt: -Infinity,
    lastAim: { x: 0, y: 0, t: 0 },
    movedAt: -Infinity,
    trackingSince: 0,
    breakUntil: 0,
    breakX: 0,
    breakY: 0,
    breakEndBlinkAt: null,
  });

  useAnimationFrame((t, delta) => {
    if (!active) return;
    const dt = Math.min(delta, 50) / 1000; // a backgrounded tab must not lurch
    const r = rig.current;
    let tracking = false;

    if (!reduced) {
      /* ----------------------------------------------------------- target */
      const aim = field.read();
      let tx = clamp1(aim.x * GAZE_GAIN);
      let ty = clamp1(aim.y * GAZE_GAIN);

      // Presence is judged on the RAW aim, not the gain-clamped target. Once the
      // cursor is past the saturation point, which the headline and CTAs both
      // sit inside, the clamped value stops changing, and testing that would
      // read an actively moving mouse as an empty room.
      const moved =
        Math.abs(aim.x - r.lastAim.x) > 0.003 || Math.abs(aim.y - r.lastAim.y) > 0.003;
      if (moved) {
        if (t - r.lastAim.t > IDLE_AFTER_MS) r.trackingSince = t;
        r.lastAim = { x: aim.x, y: aim.y, t };
        r.movedAt = t;
      }
      // Sustained state, not a single-frame edge: a mouse is in motion on only a
      // fraction of frames, so sampling the edge flag at reschedule time would
      // almost always miss it and the blink rate would never drop.
      tracking = t - r.movedAt < 900;

      const idle = t - r.lastAim.t > IDLE_AFTER_MS;
      // Look away now and then. A face that only ever stares at the cursor is a
      // puppet; one that glances off and comes back is a person.
      if (gazeBreak && !idle && t - r.trackingSince > GAZE_BREAK_AFTER_MS && t > r.breakUntil) {
        r.breakUntil = t + 900 + Math.random() * 700;
        r.trackingSince = t + 2000;
        if (!idleMotion) {
          // Without the wander there is nothing to break TO, so the offset is
          // picked here, once, and held for the whole break. A random side so
          // consecutive breaks do not look scripted, and down rather than up
          // because a glance up and away reads as dismissive.
          r.breakX = (Math.random() < 0.5 ? -1 : 1) * (0.34 + Math.random() * 0.16);
          r.breakY = 0.1 + Math.random() * 0.1;
          // Both ends of the break get a blink, because here a break is not a
          // drift of the eyes. It is a cut to a different photograph of her
          // head, and the renderer draws blink frames over the whole canvas.
          // Onset now; the return is scheduled one lid-closure early so the eyes
          // are actually shut at the moment she starts coming back. In smooth
          // mode the onset is covered for free, because the held offset only
          // reaches the integrator a reaction delay later, by then the lids are
          // already down.
          r.breakEndBlinkAt = r.breakUntil - 75;
          if (r.blinkStart === null) r.nextBlink = t - 30;
          // A scripted blink has to go on the same books as an evoked one.
          // Without this stamp the traverse test downstream reads the held
          // offset arriving at the integrator as a fresh traverse and fires
          // again ~400ms later, and then a fourth time when the aim snaps back
          // at the end, four blinks and 142ms of open eyes between them, which
          // is the strobe the cooldown exists to prevent. Stamping puts the next
          // 800ms in the cooldown arm, where the anchor follows the aim, so the
          // distance the break itself covers is never banked as a traverse.
          r.blinkEvokedAt = t;
        }
      }
      if (r.breakEndBlinkAt !== null && t >= r.breakEndBlinkAt) {
        r.breakEndBlinkAt = null;
        if (r.blinkStart === null) r.nextBlink = t - 30;
        r.blinkEvokedAt = t; // same bookkeeping, for the snap back to the cursor
      }
      if (idleMotion && (idle || t < r.breakUntil)) {
        const s = t / 1000;
        tx = Math.sin(s * 0.21) * 0.34 + Math.sin(s * 0.13) * 0.12;
        ty = Math.sin(s * 0.17 + 1.1) * 0.14 + 0.08; // bias down: up-and-away reads as thinking
      } else if (!idleMotion && t < r.breakUntil) {
        tx = r.breakX;
        ty = r.breakY;
      }

      /* ------------------------------------------ saccade / smooth pursuit */
      if (follow === "direct") {
        // The whole model, skipped. Aim in, gaze out, this frame.
        r.gx = tx;
        r.gy = ty;
        r.sac = null;
        r.pending = null;
      } else if (follow === "smooth") {
        // One exponential approach: no ballistic jump, no drift. What it does
        // keep is that she notices late, the integrator chases the aim as it
        // was SMOOTH_REACTION_MS ago, held in the same kind of ring buffer the
        // head already reads from.
        //
        // Only tx/ty are delayed. Everything above that decides whether anyone
        // is there still reads the LIVE aim on purpose: a delayed aim reports a
        // moving mouse as an empty room for its first 140ms, and the blink rate
        // and the gaze-break timer both hang off that judgement.
        r.aimHist.push({ t, x: tx, y: ty });
        while (r.aimHist.length > 2 && r.aimHist[0]!.t < t - SMOOTH_REACTION_MS - 40) {
          r.aimHist.shift();
        }
        const late = r.aimHist.find((s) => s.t >= t - SMOOTH_REACTION_MS) ?? r.aimHist[0]!;

        // Gaze-evoked blink. The amplitude-weighted version lives in the saccade
        // launch below, which this branch never reaches, and it earns more here
        // than it does there: the frame renderer paints blink frames over the
        // whole canvas, so a blink covers the traverse between photographs the
        // way an editor covers a cut.
        //
        // What it measures is the TRAVERSE, how far the aim has moved since the
        // last evoked blink, and not the integrator's tracking error. Error looks
        // like the same quantity and is not: a lag with dead time holds a
        // standing error proportional to cursor SPEED, so an error test fires
        // every time the cooldown expires for as long as the mouse keeps moving
        // at an ordinary sweeping pace, and the renderer then spends most of its
        // frames in the blink branch, which returns before the blend and leaves
        // the gaze frozen while she strobes.
        //
        // Within the cooldown the anchor follows the aim instead of holding
        // still, so distance covered while the lids are down is not banked and
        // charged again the moment they open: one traverse, one blink, however
        // far past the threshold the traverse runs. A deliberate edge-to-edge
        // sweep of 200-900ms gets exactly one; sustained hand-waving cannot beat
        // one per ~900ms however fast it is, which is a quarter of the frames in
        // the blink branch rather than the three-fifths an error test spent
        // there.
        if (t - r.blinkEvokedAt <= SMOOTH_BLINK_COOLDOWN_MS) {
          r.blinkAnchorX = late.x;
          r.blinkAnchorY = late.y;
        } else if (
          Math.hypot(late.x - r.blinkAnchorX, late.y - r.blinkAnchorY) > SMOOTH_BLINK_TRIGGER &&
          r.blinkStart === null
        ) {
          // Delayed by the head lag rather than fired now. The thing the blink
          // exists to hide is the double-pupil cross-fade, and that happens when
          // the RENDERER's `head * 0.7 + gaze * 0.3` crosses a cell boundary,
          // off a copy of the gaze delayed by SMOOTH_HEAD_LAG_MS again. This test
          // fires as soon as the aim arrives, which is ~230ms before that, so
          // firing it straight away shut the lids and had them open again with
          // the crossing still to come.
          //
          // The envelope below is fully shut 75ms after it starts, so that much
          // comes back off the lag: closure lands at +180ms, the renderer is in
          // its blink branch from +125ms to +330ms, and the full-deflection
          // crossing arrives at +230ms, inside it. A half-deflection traverse
          // still escapes, the deadzone pushes its crossing out to +465ms, and
          // no single 200ms window covers both without the amplitude, which this
          // does not model.
          r.nextBlink = t + SMOOTH_HEAD_LAG_MS - 75;
          r.blinkEvokedAt = t;
          r.blinkAnchorX = late.x;
          r.blinkAnchorY = late.y;
        }

        const k = 1 - Math.exp(-dt / SMOOTH_TAU);
        r.gx += (late.x - r.gx) * k;
        r.gy += (late.y - r.gy) * k;
        r.sac = null;
        r.pending = null;
      } else if (r.sac) {
        r.sac.t += delta;
        const p = Math.min(1, r.sac.t / r.sac.dur);
        const e = smoothstep(p);
        r.gx = r.sac.fx + (r.sac.tx - r.sac.fx) * e;
        r.gy = r.sac.fy + (r.sac.ty - r.sac.fy) * e;
        if (p >= 1) {
          r.sac = null;
          r.lastSacEnd = t;
        }
      } else {
        const dx = tx - r.gx;
        const dy = ty - r.gy;
        const dist = Math.hypot(dx, dy);

        if (r.pending !== null && t >= r.pending) {
          // Endpoint resolved at launch, not at decision: the eye aims where the
          // target is *now*, then flies blind.
          r.pending = null;
          const amp = Math.hypot(tx - r.gx, ty - r.gy) * GAZE_RANGE_DEG;
          r.sac = {
            t: 0,
            dur: Math.min(90, Math.max(28, 21 + 2.2 * amp)),
            fx: r.gx,
            fy: r.gy,
            tx,
            ty,
          };
          // Blink probability rises with gaze amplitude.
          if (r.blinkStart === null && Math.random() < Math.min(0.4, 0.05 + 0.02 * amp)) {
            r.nextBlink = t - 30;
          }
        } else if (
          r.pending === null &&
          dist > SACCADE_TRIGGER &&
          t - r.lastSacEnd > SACCADE_REFRACTORY_MS
        ) {
          r.pending =
            t +
            SACCADE_LATENCY_MS.min +
            Math.random() * (SACCADE_LATENCY_MS.max - SACCADE_LATENCY_MS.min);
        }

        // Pursuit runs regardless. It is what closes the residual while a
        // saccade is still being decided.
        const k = (1 - Math.exp(-dt / PURSUIT_TAU)) * PURSUIT_GAIN;
        r.gx += dx * k;
        r.gy += dy * k;
      }

      /* ----------------------------------------- fixational drift + micro */
      if (idleMotion) {
        r.driftX = r.driftX * 0.94 + (Math.random() - 0.5) * dt * 0.9;
        r.driftY = r.driftY * 0.94 + (Math.random() - 0.5) * dt * 0.6;
        if (t > r.nextMicro) {
          r.nextMicro = t + 340 + Math.random() * 560;
          r.driftX += (Math.random() - 0.5) * 0.03;
          r.driftY += (Math.random() - 0.5) * 0.02;
        }
      } else {
        // Decay whatever is left rather than snapping it away, or she twitches
        // to a stop the moment the cursor does.
        r.driftX *= 0.9;
        r.driftY *= 0.9;
      }

      /* -------------------------------------------------- head trails eyes */
      if (follow === "direct") {
        // Head and gaze both carry the raw aim, so a renderer mixing them at
        // any ratio gets the pointer back unchanged: 0.7a + 0.3a = a. Three
        // things are deliberately skipped, and each one is a reason the coarse
        // grid felt unresponsive. The lag, because a delayed copy means the
        // photograph changes after the hand has stopped. The deadzone, because
        // it swallows the first 0.28 of every movement and then hands over a
        // jump with no gesture attached. And the VOR, because subtracting the
        // head's share back out of the eyes leaves the mix at 0.895 of the aim,
        // so the outermost column could never be reached at all.
        const hx = clamp1(r.gx);
        const hy = clamp1(r.gy);
        headX.set(hx);
        headY.set(hy);
        roll.set(hx * ROLL_MAX_DEG);
        gazeX.set(hx);
        gazeY.set(hy);
      } else {
        r.hist.push({ t, x: r.gx, y: r.gy });
        while (r.hist.length > 2 && r.hist[0]!.t < t - headLag - 40) r.hist.shift();
        const past = r.hist.find((s) => s.t >= t - headLag) ?? r.hist[0]!;
        const dz = (v: number) =>
          Math.abs(v) < HEAD_DEADZONE ? 0 : (v - Math.sign(v) * HEAD_DEADZONE) / (1 - HEAD_DEADZONE);
        const hx = dz(past.x);
        const hy = dz(past.y);
        headX.set(hx);
        headY.set(hy);
        roll.set(hx * ROLL_MAX_DEG);

        // VOR: the head has taken over part of the gaze, so the eyes give it back.
        gazeX.set(clamp1(r.gx + r.driftX - hx * HEAD_GAZE_SHARE));
        gazeY.set(clamp1(r.gy + r.driftY - hy * HEAD_GAZE_SHARE));
      }
    }

    /* ------------------------------------------------------------ breathing */
    // Inhale is shorter than exhale, and there is a pause before the next
    // breath. The pause is what makes it read as breathing and not a sine wave.
    const ph = (t / 1000) % 4;
    const amp = reduced ? 0.5 : 1;
    breath.set(
      amp * (ph < 1.4 ? smoothstep(ph / 1.4) : ph < 3.4 ? 1 - smoothstep((ph - 1.4) / 2) : 0),
    );

    /* ---------------------------------------------------------------- blink */
    if (r.blinkStart === null && t >= r.nextBlink) r.blinkStart = t;
    if (r.blinkStart !== null) {
      const b = t - r.blinkStart;
      const CLOSE = 75;
      const SHUT = 20;
      const OPEN = 180;
      if (b < CLOSE) {
        const p = b / CLOSE;
        blink.set(p * p); // accelerating into contact
      } else if (b < CLOSE + SHUT) {
        blink.set(1);
      } else if (b < CLOSE + SHUT + OPEN) {
        const p = (b - CLOSE - SHUT) / OPEN;
        blink.set((1 - p) * (1 - p)); // levator reopens slowly
      } else {
        blink.set(0);
        r.blinkStart = null;
        // Blink rate drops during concentration, which is what tracking is.
        const mean = reduced ? 7500 : tracking ? 6700 : 4000;
        r.nextBlink =
          Math.random() < 0.1
            ? t + 300 + Math.random() * 400 // the occasional double
            : t + Math.max(1200, gammaWait(mean));
      }
    }
  });

  return { gazeX, gazeY, headX, headY, roll, blink, breath };
}
