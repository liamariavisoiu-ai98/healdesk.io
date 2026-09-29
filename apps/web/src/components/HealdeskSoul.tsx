"use client";

import { useEffect, useRef, useState } from "react";
import { useInView } from "motion/react";

import { SOUL_FRAGMENT, SOUL_VERTEX } from "@/lib/soul-shader";

/**
 * The soul: the orb that stands in for the agent in each demo panel header.
 *
 * It replaced a chat-bubble glyph and a telephone glyph, which were two marks
 * for one thing. There is exactly one of these per panel and it lives in the
 * header, never in the thread: an orb inside a message bubble is a piece of
 * chrome pretending to be a message, and it moved the reader's eye to the wrong
 * place every time she started composing.
 *
 * ## It is drawn, not played
 *
 * The orb is a WebGL fragment shader (`lib/soul-shader.ts`), rendered into a
 * canvas the size of the box at device resolution. It used to be a 384px
 * video clip, and at 72px on a retina panel that clip was a blurred gradient
 * with compression blocking in it and no rim: a fixed number of soft pixels
 * being stretched, which no re-encode fixes. The shader has an exact edge and
 * an exact highlight at any size, and costs no download.
 *
 * ## It is always alive
 *
 * The heartbeat and the interior motion run from first paint and never stop,
 * whether or not anybody has touched the panel. That is the point of it. A
 * status light that only lights up once you have interacted is a status light
 * that tells you nothing on arrival, which is the moment that matters.
 *
 * ## What changes is the tempo, and it is measured rather than guessed
 *
 * `beatMs` is the length of one heartbeat, and the two panels compute it from
 * what is actually happening:
 *
 *   chat   the rolling average gap between streamed chunks, so the orb races
 *          when the answer pours in and settles when it trickles
 *   voice  the current line's word count against the time it is on screen, so
 *          a dense sentence beats faster than a short one
 *
 * The CSS heartbeat reads `--soul-beat` directly. The shader gets the same
 * number as a speed multiplier on its clock, plus an energy level from the
 * mode, and eases toward both so a state change never snaps.
 *
 * ## Three layers, because one element cannot hold two transforms
 *
 *   __aura    a flowing body around the sphere, breathing a beat behind it
 *   __beat    the heartbeat, scaling
 *   __orb     the canvas, or the poster where the canvas cannot run
 *
 * The specular, the rim light and the edge all live inside the shader now, so
 * the mask and the fixed-sheen overlay the video needed are gone. See the note
 * in globals.css for what each of those used to do and why neither is missed.
 *
 * ## When the canvas does not run
 *
 * Three cases, one answer: `/brand/healdesk-soul.png`, a frame of this exact
 * shader rendered at 512px with alpha by `scripts/render-soul-poster.mjs`.
 *
 *   before hydration     the server cannot open a GL context, so the markup
 *                        carries the poster and the client swaps it for the
 *                        canvas on mount; the first frame matches the poster,
 *                        so the swap is invisible
 *   reduced motion       the canvas draws one frame and stops. A still orb is
 *                        the right outcome: it is a status light, and a still
 *                        one still says which panel you are in
 *   no WebGL             the poster stays
 *
 * The loop also stops while the panel is off screen or the tab is hidden. Two
 * of these run on a page that also streams text and turns a 364k-triangle
 * head; they should cost nothing while nobody is looking at them.
 */

export type SoulMode = "idle" | "typing" | "voice";

const MODE_CLASS: Record<SoulMode, string> = {
  idle: "soul--idle",
  typing: "soul--typing",
  voice: "soul--voice",
};

/**
 * How much is going on inside the ball, per state. Idle is low: warm and
 * slow, weather rather than fire. Speech is higher than thought, because it
 * pushes more energy out than composing does, which is the same reasoning
 * behind the aura reaching further in the voice state.
 */
const MODE_ENERGY: Record<SoulMode, number> = {
  idle: 0.18,
  typing: 0.62,
  voice: 0.85,
};

/** The resting heartbeat, matching `--soul-beat` in globals.css. */
const IDLE_BEAT_MS = 3500;

/**
 * Device pixels per CSS pixel to render at. Capped at 3, and with a little
 * headroom over the true ratio because the heartbeat scales the canvas up by
 * as much as 14% and a texture upscaled by the compositor goes soft exactly
 * on the rim the shader worked to keep sharp. At 72px that is a 260px canvas,
 * which is nothing.
 */
const DPR_HEADROOM = 1.2;
const DPR_MAX = 3;

const POSTER = "/brand/healdesk-soul.png";

