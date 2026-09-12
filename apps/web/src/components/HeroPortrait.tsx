"use client";

import { useEffect, useRef } from "react";
import { motion, useInView, useTransform, type MotionValue } from "motion/react";

import { hero, type HeroRig } from "@/lib/hero";
import { useGazeRig } from "@/lib/useGazeRig";
import { usePointerField, type TiltControl } from "@/lib/usePointerField";

/**
 * The layered portrait: 2.5D planes driven by the shared oculomotor rig.
 *
 * The timing model lives in `useGazeRig`. This file is only the renderer, and
 * it translates sprites. `HeroFrames` is the same rig rendered a different way.
 *
 * Plane displacement is deliberately *small*, and the spread between planes
 * smaller still. The instinct is to separate them hard, but a real head is only
 * ~100mm deep at portrait distance, and more importantly these planes each
 * redraw content the others also carry, the chest hair appears in all three.
 * A wide spread drags those duplicates apart into a visible translucent ghost.
 */

/** Displacement at full deflection, as a percent of the canvas box. Held in
 *  percentages so the rig stays correct at any rendered size. */
const FACE_PCT = { x: 1.33, y: 0.41 };
const BREATH_PCT = 0.18;

/** Index of the plane carrying the face, the eye rig mounts inside it. */
const FACE_PLANE = hero.planes.findIndex((p) => p.follow === 1);

const BOTTOM_FADE = "linear-gradient(to bottom, #000 76%, transparent 99%)";

export function HeroPortrait({
  className = "",
  onTiltAvailable,
}: {
  className?: string;
  onTiltAvailable?: (tilt: TiltControl) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const inView = useInView(stageRef, { margin: "150px" });
  const field = usePointerField(stageRef);
  const { gazeX, gazeY, headX, headY, roll, blink, breath } = useGazeRig(field, inView);

  useEffect(() => {
    onTiltAvailable?.(field.tilt);
  }, [field.tilt, onTiltAvailable]);

  return (
    <div
      ref={stageRef}
      className={`relative select-none ${className}`}
      style={{
        aspectRatio: `${hero.canvas.width} / ${hero.canvas.height}`,
        // Her tank top runs straight off the bottom of the canvas, and the
        // scroll rig shrinks her until that cut is on screen as a hard edge.
        //
        // Applied HERE, to the composited subtree, and deliberately not baked
        // into each plane's alpha. Fading the planes individually looks
        // equivalent and is not: alpha compounds, so a region painted by one
        // plane (the hair over her chest) ends up far more transparent than one
        // painted by three (the chest itself), and the hair turns into a
        // translucent ghost lying over her top. One mask over the result has no
        // such asymmetry. A single gradient also avoids `mask-composite`, which
        // Safari only speaks through a prefix with different keywords.
        maskImage: BOTTOM_FADE,
        WebkitMaskImage: BOTTOM_FADE,
      }}
    >
      {hero.planes.map((plane, i) => (
        <Plane
          key={plane.src}
          plane={plane}
          headX={headX}
          headY={headY}
          breath={breath}
          roll={roll}
          alt={i === FACE_PLANE ? "A receptionist looking towards you" : ""}
          priority={i === FACE_PLANE}
        >
          {/* The eye rig lives inside the face plane so it inherits that
              plane's transform and can never drift off her face. */}
          {i === FACE_PLANE
            ? hero.eyes.map((eye) => (
                <Eye key={eye.id} eye={eye} gazeX={gazeX} gazeY={gazeY} blink={blink} />
              ))
            : null}
        </Plane>
      ))}
    </div>
  );
}

/** One parallax plane. `follow` scales every channel, so a plane that takes a
 *  smaller share of the head's motion also rolls and breathes less. */
function Plane({
  plane,
  headX,
  headY,
  breath,
  roll,
  alt,
  priority,
  children,
}: {
  plane: HeroRig["planes"][number];
  headX: MotionValue<number>;
  headY: MotionValue<number>;
  breath: MotionValue<number>;
  roll: MotionValue<number>;
  alt: string;
  priority: boolean;
  children?: React.ReactNode;
}) {
  const f = plane.follow;
  const x = useTransform(headX, (n) => `${n * FACE_PCT.x * f}%`);
  const y = useTransform(
    [headY, breath],
    ([h, b]: number[]) => `${((h ?? 0) * FACE_PCT.y - (b ?? 0) * BREATH_PCT) * f}%`,
  );
  const rotate = useTransform(roll, (n) => n * f);

  return (
    <motion.div className="absolute inset-0" style={{ x, y, rotate }} aria-hidden={!alt}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={plane.src}
        alt={alt}
        className="absolute inset-0 h-full w-full"
        draggable={false}
        {...(priority ? { fetchPriority: "high" as const } : {})}
      />
      {children}
    </motion.div>
  );
}

function Eye({
  eye,
  gazeX,
  gazeY,
  blink,
}: {
  eye: HeroRig["eyes"][number];
  gazeX: MotionValue<number>;
  gazeY: MotionValue<number>;
  blink: MotionValue<number>;
}) {
  const x = useTransform(gazeX, (n) => `${n * eye.travel.x}%`);
  const y = useTransform(gazeY, (n) => `${n * eye.travel.y}%`);
  const lidY = useTransform(blink, (n) => `${n * eye.lid.drop}%`);
  // Hidden unless a blink is actually running. At rest the lid sprite is a copy
  // of the pixels directly beneath it, so it *should* be invisible, but it is
  // scaled and positioned independently of the plane it sits on, and half a
  // pixel of resampling difference draws a faint rectangular seam around the
  // eye. It only has a job during the ~275ms of a blink, so it only exists then.
  const lidOn = useTransform(blink, (n) => Math.min(1, n * 8));

  return (
    <div className="absolute inset-0" aria-hidden>
      {/* The aperture mask is the eyeball opening cut from the photograph, so a
          travelling iris clips under the lid and lashes exactly the way the
          real one does, and cannot escape through the corner of the eye. */}
      <div
        className="absolute inset-0"
        style={{
          maskImage: `url(${eye.aperture.src})`,
          WebkitMaskImage: `url(${eye.aperture.src})`,
          maskSize: eye.aperture.size,
          WebkitMaskSize: eye.aperture.size,
          maskPosition: eye.aperture.position,
          WebkitMaskPosition: eye.aperture.position,
          maskRepeat: "no-repeat",
          WebkitMaskRepeat: "no-repeat",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <motion.img
          src={eye.iris.src}
          alt=""
          draggable={false}
          className="absolute"
          style={{
            left: `${eye.iris.left}%`,
            top: `${eye.iris.top}%`,
            width: `${eye.iris.width}%`,
            x,
            y,
          }}
        />
      </div>

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <motion.img
        src={eye.lid.src}
        alt=""
        draggable={false}
        className="absolute"
        style={{
          left: `${eye.lid.left}%`,
          top: `${eye.lid.top}%`,
          width: `${eye.lid.width}%`,
          y: lidY,
          opacity: lidOn,
        }}
      />
    </div>
  );
}
