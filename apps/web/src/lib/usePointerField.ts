"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";

/**
 * One normalised aim signal, from whichever input the device actually has.
 *
 * Mouse, touch drag, keyboard focus and device tilt all collapse to the same
 * {x, y} in [-1, 1], so nothing downstream knows which is driving. The origin is
 * the *portrait*, not the viewport: (0, 0) means the pointer is over her face,
 * so she looks at the cursor rather than at a mirror of it.
 *
 * ## Why this exposes read() instead of MotionValues
 *
 * `deviceorientation` fires on the sensor's schedule, not the compositor's.
 * Writing transforms from that handler desynchronises them from the frame loop.
 * So both handlers do one thing, stash a raw sample in a ref, and the rig's
 * single rAF loop pulls an arbitrated target from read(). One integrator, one
 * output, no two-source tug of war.
 *
 * ## Why tilt is not read from beta/gamma
 *
 * gamma is confined to (-90, 90), so any roll past vertical is re-expressed by
 * jumping beta ~180 degrees while gamma stays in band. Consuming those as axes
 * gives a hero that flips to a corner when someone lies down. Instead this
 * derives the gravity ("which way is up") unit vector in the device frame,
 * which is alpha-free and has no wraparound anywhere, and measures the rotation
 * between that and a captured rest pose, see `tiltAngles`. Everything is
 * relative to the rest pose because nobody holds a phone flat on a table.
 */

/** Tilt away from the rest pose that maps to full deflection. A hand rocks
 *  comfortably through maybe this much; asking for more strands the far end of
 *  the range for anyone on a sofa. */
const TILT_FULL_DEG = { x: 14, y: 12 };
/** Gyros dither by a few tenths of a degree at rest. */
const TILT_DEADZONE_DEG = 0.4;
/** A single sample jumping this far is a pocket or a table transition. */
const TILT_SPIKE_DEG = 20;
/** Samples averaged into the rest pose, ~180ms. The literal first event lands
 *  mid-gesture, the user has just tapped the button that granted permission. */
const REST_SAMPLES = 10;
/** How long a pointer stays authoritative before tilt may take back over. */
const POINTER_HOLD_MS = 1800;
/** How long after a finger leaves the glass before the gaze returns to the
 *  viewer. A cursor that has stopped moving has not stopped existing, so the
 *  hold in read() deliberately never expires on its own, but a lifted finger
 *  HAS stopped existing, and on a phone with no tilt grant there is no second
 *  source for read() to hand over to, so she would hold her stare at the spot
 *  the finger left for the rest of the visit. Long enough that the gap between
 *  the two taps of a double-tap is not read as the end of the gesture. */
const TOUCH_RELEASE_MS = 2000;

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const clamp1 = (v: number) => (v < -1 ? -1 : v > 1 ? 1 : v);

export type TiltControl = {
  /** The platform can report orientation at all. */
  supported: boolean;
  /** iOS 13+: needs a user gesture before it will report anything. */
  needsPermission: boolean;
  granted: boolean;
  denied: boolean;
  /** MUST be called synchronously from a click/tap handler. */
  request: () => void;
};

export type AimField = {
  /** Arbitrated aim in [-1, 1]. Call once per frame from the rig's rAF loop. */
  read: () => { x: number; y: number };
  tilt: TiltControl;
  reduced: boolean;
};

type Vec3 = [number, number, number];

/** Gravity direction in the device frame, the third row of the spec's ZXY
 *  rotation matrix, and independent of alpha (compass heading). */
function upVector(betaDeg: number, gammaDeg: number): Vec3 {
  const b = betaDeg * D2R;
  const g = gammaDeg * D2R;
  return [-Math.cos(b) * Math.sin(g), Math.sin(b), Math.cos(b) * Math.cos(g)];
}

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * How far the device has tilted from its rest pose, in degrees per screen axis.
 *
 * Reading the up-vector's x and y components directly is the obvious approach
 * and it is wrong: those are only angles when the phone is flat on a table. The
 * gain falls off as cos(beta), so in the ordinary upright holding pose the
 * signal nearly vanishes, and because sin(beta) peaks at vertical, the
 * vertical channel also loses its sign there, so tipping the phone either way
 * moves the gaze the same direction.
 *
 * Instead take the rotation vector that carries the rest up-vector onto the
 * current one, and read it along two screen axes. Vertical is rotation about
 * the device's x axis. Horizontal is rotation about `u0 x X`, which is by
 * construction the axis whose rotation slides gravity across the screen. It
 * resolves to the page-turn axis when the phone lies flat and to the
 * steering-wheel twist when it is held upright, which is the gesture people
 * actually make. Both axes then have unity gain and no cross-talk at every
 * holding angle.
 */
