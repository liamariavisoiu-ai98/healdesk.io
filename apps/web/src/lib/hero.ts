import manifest from "../../public/hero/hero.json";

/**
 * Geometry for the hero portrait rig, measured by the asset build.
 *
 * Nothing here is hand-tuned. `apps/web/scripts/build-hero-layers.py` measures
 * the fissure and limbus off the photograph and writes them as fractions of the
 * canvas, so the component holds no pixel constants and a new photo re-targets
 * the rig by re-running the script.
 */

export type HeroEye = (typeof manifest.eyes)[number];

const BASE = "/hero/";

export const hero = {
  canvas: manifest.canvas,
  aspect: manifest.canvas.width / manifest.canvas.height,
  // Painted back to front. `follow` is the share of the head's motion each
  // plane takes, the torso is nearly still, the hair in front leads slightly.
  // It is not a z-distance: the parallax models a head turning, not a camera
  // moving, so a body that swung with the head would read as a mannequin.
  planes: manifest.planes.map((p) => ({ src: BASE + p.src, follow: p.follow })),
  eyes: manifest.eyes.map((eye) => {
    // The sprite is square in pixels, so its height as a fraction of the canvas
    // is the width fraction scaled by the canvas aspect.
    const irisW = eye.iris.size;
    const irisH = irisW * (manifest.canvas.width / manifest.canvas.height);
    const [rx, ry, rw, rh] = eye.aperture.rect as [number, number, number, number];
    const [lx, ly, lw, lh] = eye.lid.rect as [number, number, number, number];
    return {
      id: eye.id,
      iris: {
        src: BASE + eye.iris.src,
        // percentage box for the sprite at its rest pose
        left: (eye.rest[0]! - irisW / 2) * 100,
        top: (eye.rest[1]! - irisH / 2) * 100,
        width: irisW * 100,
      },
      // How far the limbus may travel before it reaches a canthus, expressed
      // as a multiple of the sprite's own size, so the rig can drive it with a
      // percentage transform and stay responsive without measuring anything at
      // runtime. The cap is what stops the iris sliding out through the corner.
      travel: {
        x: (eye.travel[0]! / irisW) * 100,
        y: ((eye.travel[1]! * manifest.canvas.height) / (irisW * manifest.canvas.width)) * 100,
      },
      aperture: {
        src: BASE + eye.aperture.src,
        size: `${rw * 100}% ${rh * 100}%`,
        // mask-position is a percentage *of the free space*, not of the box
        position: `${(rx / (1 - rw)) * 100}% ${(ry / (1 - rh)) * 100}%`,
      },
      lid: {
        src: BASE + eye.lid.src,
        left: lx * 100,
        top: ly * 100,
        width: lw * 100,
        // Far enough for the lash line to clear the bottom of the fissure, as a
        // multiple of the sprite's own height so a percentage transform works.
        drop: (eye.lid.drop / lh) * 100,
      },
    };
  }),
};

export type HeroRig = typeof hero;
