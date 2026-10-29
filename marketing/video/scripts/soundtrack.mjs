// Builds public/soundtrack.wav: the music bed and every sound effect of
// SCRIPT.md's cue sheet, synthesised here so the ad needs no licensed audio.
// Cue times are frames within the scenes of src/timeline.json. Deterministic: the
// noise comes from a seeded generator, so the same code makes the same file.
//
// Usage: node scripts/soundtrack.mjs [out.wav]   (then loudness-normalised by
// the render script with ffmpeg's loudnorm to -14 LUFS, -1 dBTP).

import { readFileSync, writeFileSync } from "node:fs";

// The same timeline the picture uses (src/timeline.json), so every cue is a
// frame inside a scene and moves with it.
const TIMELINE = JSON.parse(readFileSync(new URL("../src/timeline.json", import.meta.url), "utf8"));
const S = TIMELINE.scenes;
const SR = 44100;
const FPS = TIMELINE.fps;
const LENGTH = S.close.to / FPS;
const N = Math.ceil(LENGTH * SR);
const out = process.argv[2] ?? "public/soundtrack.raw.wav";

const dry = [new Float32Array(N), new Float32Array(N)];
const wet = [new Float32Array(N), new Float32Array(N)]; // the reverb send

let seed = 7;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const f2s = (frame) => frame / FPS;
/** Seconds at `frame` frames into `scene`. */
const at = (scene, frame) => (S[scene].from + frame) / FPS;
const midi = (m) => 440 * 2 ** ((m - 69) / 12);

/** Add a mono voice, rendered by fn(t) for `dur` seconds, at `start` seconds. */
function add(start, dur, fn, { gain = 1, pan = 0, send = 0 } = {}) {
  const s0 = Math.floor(start * SR);
  const len = Math.floor(dur * SR);
  const l = gain * Math.cos(((pan + 1) * Math.PI) / 4);
  const r = gain * Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = 0; i < len; i++) {
    const k = s0 + i;
    if (k < 0 || k >= N) continue;
    const v = fn(i / SR, i);
    dry[0][k] += v * l;
    dry[1][k] += v * r;
    if (send) {
      wet[0][k] += v * l * send;
      wet[1][k] += v * r * send;
    }
  }
}

/** A one-pole low-pass, returned as a stateful step function. */
function lowpass(cut) {
  const a = Math.exp((-2 * Math.PI * cut) / SR);
  let y = 0;
  return (x) => (y = (1 - a) * x + a * y);
}

// ---------------------------------------------------------------- instruments

/** The tink: a struck glass, inharmonic partials, high and bright. */
function tink(at, semis = 0, gain = 0.32) {
  const f = midi(91 + semis);
  const partials = [
    [1, 1, 2.2],
    [2.756, 0.45, 3.4],
    [5.404, 0.22, 5],
    [8.933, 0.1, 7],
  ];
  add(
    at,
    2.2,
    (t) => {
      let v = 0;
      for (const [m, a, d] of partials) v += a * Math.sin(2 * Math.PI * f * m * t) * Math.exp(-d * t);
      return v * Math.min(1, t * 400);
    },
    { gain, send: 0.45, pan: 0.1 },
  );
}

/** Plucked synth: Karplus-Strong, softened. */
function pluck(at, m, gain = 0.16, pan = 0) {
  const f = midi(m);
  const period = Math.max(2, Math.round(SR / f));
  const buf = new Float32Array(period).map(() => rand() * 0.5);
  const lp = lowpass(3200);
  let idx = 0;
  add(
    at,
    1.4,
    () => {
      const a = buf[idx];
      const b = buf[(idx + 1) % period];
      buf[idx] = 0.4985 * (a + b);
      idx = (idx + 1) % period;
      return lp(a);
    },
    { gain, pan, send: 0.35 },
  );
}

