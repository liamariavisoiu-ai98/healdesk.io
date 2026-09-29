#!/usr/bin/env node
/**
 * Render the soul's poster: one frame of the orb shader, 512px, with alpha.
 *
 *   node apps/web/scripts/render-soul-poster.mjs            # writes the poster
 *   node apps/web/scripts/render-soul-poster.mjs --out x.png --size 1024
 *
 * The poster is what the markup carries before hydration, what reduced-motion
 * visitors see permanently, and what stays if WebGL is unavailable. It has to
 * be a frame of the exact program the canvas runs, or the swap from poster to
 * canvas is visible: this script reads `SOUL_FRAGMENT` out of
 * src/lib/soul-shader.ts rather than carrying a copy, so the two cannot
 * drift. Re-run it whenever the shader changes.
 *
 * No dependencies. It writes a one-page HTML file that draws the shader at
 * t = 0 with idle energy (the same values HealdeskSoul.tsx uses for its
 * reduced-motion frame), encodes the canvas to a PNG data URL in the page, and
 * asks headless Chrome to dump the DOM. The PNG is decoded from that dump.
 *
 * Not `--screenshot`: a WebGL canvas drawn during the load is not reliably in
 * the frame headless Chrome captures, and the first version of this script
 * wrote a 2KB fully transparent image without complaint. Reading the pixels
 * back through `toDataURL` in the page is exact, and cannot be blank without
 * the script noticing. Chrome is found at the macOS default path or from
 * `$CHROME`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const size = Number(opt("size", "512"));
const out = resolve(opt("out", join(web, "public/brand/healdesk-soul.png")));

// Must match MODE_ENERGY.idle in HealdeskSoul.tsx.
const IDLE_ENERGY = 0.18;

const chrome =
  process.env.CHROME ??
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(
    existsSync,
  );
if (!chrome) {
  console.error("render-soul-poster: no Chrome found; set $CHROME to the binary");
  process.exit(1);
}

// Pull the two exported template literals out of the TypeScript source. They
// are plain backtick strings with no interpolation, so a regex is enough and
// keeps this script free of a TS loader.
const shaderSource = readFileSync(join(web, "src/lib/soul-shader.ts"), "utf8");
const literal = (name) => {
  const m = shaderSource.match(new RegExp(`export const ${name} = /\\* glsl \\*/ \`([\\s\\S]*?)\`;`));
  if (!m) throw new Error(`render-soul-poster: ${name} not found in soul-shader.ts`);
  return m[1];
};
const vertex = literal("SOUL_VERTEX");
const fragment = literal("SOUL_FRAGMENT");

const html = `<!doctype html>
<meta charset="utf-8">
<style>html,body{margin:0;background:transparent}canvas{display:block;width:${size}px;height:${size}px}</style>
<canvas id="c" width="${size}" height="${size}"></canvas>
<script>
// Any failure lands in the DOM, where the dump can report it instead of a
// bare "no PNG".
window.onerror = (msg) => { document.body.textContent = "SOUL_POSTER_ERROR " + msg; };
const c = document.getElementById("c");
const g = c.getContext("webgl", { alpha: true, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const compile = (type, src) => { const s = g.createShader(type); g.shaderSource(s, src); g.compileShader(s);
  if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(s)); return s; };
const p = g.createProgram();
g.attachShader(p, compile(g.VERTEX_SHADER, ${JSON.stringify(vertex)}));
g.attachShader(p, compile(g.FRAGMENT_SHADER, ${JSON.stringify(fragment)}));
g.linkProgram(p); g.useProgram(p);
const b = g.createBuffer(); g.bindBuffer(g.ARRAY_BUFFER, b);
g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), g.STATIC_DRAW);
const a = g.getAttribLocation(p, "aPos"); g.enableVertexAttribArray(a); g.vertexAttribPointer(a, 2, g.FLOAT, false, 0, 0);
g.viewport(0, 0, ${size}, ${size}); g.clearColor(0,0,0,0); g.clear(g.COLOR_BUFFER_BIT);
g.uniform2f(g.getUniformLocation(p, "uRes"), ${size}, ${size});
g.uniform1f(g.getUniformLocation(p, "uTime"), 0);
g.uniform1f(g.getUniformLocation(p, "uEnergy"), ${IDLE_ENERGY});
g.drawArrays(g.TRIANGLES, 0, 3);
document.body.textContent = c.toDataURL("image/png");
</script>`;

const dir = mkdtempSync(join(tmpdir(), "soul-poster-"));
try {
  const page = join(dir, "poster.html");
  writeFileSync(page, html);
  const dom = execFileSync(
    chrome,
    [
      "--headless=new",
      "--no-sandbox",
      "--use-gl=angle",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--virtual-time-budget=3000",
      "--dump-dom",
      `file://${page}`,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 },
  );
  const err = dom.match(/SOUL_POSTER_ERROR ([^<]+)/);
  if (err) throw new Error(`render-soul-poster: page error: ${err[1].trim()}`);
  const m = dom.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/);
  if (!m) throw new Error("render-soul-poster: the page produced no PNG and no error; is WebGL available to headless Chrome?");
  const png = Buffer.from(m[1], "base64");
  // A transparent 512px square encodes to about 2KB. A rendered orb is tens
  // of kilobytes. Refuse to write something that is obviously empty.
  if (png.length < 10_000) throw new Error(`render-soul-poster: PNG is only ${png.length} bytes, refusing to write a blank poster`);
  writeFileSync(out, png);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`wrote ${out} (${size}x${size})`);
