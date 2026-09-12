"use client";

import { useEffect, useRef, useState } from "react";
import { useAnimationFrame, useInView, type MotionValue } from "motion/react";

import { useGazeRig } from "@/lib/useGazeRig";
import { usePointerField, type TiltControl } from "@/lib/usePointerField";

/**
 * The mesh renderer: one model, lit and turned in real time.
 *
 * The two renderers next door both answer "which way is she looking?" by
 * picking from something pre-rendered, a cell of a photographed grid, or a
 * stack of 2.5D sprites. Both are bounded by their source. `HeroFrames` says
 * so itself: five columns is five photographs, and between two of them there
 * is nothing but a cross-fade that double-exposes the pupils. The grid cannot
 * be made denser without a longer clip, and the clip is five seconds long.
 *
 * A mesh has no cells. Every angle is a render, so the ceiling those two are
 * pressed against is simply not here, and `useGazeRig` can finally run the
 * continuous motion it was written for, the thing HeroFrames had to switch off
 * (`TRACKING = "direct"`) because a 5x3 grid landed its delays as "nothing,
 * nothing, nothing, then a different photograph".
 *
 * ## What this asset can and cannot do, which decided the whole design
 *
 * The source is `public/hero-3d/ava.glb`, converted from a 1.6M-triangle OBJ
 * bust. It is a SINGLE FUSED MESH with no skeleton: OBJ and STL cannot carry
 * one, and nothing in the export invented it. So there are no head joints to
 * rotate and no eye joints to aim, and there are no blend shapes either.
 *
 * That rules out two of the rig's seven signals outright:
 *
 *   `gazeX/gazeY`  the eyes are geometry fused into the face, sharing one UV
 *                  atlas with it. Nothing can aim them.
 *   `blink`        same: no lids to close, no morph target to drive.
 *
 * It does NOT rule out the head, which is the signal this file exists to
 * render, and which it gets by bending the mesh rather than by rotating a bone
 * it does not have, see `bendShader` below.
 *
 * The consequence to know before tuning anything here: with no eyes to move,
 * the head has to carry the WHOLE gesture. In a rigged face the head takes
 * `HEAD_GAZE_SHARE` of it (0.35) and the eyes take the rest, so head amplitude
 * is deliberately small. Here 0.35 of a gesture is all there is, which is why
 * `YAW_DEG` below is large for a head turn, and why the rig is asked for
 * `follow: "smooth"` rather than the default `"ocular"`: ocular mode's
 * exaggerated eye-head lag exists to make the eyes-lead-head ORDERING legible,
 * and with no eyes to lead there is no ordering, only a head that answers late.
 *
 * ## Her rest pose is turned, on purpose
 *
 * The model's eyes are baked looking ~32 degrees off its own forward axis. A
 * mesh sat square to the camera therefore stares permanently past the viewer's
 * shoulder, and no amount of head-turning fixes it, because the offset turns
 * with the head. `REST_YAW_DEG` cancels it: the body is parked at the angle
 * where the baked gaze lands on the lens, so at rest she is looking at you, and
 * the cursor moves her around THAT. It is also just a better portrait than
 * square-on, which is the pose the layered renderer's own notes argue for.
 */

/** Where `public/hero-3d/ava.glb` came from, so the next person does not have
 *  to re-derive a pipeline from a 177MB file:
 *
 *    AYA.obj (800k verts / 1.6M tris, no mtllib)
 *      + an MTL naming the 4K diffuse, and a `usemtl` before the first face
 *      -> obj2gltf                       66MB
 *      -> gltfpack -si 0.02 -cc          4.9MB, 364k tris
 *
 *  Two things about that are not arbitrary. The diffuse is resampled to 2048
 *  and saved as JPEG (815KB of the 4.9MB); the normal/roughness/metallic maps
 *  are DROPPED, because the metallic map's range is 0-16/255, i.e. flat
 *  dielectric, and the diffuse already carries its lighting baked in.
 *
 *  And the triangle count has a floor that is not worth fighting. `-si 0.02`
 *  asks for 2% and lands at 364k, roughly 23%, because the atlas this model
 *  ships is shattered into hundreds of tiny islands and meshoptimizer will not
 *  collapse across a UV seam. Adding `-sa` lets it, and the result is a face
 *  with texture islands dragged across it in visible streaks. Going lower
 *  needs a UV re-atlas and a texture re-bake, not a flag. */