/** Felt piano: a soft hammer and a few decaying harmonics. */
function piano(at, m, gain = 0.12, dur = 3, pan = 0) {
  const f = midi(m);
  const harm = [
    [1, 1, 0.9],
    [2, 0.35, 1.6],
    [3, 0.12, 2.4],
    [4, 0.05, 3.2],
  ];
  add(
    at,
    dur,
    (t) => {
      let v = 0;
      for (const [h, a, d] of harm) v += a * Math.sin(2 * Math.PI * f * h * t * (1 + 0.0004 * h)) * Math.exp(-d * t);
      return v * Math.min(1, t * 120) * (t > dur - 0.3 ? (dur - t) / 0.3 : 1);
    },
    { gain, pan, send: 0.5 },
  );
}

function bass(at, m, dur, gain = 0.22) {
  const f = midi(m);
  add(at, dur, (t) => Math.tanh(1.6 * Math.sin(2 * Math.PI * f * t)) * Math.min(1, t * 60) * Math.exp(-1.2 * t) * (t > dur - 0.05 ? (dur - t) / 0.05 : 1), { gain });
}

function kick(at, gain = 0.38) {
  add(at, 0.35, (t) => Math.sin(2 * Math.PI * (45 * t + (65 / 18) * (1 - Math.exp(-18 * t)))) * Math.exp(-9 * t), { gain });
}

/** A brushed hit: band-limited noise with a quick swell. */
function brush(at, gain = 0.07, dur = 0.18, pan = 0) {
  const lp = lowpass(6000);
  const lp2 = lowpass(1500);
  add(at, dur, (t) => {
    const n = lp(rand());
    return (n - lp2(n)) * Math.min(1, t * 200) * Math.exp((-4 / dur) * t);
  }, { gain, pan, send: 0.15 });
}

// ---------------------------------------------------------------- the music

// About 100 BPM. Four chords, a bar each: Dmaj9, Bm9, Gmaj9, A(add9).
const BEAT = 0.6;
const BAR = BEAT * 4;
const CHORDS = [
  { bass: 38, tones: [62, 66, 69, 73, 76] },
  { bass: 35, tones: [59, 62, 66, 69, 73] },
  { bass: 43, tones: [59, 62, 66, 67, 71] },
  { bass: 45, tones: [61, 64, 69, 71, 76] },
];

function band(from, to, { full }) {
  const bars = Math.ceil((to - from) / BAR);
  for (let b = 0; b < bars; b++) {
    const t0 = from + b * BAR;
    const ch = CHORDS[b % CHORDS.length];
    const left = to - t0;
    // Felt piano chord on each bar.
    ch.tones.slice(0, 4).forEach((m, i) => piano(t0 + i * 0.012, m - 12, full ? 0.06 : 0.085, Math.min(BAR + 0.6, left), (i - 1.5) * 0.25));
    if (!full) {
      // The quiet beat: one soft note a beat, high and slow.
      [3, 2, 4, 1].forEach((k, i) => t0 + i * BEAT < to && piano(t0 + i * BEAT, ch.tones[k], 0.07, Math.min(2.2, to - (t0 + i * BEAT)), 0.2));
      continue;
    }
    bass(t0, ch.bass, Math.min(BEAT * 2.5, left));
    if (t0 + BEAT * 2.5 < to) bass(t0 + BEAT * 2.5, ch.bass + 12, Math.min(BEAT * 1.4, to - (t0 + BEAT * 2.5)), 0.14);
    for (let e = 0; e < 8; e++) {
      const t = t0 + e * (BEAT / 2);
      if (t >= to) break;
      const order = [0, 2, 4, 3, 1, 3, 2, 4];
      pluck(t, ch.tones[order[e]] + 12, 0.11, e % 2 ? 0.35 : -0.35);
      brush(t + 0.004, e % 2 ? 0.03 : 0.045, 0.09, e % 2 ? 0.4 : -0.4);
    }
    for (let q = 0; q < 4; q++) {
      const t = t0 + q * BEAT;
      if (t >= to) break;
      if (q % 2 === 0) kick(t);
      else brush(t, 0.11, 0.22);
    }
  }
}

// Music enters with Aya (the catch), drops to the felt piano for the night,
// cuts for the 10 frames before the closing line, and returns under it.
band(at("aya", 2), at("night", 0), { full: true });
band(at("night", 0), at("night", 140), { full: false });
band(at("close", 6), f2s(S.close.to), { full: true });

// ---------------------------------------------------------------- effects