export function HealdeskSoul({
  mode = "idle",
  beatMs,
  size = 26,
  className = "",
  label,
}: {
  mode?: SoulMode;
  /**
   * One heartbeat, in milliseconds.
   *
   * Omitted in the idle state, where the CSS default is a calm resting rate.
   * Supplied while she is working, from whatever the panel can measure.
   */
  beatMs?: number;
  /** Rendered size in px. The shader is resolution-independent. */
  size?: number;
  className?: string;
  /**
   * What a screen reader should hear, if anything.
   *
   * Silent at rest: the heading beside it already says "Web chat" or "Phone
   * call", and an orb announcing itself as well is noise. It speaks up only
   * while she is composing or talking, which is a state nothing else on screen
   * reports now that the thread no longer shows a placeholder bubble.
   */
  label?: string;
}) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Start on the poster and swap to the canvas after mount: the server has no
  // GL and no idea what the reader prefers, so rendering a <canvas> in the
  // markup would mean tearing it out again on hydration for anyone without
  // WebGL. `gl` becomes false the moment a context cannot be created.
  const [mounted, setMounted] = useState(false);
  const [gl, setGl] = useState(true);
  const [still, setStill] = useState(false);
  // Bumped when a lost context is restored, so the GL effect runs again on
  // the same canvas. Unmounting the canvas on loss, which is what an earlier
  // version did, removed the element the restore event would have fired on,
  // and the orb stayed on the poster for the rest of the visit.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    setMounted(true);
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setStill(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  // A little past the viewport, so the orb is already moving as the panel
  // scrolls in rather than starting on arrival.
  const inView = useInView(rootRef, { margin: "120px" });

  // Everything the render loop reads, as refs rather than dependencies. The
  // tempo changes on every streamed chunk, and scrolling the panel in and out
  // flips `inView`; neither should re-run the GL effect, which would rebuild
  // the program and reset the clock to zero, a visible jump in the weather
  // each time the reader scrolled back up.
  const live = useRef({ energy: MODE_ENERGY.idle, speed: 1, still: false, inView: false });
  live.current.energy = MODE_ENERGY[mode];
  // Tempo relative to rest. A streamed answer can put beatMs in the low
  // hundreds, which as a raw ratio is a blur; the clamp keeps "fast" legible.
  live.current.speed = beatMs
    ? Math.min(3, Math.max(0.6, IDLE_BEAT_MS / Math.max(beatMs, 1)))
    : 1;
  live.current.still = still;
  live.current.inView = inView;

  // The loop's start/stop, handed out by the GL effect so that the cheap
  // effect below can poke it when visibility or the motion preference change.
  const controls = useRef<(() => void) | null>(null);
  useEffect(() => {
    controls.current?.();
  }, [still, inView]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !mounted || !gl) return;

    const context =
      canvas.getContext("webgl", { alpha: true, antialias: false, premultipliedAlpha: true }) ??
      (canvas.getContext("experimental-webgl", {
        alpha: true,
        antialias: false,
        premultipliedAlpha: true,
      }) as WebGLRenderingContext | null);
    if (!context) {
      setGl(false);
      return;
    }
    const g = context;

    const program = buildProgram(g, SOUL_VERTEX, SOUL_FRAGMENT);
    if (!program) {
      // Hand the context back before falling to the poster. A failed compile
      // that left its context alive would spend one of the page's contexts
      // on every mount of a panel that will never draw.
      g.getExtension("WEBGL_lose_context")?.loseContext();
      setGl(false);
      return;
    }
    g.useProgram(program);

    // One triangle that covers the clip space; the fragment shader does the
    // rest.
    const buffer = g.createBuffer();
    g.bindBuffer(g.ARRAY_BUFFER, buffer);
    g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), g.STATIC_DRAW);
    const aPos = g.getAttribLocation(program, "aPos");
    g.enableVertexAttribArray(aPos);
    g.vertexAttribPointer(aPos, 2, g.FLOAT, false, 0, 0);

    const uRes = g.getUniformLocation(program, "uRes");
    const uTime = g.getUniformLocation(program, "uTime");
    const uEnergy = g.getUniformLocation(program, "uEnergy");

    const dpr = Math.min(DPR_MAX, (window.devicePixelRatio || 1) * DPR_HEADROOM);
    const px = Math.max(1, Math.round(size * dpr));
    canvas.width = px;
    canvas.height = px;
    g.viewport(0, 0, px, px);
    g.clearColor(0, 0, 0, 0);
    g.uniform2f(uRes, px, px);

    // The shader's clock and the eased state. Time integrates dt × speed,
    // so a tempo change alters the pace without jumping the phase, which a
    // multiplied wall clock would do every time the chat's beat updated.
    let time = 0;
    let energy = live.current.energy;
    let speed = live.current.speed;
    let last: number | null = null;
    let frame = 0;
    let lost = false;

    const render = (t: number, e: number) => {
      g.clear(g.COLOR_BUFFER_BIT);
      g.uniform1f(uTime, t);
      g.uniform1f(uEnergy, e);
      g.drawArrays(g.TRIANGLES, 0, 3);
    };

    const running = () => live.current.inView && !live.current.still && !document.hidden;

    const loop = (now: number) => {
      frame = 0;
      if (lost) return;
      const dt = last === null ? 0 : Math.min(0.1, (now - last) / 1000);
      last = now;
      energy += (live.current.energy - energy) * Math.min(1, dt * 4);
      speed += (live.current.speed - speed) * Math.min(1, dt * 4);
      time += dt * speed;
      render(time, energy);
      if (running()) frame = requestAnimationFrame(loop);
    };

    const stop = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };

    // Called on mount, on every change to visibility or the motion
    // preference, and when the tab comes back. Reduced motion draws one
    // frame and stops: idle energy at t = 0, the same frame the poster was
    // rendered from.
    const sync = () => {
      if (lost) return;
      if (live.current.still) {
        stop();
        render(0, MODE_ENERGY.idle);
        return;
      }
      if (running()) {
        if (frame) return;
        last = null;
        frame = requestAnimationFrame(loop);
      } else {
        stop();
      }
    };
    controls.current = sync;
    sync();
    document.addEventListener("visibilitychange", sync);

    // A lost context (GPU reset, too many contexts on the page). Stop
    // drawing and keep the canvas mounted, so the browser can hand the
    // context back; the restore bumps `generation` and this effect rebuilds
    // the program on the same element.
    const onLost = (e: Event) => {
      e.preventDefault();
      lost = true;
      stop();
    };
    const onRestored = () => setGeneration((n) => n + 1);
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);

    return () => {
      stop();
      controls.current = null;
      document.removeEventListener("visibilitychange", sync);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      g.deleteBuffer(buffer);
      g.deleteProgram(program);
      // Release the context outright rather than waiting for GC. Browsers
      // cap live contexts per page, and a mounted-unmounted-mounted demo
      // panel must not spend two of them.
      g.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [mounted, gl, size, generation]);

  const showCanvas = mounted && gl;

  return (
    <span
      ref={rootRef}
      className={`soul ${MODE_CLASS[mode]} ${className}`}
      style={{
        width: size,
        height: size,
        // Proportional, so the aura is equally soft at 26px and at 72px.
        ["--soul-aura-blur" as string]: `${Math.max(3, size * 0.16).toFixed(1)}px`,
        ...(beatMs ? { ["--soul-beat" as string]: `${Math.round(beatMs)}ms` } : {}),
      }}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {/* First in the markup so it paints under everything: `.soul` is a
          one-cell grid, so the stack is document order. */}
      <span className="soul__aura" />

      {/* The ring only the voice state makes visible. Always mounted, so
          changing state never adds a node mid-animation. */}
      <span className="soul__ring" />

      <span className="soul__beat">
        {showCanvas ? (
          <canvas
            ref={canvasRef}
            className="soul__orb"
            width={size}
            height={size}
            aria-hidden
          />
        ) : (
          <img
            src={POSTER}
            alt=""
            width={size}
            height={size}
            decoding="async"
            className="soul__orb"
          />
        )}
      </span>
    </span>
  );
}