const MODEL_URL = "/hero-3d/ava.glb";

/**
 * Cancels the model's baked gaze offset, see the header. Measured, not guessed:
 * orbiting a camera around the bust and reading off the angle at which the
 * irises centre on the lens puts it between -30 and -35 degrees, and a camera
 * orbited by -32 is the same view as a model turned by +32.
 */
const REST_YAW_DEG = 32;

/**
 * Head travel at full pointer deflection.
 *
 * Large for a head, for the reason in the header: the eyes cannot move, so the
 * head is the entire gesture rather than `HEAD_GAZE_SHARE` of it. Yaw runs
 * further than pitch because a neck does, and because the stage is wider than
 * it is tall, so horizontal cursor travel is the axis the visitor actually
 * exercises.
 *
 * The ceiling on both is her own face: past roughly 26 degrees of yaw the far
 * eye starts to disappear behind the bridge of her nose and the baked gaze
 * stops reading as gaze at all.
 */
const YAW_DEG = 21;
const PITCH_DEG = 11;

/**
 * Where the bend starts and ends, and where it pivots, as fractions of the
 * bust's own height. Fractions rather than model units so a re-export at a
 * different scale does not silently move the pivot into her jaw.
 *
 * Measured off an orthographic render with a known Y mapping: chin 0.50, neck
 * 0.42-0.50, shoulders ~0.36, eyes 0.70. So the ramp spans shoulders to
 * mid-skull and the pivot sits at the top of the spine, a little under the
 * chin, which is where a real head turns from.
 */
const BEND_LO = 0.36;
const BEND_HI = 0.6;
const PIVOT_Y = 0.52;

/** Breath, as a fraction of bust height. Tiny on purpose: it is there so she is
 *  never perfectly frozen between cursor moves, not to be seen as breathing. */
const BREATH_AMP = 0.004;

/** Vertical fov and framing. A long lens, because a wide one at portrait
 *  distance bulges the nose, which is the single most common way a 3D hero
 *  reads as a video game character. */
const FOV = 20;
/** Fraction of the frame's height the bust fills, and where its centre sits.
 *  Below 0.5 lifts the face into the upper third and leaves the tank top
 *  running off the bottom edge, which is the crop the layered portrait masks
 *  to and the composition the stage's copy block is laid out against. */
const FILL = 0.92;
const CENTER_Y = 0.46;

/** Canvas aspect. Matches the layered portrait's 3:4 source so the two are
 *  interchangeable inside the same `PORTRAIT_SIZE` box in HeroStage. */
const ASPECT = 3 / 4;

/** Retina costs 4x the fragments for a model this smooth. 2 is plenty and 3 is
 *  a phone heating up for nothing. */
const MAX_DPR = 2;

/** Same treatment, and the same numbers, as the layered portrait's bottom cut.
 *  See the render site for why it is one mask over the result. */
const BOTTOM_FADE = "linear-gradient(to bottom, #000 76%, transparent 99%)";

/**
 * The bend, which is what stands in for the skeleton this asset does not have.
 *
 * A hard split, head mesh here, body mesh there, is the obvious way to turn a
 * head without bones and it does not survive contact with this model: her hair
 * falls PAST her shoulders, so any cut that frees the head either tears the
 * hair or leaves it behind, and either way the neck opens a gap the moment she
 * turns.
 *
 * So nothing is cut. Every vertex gets a weight from its height, 0 at the
 * shoulders and 1 at the skull, and is rotated about the neck pivot by that
 * fraction of the head's rotation. Because the weight is continuous, the
 * surface stays continuous by construction: there is no seam to open, the neck
 * twists instead of hinging, and the hair on her shoulders stays on her
 * shoulders while the hair on her head goes with it. Which is what hair does.
 *
 * Patched into `MeshStandardMaterial` rather than replaced with a
 * `ShaderMaterial`, so the model keeps three's lighting, tone mapping and
 * colour management instead of this file re-deriving them. The two injection
 * points are both inside `main()`, so `hdRot` computed at the first is still in
 * scope at the second, and the normal has to be rotated by the same matrix as
 * the position or she lights as though her head never moved.
 */