function tiltAngles(rest: Vec3, u: Vec3): { horiz: number; vert: number } {
  const axis = cross(rest, u);
  const s = Math.hypot(axis[0], axis[1], axis[2]);
  if (s < 1e-9) return { horiz: 0, vert: 0 };
  const ang = (Math.atan2(s, dot(rest, u)) * R2D) / s;
  const rv: Vec3 = [axis[0] * ang, axis[1] * ang, axis[2] * ang];

  const h = cross(rest, [1, 0, 0]);
  const hm = Math.hypot(h[0], h[1], h[2]);
  if (hm < 1e-6) return { horiz: 0, vert: rv[0] };
  return { horiz: dot(rv, [h[0] / hm, h[1] / hm, h[2] / hm]), vert: rv[0] };
}

export function usePointerField(targetRef: React.RefObject<HTMLElement | null>): AimField {
  const reduced = useReducedMotion() ?? false;

  const [tiltSupported, setTiltSupported] = useState(false);
  const [tiltNeedsPermission, setTiltNeedsPermission] = useState(false);
  const [tiltGranted, setTiltGranted] = useState(false);
  const [tiltDenied, setTiltDenied] = useState(false);

  const pointer = useRef({ x: 0, y: 0, at: -Infinity });
  const tiltAim = useRef({ x: 0, y: 0, live: false });
  const orient = useRef({
    last: null as { beta: number; gamma: number } | null,
    spikes: 0,
    samples: [] as Vec3[],
    rest: null as Vec3 | null,
  });

  /* --------------------------------------------------------- capability ---- */
  useEffect(() => {
    // Three steps, in order. Touching .requestPermission on a browser where
    // DeviceOrientationEvent is undefined throws and takes the hero down.
    if (typeof window === "undefined") return;
    if (typeof window.DeviceOrientationEvent === "undefined") return;
    // A desktop browser defines DeviceOrientationEvent and will happily report
    // nothing forever. Requiring a coarse pointer keeps the "tilt to look
    // around" affordance off machines that have a mouse.
    if (!window.matchMedia?.("(pointer: coarse)").matches) return;
    setTiltSupported(true);
    const maybe = window.DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<PermissionState>;
    };
    const gated = typeof maybe.requestPermission === "function";
    setTiltNeedsPermission(gated);
    // Android has no permission gate, so there is nothing to ask for and no
    // button to show, just start listening. Only iOS reaches the affordance.
    if (!gated) setTiltGranted(true);
  }, []);

  /* ------------------------------------------------------------ pointer ---- */
  useEffect(() => {
    if (reduced || typeof window === "undefined") return;

    // Cached: the portrait is itself being scaled by the scroll rig, so its box
    // moves constantly and measuring per event would thrash layout.
    let box = { cx: 0, cy: 0, reachX: 1, reachY: 1 };
    let queued = false;
    // Tracked only so cleanup can cancel it. A frame that lands after unmount is
    // harmless today because measure() touches locals and a null-guarded ref,
    // but that is a property of measure()'s current body, not of this effect, and
    // whoever next reaches for a setState in there should not inherit a callback
    // that outlives the component.
    let measureRaf = 0;

    const measure = () => {
      queued = false;
      const r = targetRef.current?.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      box = {
        cx: r ? r.left + r.width / 2 : vw / 2,
        cy: r ? r.top + r.height * 0.38 : vh / 2, // aim at the eyes, not the chest
        reachX: Math.max(vw * 0.45, 300),
        reachY: Math.max(vh * 0.45, 260),
      };
    };
    const remeasure = () => {
      if (queued) return;
      queued = true;
      measureRaf = requestAnimationFrame(measure);
    };
    measure();

    const aim = (cx: number, cy: number) => {
      pointer.current = {
        x: clamp1((cx - box.cx) / box.reachX),
        y: clamp1((cy - box.cy) / box.reachY),
        at: performance.now(),
      };
    };

    // Any fresh aim from a finger or a cursor cancels a queued touch release, so
    // the pause between the taps of a double-tap does not drop her gaze mid
    // gesture.
    let touchRelease: ReturnType<typeof setTimeout> | null = null;
    const cancelTouchRelease = () => {
      if (touchRelease === null) return;
      clearTimeout(touchRelease);
      touchRelease = null;
    };

    const onPointer = (e: PointerEvent) => {
      cancelTouchRelease();
      aim(e.clientX, e.clientY);
    };
    const onTouch = (e: TouchEvent) => {
      cancelTouchRelease();
      const t = e.touches[0];
      if (t) aim(t.clientX, t.clientY);
    };
    // Focus, not keydown. Focus is where a keyboard user's attention actually
    // is; a keystroke only says that a key was struck, and most keystrokes
    // (typing into a field) do not move attention anywhere. Focus is also the
    // one signal such a user emits continuously as they move through the page,
    // so it is the only thing that can drive her for a visit with no mouse and
    // no tilt, without it she stares dead ahead from first paint to last.
    const onFocus = (e: FocusEvent) => {
      const el = e.target;
      // Three ways a focus target sends her somewhere nobody is looking.
      // focusin can retarget to something that is not an Element at all, so
      // there is no rect to read. body and the documentElement are the focus
      // fallback and span the viewport, so their centre means nothing more than
      // "the middle of the page". And a hidden or zero-size element, a
      // visually-hidden skip link, a collapsed wrapper, reports a rect at the
      // document origin, which aims her at the top-left corner.
      if (!(el instanceof Element)) return;
      if (el === document.body || el === document.documentElement) return;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      // Focus usually arrives with a scroll-into-view, and the scroll event that
      // refreshes the cached box only fires after this handler. A cursor
      // survives a stale box because the next pointermove corrects it; a
      // keyboard user's next signal may be seconds away, so re-measure first.
      measure();
      aim(r.left + r.width / 2, r.top + r.height / 2);
    };
    // Losing the cursor hands control back to whatever else is driving rather
    // than freezing her mid-glance. Liveness is CLEARED, not refreshed: stamping
    // a fresh timestamp here would make a dead-centre pointer outrank tilt for
    // the next 1.8s, so every tap would jerk her eyes to neutral.
    const release = () => {
      pointer.current = { x: 0, y: 0, at: -Infinity };
    };
    // The one input whose absence read() cannot infer. Its staleness test hands
    // over to tilt and nothing else, which is right for a cursor and wrong for a
    // fingertip, so the end of a touch has to be declared here. release() parks
    // the aim at (0, 0), her own face in this hook's space, so the rig eases
    // her back to looking at the viewer rather than holding the last touch point
    // forever. The glide is the rig's smoothing; there is nothing to ease here.
    const onTouchEnd = () => {
      cancelTouchRelease();
      touchRelease = setTimeout(release, TOUCH_RELEASE_MS);
    };

    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("touchmove", onTouch, { passive: true });
    window.addEventListener("touchstart", cancelTouchRelease, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onTouchEnd, { passive: true });
    window.addEventListener("focusin", onFocus);
    document.addEventListener("pointerleave", release);
    window.addEventListener("blur", release);
    window.addEventListener("resize", remeasure, { passive: true });
    window.addEventListener("scroll", remeasure, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("touchmove", onTouch);
      window.removeEventListener("touchstart", cancelTouchRelease);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
      window.removeEventListener("focusin", onFocus);
      document.removeEventListener("pointerleave", release);
      window.removeEventListener("blur", release);
      window.removeEventListener("resize", remeasure);
      window.removeEventListener("scroll", remeasure);
      cancelTouchRelease();
      cancelAnimationFrame(measureRaf);
    };
  }, [reduced, targetRef]);

  /* --------------------------------------------------------------- tilt ---- */
  useEffect(() => {
    if (reduced || !tiltGranted || typeof window === "undefined") return;

    const onOrient = (event: DeviceOrientationEvent) => {
      const { beta, gamma } = event;
      if (beta == null || gamma == null) return;
      const o = orient.current;

      if (o.last) {
        const jump = Math.max(Math.abs(beta - o.last.beta), Math.abs(gamma - o.last.gamma));
        if (jump > TILT_SPIKE_DEG) {
          o.last = { beta, gamma };
          // Three in a row means the user genuinely repositioned; re-baseline
          // rather than holding a rest pose that no longer describes anything.
          if (++o.spikes >= 3) {
            o.spikes = 0;
            o.samples = [];
            o.rest = null;
          }
          return;
        }
        o.spikes = 0;
      }
      o.last = { beta, gamma };

      const u = upVector(beta, gamma);
      if (!o.rest) {
        o.samples.push(u);
        if (o.samples.length < REST_SAMPLES) return;
        const med = (i: 0 | 1 | 2) => {
          const s = o.samples.map((v) => v[i]).sort((a, b) => a - b);
          return s[s.length >> 1]!;
        };
        const m: Vec3 = [med(0), med(1), med(2)];
        const len = Math.hypot(m[0], m[1], m[2]) || 1;
        o.rest = [m[0] / len, m[1] / len, m[2] / len];
        return;
      }

      const { horiz, vert } = tiltAngles(o.rest, u);

      // A deflection past the usable range is a reposition, not a gesture,
      // nobody holds a 14 degree lean. Creep the rest pose toward the current
      // one so the range re-centres instead of staying pinned against the
      // clamp. The spike filter below cannot catch this: sitting up from a
      // slouch arrives as tens of sub-degree samples, never as a jump.
      if (Math.abs(horiz) > TILT_FULL_DEG.x || Math.abs(vert) > TILT_FULL_DEG.y) {
        const k = 0.02; // ~1s at 60Hz
        o.rest = [
          o.rest[0] + (u[0] - o.rest[0]) * k,
          o.rest[1] + (u[1] - o.rest[1]) * k,
          o.rest[2] + (u[2] - o.rest[2]) * k,
        ];
      }

      // Right edge down should send the gaze right, and tipping the top toward
      // you should send it up, matching the mouse, where down is positive.
      let dx = -horiz;
      let dy = vert;
      if (Math.abs(dx) < TILT_DEADZONE_DEG) dx = 0;
      if (Math.abs(dy) < TILT_DEADZONE_DEG) dy = 0;

      // Screen rotation does not rotate the device frame, so landscape would
      // otherwise transpose the axes. The content is rotated by +angle relative
      // to the device, so the tilt vector rotates by -angle to match it.
      const t = (window.screen?.orientation?.angle ?? 0) * D2R;
      const cos = Math.cos(t);
      const sin = Math.sin(t);
      tiltAim.current = {
        x: clamp1((dx * cos - dy * sin) / TILT_FULL_DEG.x),
        y: clamp1((dx * sin + dy * cos) / TILT_FULL_DEG.y),
        live: true,
      };
    };

    window.addEventListener("deviceorientation", onOrient, { passive: true });
    return () => {
      window.removeEventListener("deviceorientation", onOrient);
      tiltAim.current = { x: 0, y: 0, live: false };
    };
  }, [reduced, tiltGranted]);

  const request = useCallback(() => {
    if (typeof window === "undefined" || typeof window.DeviceOrientationEvent === "undefined") {
      return;
    }
    orient.current = { last: null, spikes: 0, samples: [], rest: null };
    const maybe = window.DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<PermissionState>;
    };
    if (typeof maybe.requestPermission !== "function") {
      setTiltGranted(true); // Android: no gate
      return;
    }
    try {
      // Must be the first statement in the gesture handler, anything awaited
      // first burns the transient activation and this rejects.
      maybe
        .requestPermission()
        .then((state) => (state === "granted" ? setTiltGranted(true) : setTiltDenied(true)))
        .catch(() => setTiltDenied(true));
    } catch {
      setTiltDenied(true); // some webviews throw synchronously
    }
  }, []);

  const tilt = useMemo<TiltControl>(
    () => ({
      supported: tiltSupported,
      needsPermission: tiltNeedsPermission,
      granted: tiltGranted,
      denied: tiltDenied,
      request,
    }),
    [tiltSupported, tiltNeedsPermission, tiltGranted, tiltDenied, request],
  );

  const read = useCallback(
    () => {
      if (reduced) return { x: 0, y: 0 };
      // Arbitrate by recency, never sum. On a touch device pointermove only
      // fires while a finger is down, so summing makes the two sources fight
      // the instant someone touches the portrait.
      //
      // The hold expires only when there is a tilt signal to hand over TO. A
      // desktop cursor that has stopped moving has not stopped existing: the
      // gaze should stay on it and let the rig's own idle timer decide when to
      // look away, rather than snapping back to neutral after two seconds. A
      // lifted finger is the exception and it is handled at the source,
      // touchend queues release(), so nothing here has to tell a cursor from a
      // fingertip.
      // performance.now() on BOTH sides. motion's useAnimationFrame reports time
      // since the rig's first frame, so taking the clock from the caller made
      // this comparison cross two origins and `stale` could never fire on time.
      const stale = performance.now() - pointer.current.at >= POINTER_HOLD_MS;
      if (tiltAim.current.live && stale) {
        return { x: tiltAim.current.x, y: tiltAim.current.y };
      }
      if (pointer.current.at > -Infinity) {
        return { x: pointer.current.x, y: pointer.current.y };
      }
      return { x: 0, y: 0 };
    },
    [reduced],
  );

  return { read, tilt, reduced };
}