/**
 * Compile and link, or return null and say why on the console. Null rather
 * than a throw: a shader that fails to compile on some driver must fall back
 * to the poster, not take the demo panel down with it.
 */
function buildProgram(
  g: WebGLRenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram | null {
  const compile = (type: number, source: string) => {
    const shader = g.createShader(type);
    if (!shader) return null;
    g.shaderSource(shader, source);
    g.compileShader(shader);
    if (!g.getShaderParameter(shader, g.COMPILE_STATUS)) {
      console.error("soul: shader failed to compile", g.getShaderInfoLog(shader));
      g.deleteShader(shader);
      return null;
    }
    return shader;
  };

  const vertex = compile(g.VERTEX_SHADER, vertexSource);
  const fragment = compile(g.FRAGMENT_SHADER, fragmentSource);
  if (!vertex || !fragment) return null;

  const program = g.createProgram();
  if (!program) return null;
  g.attachShader(program, vertex);
  g.attachShader(program, fragment);
  g.linkProgram(program);
  // The shaders are owned by the program once linked; flag them for deletion
  // now so they go when it does.
  g.deleteShader(vertex);
  g.deleteShader(fragment);
  if (!g.getProgramParameter(program, g.LINK_STATUS)) {
    console.error("soul: program failed to link", g.getProgramInfoLog(program));
    g.deleteProgram(program);
    return null;
  }
  return program;
}