const BEND_PARS = /* glsl */ `
  uniform float uYaw;
  uniform float uPitch;
  uniform float uRoll;
  uniform float uBendLo;
  uniform float uBendHi;
  uniform vec3  uPivot;

  mat3 hdBendMatrix(float y) {
    float w = smoothstep(uBendLo, uBendHi, y);
    float ya = uYaw * w, pa = uPitch * w, ra = uRoll * w;
    float cy = cos(ya), sy = sin(ya);
    float cp = cos(pa), sp = sin(pa);
    float cr = cos(ra), sr = sin(ra);
    mat3 Ry = mat3( cy, 0.0, -sy,  0.0, 1.0, 0.0,   sy, 0.0,  cy);
    mat3 Rx = mat3(1.0, 0.0, 0.0,  0.0,  cp,  sp,  0.0, -sp,  cp);
    mat3 Rz = mat3( cr,  sr, 0.0,  -sr,  cr, 0.0,  0.0, 0.0, 1.0);
    return Ry * Rx * Rz;
  }
`;

export function HeroModel({
  className = "",
  onTiltAvailable,
  gazeBiasY,
}: {
  className?: string;
  onTiltAvailable?: (tilt: TiltControl) => void;
  /** The scroll hand-off's downward glance, in the same units HeroFrames takes
   *  it in: a bias added to vertical aim as the stage shrinks toward the demo.
   *  Unlike the frame grid, which has no row below level to travel onto, a mesh
   *  can actually look down, so this one lands as the gesture it was written
   *  to be. */
  gazeBiasY?: MotionValue<number>;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inView = useInView(stageRef, { margin: "150px" });
  const field = usePointerField(stageRef);
  const [ready, setReady] = useState(false);

  // `idleMotion` and `gazeBreak` are both ON, and the second one is the
  // interesting choice. GazeRigOptions says a break is affordable only where
  // the renderer can hide its onset and return behind a blink, and this
  // renderer cannot blink at all. The rule still holds, because of WHY it was
  // written: for a frame grid a look-away is a CUT between two photographs, and
  // the blink is what hides the cut. A mesh does not cut. It turns, on every
  // frame in between, so there is nothing to hide and the break reads as what
  // it is, which is a person glancing away from an eight-second stare.
  const { headX, headY, roll, breath } = useGazeRig(field, inView, {
    follow: "smooth",
    idleMotion: true,
    gazeBreak: true,
  });

  useEffect(() => {
    onTiltAvailable?.(field.tilt);
  }, [field.tilt, onTiltAvailable]);

  // Everything three.js touches lives in here, and the loop below only writes
  // numbers into it. Held in a ref rather than state because a render caused by
  // the scene arriving would tear down nothing and rebuild nothing, it would
  // just cost a render.
  const gl = useRef<{
    dispose: () => void;
    resize: () => void;
    render: () => void;
    /** Reads and clears the "something other than the rig changed" flag: a
     *  resize, the model arriving, a restored GL context. */
    takeDirty: () => boolean;
    markDirty: () => void;
    uniforms: {
      uYaw: { value: number };
      uPitch: { value: number };
      uRoll: { value: number };
    };
    setLift: (y: number) => void;
  } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = stageRef.current;
    if (!canvas || !host) return;

    let disposed = false;

    // Dynamic import, so three (and the 4.9MB model behind it) stay out of the
    // server render and out of the initial bundle. The hero is above the fold,
    // so this does cost a round trip before she appears; the alternative costs
    // every visitor the parse of a 3D engine before the page is interactive,
    // including the ones who bounce.
    void (async () => {
      const THREE = await import("three");
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
      const { MeshoptDecoder } = await import(
        "three/examples/jsm/libs/meshopt_decoder.module.js"
      );
      const { RoomEnvironment } = await import(
        "three/examples/jsm/environments/RoomEnvironment.js"
      );
      if (disposed) return;

      // `alpha`, and NOT a background colour matching the paper. HeroStage's
      // own notes call `--color-paper` a cross-cutting constant because every
      // baked hero asset is keyed to its exact value and silently un-mattes
      // when the palette moves, which has already happened once. A transparent
      // canvas cannot have that bug: there is no second white to disagree with
      // the first, the page's paper simply shows through.
      const renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
        powerPreference: "high-performance",
      });
      renderer.setClearAlpha(0);
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      // Deliberately under 1, and the rest of the lighting below is deliberately
      // dim, because this texture is NOT an albedo map. It is photogrammetry
      // output with its lighting already baked in, so every lumen added here
      // lands on top of a face that is already lit. Lighting it as though it
      // were albedo (an env map plus a 2.2 key plus a 0.5 ambient, which is the
      // default-looking setup anyone would reach for first) blows the forehead
      // and cheekbones to paper white and flattens the face into a sticker.
      //
      // What the lights are still FOR, given that: the bend turns her head, and
      // a head that turns under no directional light at all shows no change in
      // shading as it goes, which reads as a picture being rotated rather than
      // a person turning. The key is here to make the turn legible, not to
      // illuminate her.
      renderer.toneMappingExposure = 0.92;

      const scene = new THREE.Scene();
      const pmrem = new THREE.PMREMGenerator(renderer);
      const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
      scene.environment = envRT.texture;
      scene.environmentIntensity = 0.55;
      const key = new THREE.DirectionalLight(0xffffff, 0.85);
      key.position.set(1, 2, 2.5);
      scene.add(key);
      scene.add(new THREE.AmbientLight(0xffffff, 0.22));

      const camera = new THREE.PerspectiveCamera(FOV, ASPECT, 0.01, 100);

      const uniforms = {
        uYaw: { value: 0 },
        uPitch: { value: 0 },
        uRoll: { value: 0 },
        uBendLo: { value: 0 },
        uBendHi: { value: 0 },
        uPivot: { value: new THREE.Vector3() },
      };

      const root = new THREE.Group();
      root.rotation.y = (REST_YAW_DEG * Math.PI) / 180;
      scene.add(root);

      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);

      let model: import("three").Object3D | null = null;
      // The framing offset, captured once she is framed. `setLift` adds breath
      // to THIS rather than assigning into `root.position.y` directly, which
      // would otherwise throw the framing away on the first animation frame.
      const baseY = { value: 0 };
      const dirty = { value: true };

      // Browsers drop a GL context whenever they feel like it: a backgrounded
      // tab on a laptop that slept, a GPU driver reset, too many live contexts
      // across tabs. The default response is a canvas that stays blank forever.
      // preventDefault is what asks for it back, and three re-uploads the
      // geometry and textures itself on restore; all this has to do is ask for
      // one more draw, because the rig may well be sitting perfectly still and
      // the dirty check would otherwise never schedule one.
      canvas.addEventListener("webglcontextlost", (e) => e.preventDefault());
      canvas.addEventListener("webglcontextrestored", () => {
        dirty.value = true;
      });

      loader.load(
        MODEL_URL,
        (gltf) => {
          if (disposed) {
            renderer.dispose();
            return;
          }
          model = gltf.scene;

          // gltfpack quantises positions and hands back the dequantising scale
          // on the NODE, so `position.y` inside the vertex shader is in
          // quantised units, not model units, and a pivot expressed in model
          // units would land somewhere arbitrary. Baking each node's world
          // matrix into its geometry makes the two the same space again, which
          // is what lets the bend be written in terms of the bust's own height.
          //
          // The de-quantise step before it is NOT optional, and it fails
          // silently without it. `-cc` leaves position and normal as normalised
          // integers in an interleaved buffer, and `applyMatrix4` writes the
          // transformed floats straight back into whatever array it was handed:
          // into an Int16Array every coordinate truncates toward zero, and the
          // bust collapses into an invisible speck at the origin. Rebuilding
          // both attributes as plain Float32 first costs one pass over ~530k
          // vertices, once, and is the difference between a hero and a blank
          // canvas with no error in the console.
          //
          // Only position and normal. UVs stay quantised because nothing here
          // needs them in model space, and they are half the saving.
          const toFloat = (attr: import("three").BufferAttribute | import("three").InterleavedBufferAttribute) => {
            const out = new Float32Array(attr.count * attr.itemSize);
            for (let i = 0; i < attr.count; i++) {
              for (let j = 0; j < attr.itemSize; j++) {
                out[i * attr.itemSize + j] = attr.getComponent(i, j);
              }
            }
            return new THREE.BufferAttribute(out, attr.itemSize);
          };

          model.updateWorldMatrix(true, true);
          model.traverse((o) => {
            const mesh = o as import("three").Mesh;
            if (!mesh.isMesh) return;
            const geom = mesh.geometry;
            for (const name of ["position", "normal"] as const) {
              const attr = geom.getAttribute(name);
              if (attr) geom.setAttribute(name, toFloat(attr));
            }
            geom.applyMatrix4(mesh.matrixWorld);
            mesh.position.set(0, 0, 0);
            mesh.rotation.set(0, 0, 0);
            mesh.scale.set(1, 1, 1);
            mesh.frustumCulled = false;
          });
          model.position.set(0, 0, 0);
          model.rotation.set(0, 0, 0);
          model.scale.set(1, 1, 1);

          const box = new THREE.Box3().setFromObject(model);
          const size = box.getSize(new THREE.Vector3());
          const center = box.getCenter(new THREE.Vector3());
          const h = size.y;

          uniforms.uBendLo.value = box.min.y + h * BEND_LO;
          uniforms.uBendHi.value = box.min.y + h * BEND_HI;
          uniforms.uPivot.value.set(center.x, box.min.y + h * PIVOT_Y, center.z);

          model.traverse((o) => {
            const mesh = o as import("three").Mesh;
            if (!mesh.isMesh) return;
            const mat = mesh.material as import("three").MeshStandardMaterial;
            mat.onBeforeCompile = (shader) => {
              Object.assign(shader.uniforms, uniforms);
              shader.vertexShader = shader.vertexShader
                .replace("#include <common>", `#include <common>\n${BEND_PARS}`)
                .replace(
                  "#include <beginnormal_vertex>",
                  `#include <beginnormal_vertex>
                   mat3 hdRot = hdBendMatrix(position.y);
                   objectNormal = hdRot * objectNormal;`,
                )
                .replace(
                  "#include <begin_vertex>",
                  `#include <begin_vertex>
                   transformed = hdRot * (transformed - uPivot) + uPivot;`,
                );
            };
            // three caches compiled programs by a key that does not include the
            // body of onBeforeCompile, so a material that shares a key with an
            // unpatched one would silently get the unpatched program.
            mat.customProgramCacheKey = () => "hero-model-bend";
            mat.needsUpdate = true;
          });

          // Frame it: put the bust's centre on the camera axis, back off until
          // it fills FILL of the frame, then slide the whole thing down so the
          // face lands in the upper third rather than dead centre.
          const visible = h / FILL;
          const dist = visible / 2 / Math.tan(((FOV / 2) * Math.PI) / 180);
          model.position.set(-center.x, -center.y, -center.z);
          root.add(model);
          root.position.y = h * (CENTER_Y - 0.5);
          baseY.value = root.position.y;
          camera.position.set(0, 0, dist);
          camera.lookAt(0, 0, 0);

          dirty.value = true;
          setReady(true);
        },
        undefined,
        () => {
          // A hero that throws on a failed fetch takes the page with it. Leaving
          // `ready` false keeps the stage empty, which is the same thing the
          // visitor sees for the first second anyway.
        },
      );

      const api = {
        uniforms,
        setLift: (y: number) => {
          root.position.y = baseY.value + y;
        },
        takeDirty: () => {
          const was = dirty.value;
          dirty.value = false;
          return was;
        },
        markDirty: () => {
          dirty.value = true;
        },
        resize: () => {
          const w = host.clientWidth;
          const hgt = host.clientHeight;
          if (!w || !hgt) return;
          renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DPR));
          renderer.setSize(w, hgt, false);
          camera.aspect = w / hgt;
          camera.updateProjectionMatrix();
          dirty.value = true;
        },
        render: () => renderer.render(scene, camera),
        dispose: () => {
          envRT.dispose();
          pmrem.dispose();
          model?.traverse((o) => {
            const mesh = o as import("three").Mesh;
            if (!mesh.isMesh) return;
            mesh.geometry.dispose();
            const mat = mesh.material as import("three").MeshStandardMaterial;
            mat.map?.dispose();
            mat.dispose();
          });
          renderer.dispose();
        },
      };
      gl.current = api;
      api.resize();
    })();

    const ro = new ResizeObserver(() => gl.current?.resize());
    ro.observe(host);

    return () => {
      disposed = true;
      ro.disconnect();
      gl.current?.dispose();
      gl.current = null;
    };
  }, []);

  // One rAF for the whole renderer, and it draws as little as it can get away
  // with. Two separate guards, doing two different jobs:
  //
  //   `inView`  a hero still drawing 364k triangles while the visitor reads the
  //             pricing section is a fan that never spins down.
  //   `dirty`   even in view, most frames change nothing worth a draw. This
  //             matters most under reduced motion, where the rig pins the head
  //             at 0 and the only thing left moving is breath, which is then
  //             suppressed below: that case settles to ZERO draws per second
  //             rather than 60 draws of an identical image.
  //
  // The thresholds are sized in the units they guard: 2e-4 rad is about a
  // hundredth of a degree of head turn, which at this framing is well under a
  // tenth of a pixel at the ear.
  const last = useRef({ yaw: NaN, pitch: NaN, roll: NaN, lift: NaN });

  // Coming back into view needs one forced draw. The loop is idle-skipping on
  // unchanged rig values, and a WebGL drawing buffer is not guaranteed to
  // survive being scrolled away and back (the compositor may discard it after
  // presenting, which is what `preserveDrawingBuffer: false` buys), so without
  // this she can scroll back on as an empty rectangle and stay that way for as
  // long as the visitor holds still.
  useEffect(() => {
    if (inView) gl.current?.markDirty();
  }, [inView]);

  useAnimationFrame(() => {
    const api = gl.current;
    if (!api || !ready || !inView) return;

    const hx = headX.get();
    const hy = headY.get() + (gazeBiasY?.get() ?? 0);

    const yaw = (hx * YAW_DEG * Math.PI) / 180;
    const pitch = (hy * PITCH_DEG * Math.PI) / 180;
    const rl = (roll.get() * Math.PI) / 180;
    // Breath is the one signal the rig keeps running under reduced motion (at
    // half amplitude). It is a deliberate exception there for renderers where
    // it is sub-pixel, and here it would be the only reason to ever redraw, so
    // it goes. A visitor who asked for less motion gets a still portrait.
    const lift = field.reduced ? 0 : breath.get() * BREATH_AMP;

    // Read FIRST and unconditionally, so the flag is always consumed by the
    // frame it applies to. Left inside the `&&` chain it would be short-
    // circuited away on any frame the head happened to be moving, and would
    // then force one more redundant draw at some arbitrary later moment.
    const forced = api.takeDirty();
    const l = last.current;
    if (
      !forced &&
      Math.abs(yaw - l.yaw) < 2e-4 &&
      Math.abs(pitch - l.pitch) < 2e-4 &&
      Math.abs(rl - l.roll) < 2e-4 &&
      Math.abs(lift - l.lift) < 1e-5
    )
      return;
    last.current = { yaw, pitch, roll: rl, lift };

    api.uniforms.uYaw.value = yaw;
    api.uniforms.uPitch.value = pitch;
    api.uniforms.uRoll.value = rl;
    api.setLift(lift);
    api.render();
  });

  return (
    <div
      ref={stageRef}
      className={`relative select-none ${className}`}
      style={{
        aspectRatio: `${ASPECT}`,
        // The bust is cut off square at the bottom of its own canvas, the same
        // problem the layered portrait solves the same way. One mask over the
        // composited result rather than a fade baked into the model, for the
        // reason HeroPortrait spells out: per-layer alpha compounds, and here
        // there is the additional point that a fade baked into the TEXTURE
        // would have to know the paper colour, which is exactly the coupling
        // the transparent canvas above exists to avoid.
        maskImage: BOTTOM_FADE,
        WebkitMaskImage: BOTTOM_FADE,
      }}
    >
      <canvas
        ref={canvasRef}
        aria-label="A receptionist looking towards you"
        role="img"
        className="h-full w-full"
        // Faded in rather than popped in. The model arrives a beat after the
        // rest of the hero no matter what, so the choice is between a picture
        // that appears and one that materialises.
        style={{
          opacity: ready ? 1 : 0,
          transition: "opacity 420ms ease-out",
        }}
      />
    </div>
  );
}