/** A soft glassy pop: a notification or a card landing. */
function pop(t0, gain = 0.2, pitch = 0, pan = 0) {
  const f = 520 * 2 ** (pitch / 12);
  add(t0, 0.14, (t) => Math.sin(2 * Math.PI * (f + 900 * Math.exp(-40 * t)) * t) * Math.exp(-30 * t), { gain, pan, send: 0.2 });
}

/** A swoosh: noise swelling and falling, for things flying. */
function swoosh(t0, dur = 0.3, gain = 0.14, pan = 0) {
  const lp = lowpass(2500);
  add(t0, dur, (t) => lp(rand()) * Math.sin((Math.PI * t) / dur), { gain, pan });
}

function clicks(t0, count, every, gain = 0.16) {
  for (let k = 0; k < count; k++) {
    const lp = lowpass(4000);
    add(t0 + (k * every) / FPS, 0.04, (t) => lp(rand()) * Math.exp(-120 * t), { gain, pan: -0.2 + (k % 3) * 0.2 });
  }
}

// Scene 1: two muffled rings, the voicemail beep, a dull pop per missed call
// and message, the pile leaving, the coin dropping and rattling.
for (const f of [8, 26]) {
  const lp = lowpass(1400);
  add(at("hook", f), 0.42, (t) => lp((Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t)) * (Math.sin(2 * Math.PI * 20 * t) > 0 ? 1 : 0.2)) * Math.min(1, t * 80) * Math.min(1, (0.42 - t) * 30), { gain: 0.16, send: 0.1 });
}
add(at("hook", 46), 0.32, (t) => Math.sin(2 * Math.PI * 1000 * t) * Math.min(1, t * 200) * Math.min(1, (0.32 - t) * 200), { gain: 0.08 });
[50, 62, 86, 98, 110, 122].forEach((f, i) => pop(at("hook", f), 0.13, -12 + i, -0.3 + i * 0.12));
swoosh(at("hook", 168), 0.9, 0.16, 0.4);
add(at("hook", 214), 26 / FPS, (t) => (Math.sin(2 * Math.PI * (8 + 20 * t) * t) > 0.9 ? rand() * 0.6 : 0) * 0.5, { gain: 0.25, pan: 0.3 });

// Scene 2: the catch, the orb blooming, three badges.
tink(at("aya", 2), 0, 0.42);
{
  const lp = lowpass(900);
  add(at("aya", 8), 1.2, (t) => lp(rand()) * Math.sin((Math.PI * t) / 1.2) * 0.8 + Math.sin(2 * Math.PI * 110 * t) * Math.exp(-3 * t) * 0.4, { gain: 0.2, send: 0.4 });
}
for (let i = 0; i < 3; i++) pop(at("aya", 44 + i * 6), 0.18, i * 2, -0.4 + i * 0.4);

// Scene 3: keys, the button, the box shattering into the build.
clicks(at("url", 15), 19, 1.6);
add(at("url", 46), 0.06, (t) => Math.sin(2 * Math.PI * 180 * t) * Math.exp(-60 * t), { gain: 0.3 });
{
  const lpA = lowpass(9000);
  let lpB = 0;
  add(at("url", 50), 0.9, (t) => {
    const cut = 400 + 6000 * (t / 0.9);
    const a = Math.exp((-2 * Math.PI * cut) / SR);
    const n = lpA(rand());
    lpB = (1 - a) * n + a * lpB;
    return (n - lpB) * Math.sin((Math.PI * t) / 0.9);
  }, { gain: 0.16, send: 0.4 });
  for (let k = 0; k < 6; k++) tink(at("url", 64 + k * 3), 5 + k * 2, 0.05);
}
for (let i = 0; i < 3; i++) pop(at("url", 72 + i * 6), 0.12, 4 + i, -0.5 + i * 0.3);

// Scene 4: the orb pulses, five cards burst out, five bookings land rising a
// semitone each, and healdesk's notification.
pop(at("channels", 0), 0.22, -5);
for (let i = 0; i < 5; i++) swoosh(at("channels", 8 + i * 6), 0.3, 0.12, -0.6 + i * 0.3);
for (let i = 0; i < 5; i++) tink(at("channels", 68 + i * 16), i, 0.24);
tink(at("channels", 138), 7, 0.3);
pop(at("channels", 138), 0.2, 7);

// Scene 5: the tap, Stripe's sheet, the card typing, pay, paid, the coins and
// healdesk's notification.
pop(at("deposit", 22), 0.2, 2);
swoosh(at("deposit", 26), 0.45, 0.16);
clicks(at("deposit", 40), 12, 1.4, 0.12);
add(at("deposit", 64), 0.06, (t) => Math.sin(2 * Math.PI * 200 * t) * Math.exp(-60 * t), { gain: 0.3 });
tink(at("deposit", 76), 4, 0.44);
tink(at("deposit", 76) + 0.016, 11, 0.2);
for (let k = 0; k < 8; k++) tink(at("deposit", 78 + k * 2), 12 + (k % 4) * 2, 0.05);
tink(at("deposit", 84), 7, 0.22);
swoosh(at("deposit", 94), 0.4, 0.12);

// Scene 6: the lamp clicks off; three notifications overnight, the last brightest.
add(at("night", 18), 0.05, (t) => rand() * Math.exp(-150 * t), { gain: 0.3 });
tink(at("night", 32), 2, 0.2);
tink(at("night", 60), 4, 0.22);
tink(at("night", 88), 7, 0.3);

// Scene 7: the button lands; the logo.
pop(at("close", 62), 0.22, 5);
tink(at("close", 76), 7, 0.34);
tink(at("close", 76) + 0.02, 0, 0.16);

// ---------------------------------------------------------------- reverb and write

/** A small Schroeder room on the send bus. */
function reverb(input) {
  const combs = [1557, 1617, 1491, 1422].map((d) => ({ buf: new Float32Array(d), i: 0, fb: 0.8, lp: 0 }));
  const aps = [225, 556].map((d) => ({ buf: new Float32Array(d), i: 0 }));
  const outBuf = new Float32Array(input.length);
  for (let n = 0; n < input.length; n++) {
    let s = 0;
    for (const c of combs) {
      const y = c.buf[c.i];
      c.lp = y * 0.6 + c.lp * 0.4;
      c.buf[c.i] = input[n] + c.lp * c.fb;
      c.i = (c.i + 1) % c.buf.length;
      s += y;
    }
    for (const a of aps) {
      const y = a.buf[a.i];
      a.buf[a.i] = s + y * 0.5;
      a.i = (a.i + 1) % a.buf.length;
      s = y - s * 0.5;
    }
    outBuf[n] = s * 0.25;
  }
  return outBuf;
}

const rl = reverb(wet[0]);
const rr = reverb(wet[1]);
let peak = 0;
for (let n = 0; n < N; n++) {
  dry[0][n] += rl[n];
  dry[1][n] += rr[n];
  const t = n / SR;
  const fade = t > LENGTH - 0.6 ? Math.max(0, (LENGTH - t) / 0.6) : 1;
  dry[0][n] *= fade;
  dry[1][n] *= fade;
  peak = Math.max(peak, Math.abs(dry[0][n]), Math.abs(dry[1][n]));
}
const norm = peak > 0 ? 0.89 / peak : 1;

const bytes = Buffer.alloc(44 + N * 4);
bytes.write("RIFF", 0);
bytes.writeUInt32LE(36 + N * 4, 4);
bytes.write("WAVEfmt ", 8);
bytes.writeUInt32LE(16, 16);
bytes.writeUInt16LE(1, 20);
bytes.writeUInt16LE(2, 22);
bytes.writeUInt32LE(SR, 24);
bytes.writeUInt32LE(SR * 4, 28);
bytes.writeUInt16LE(4, 32);
bytes.writeUInt16LE(16, 34);
bytes.write("data", 36);
bytes.writeUInt32LE(N * 4, 40);
for (let n = 0; n < N; n++) {
  bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, dry[0][n] * norm)) * 32767), 44 + n * 4);
  bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, dry[1][n] * norm)) * 32767), 46 + n * 4);
}
writeFileSync(out, bytes);
console.log(`wrote ${out} (${LENGTH}s, peak ${peak.toFixed(2)} before normalising)`);
