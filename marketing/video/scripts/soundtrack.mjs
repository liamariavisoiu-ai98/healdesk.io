// Builds public/soundtrack.wav: the music bed and every sound effect of
// SCRIPT.md's cue sheet, synthesised here so the ad needs no licensed audio.
// Cue times are the script's frame numbers at 30 fps. Deterministic: the
// noise comes from a seeded generator, so the same code makes the same file.
//
// Usage: node scripts/soundtrack.mjs [out.wav]   (then loudness-normalised by
// the render script with ffmpeg's loudnorm to -14 LUFS, -1 dBTP).

import { writeFileSync } from "node:fs";

const SR = 44100;
const FPS = 30;
const LENGTH = 1080 / FPS;
const N = Math.ceil(LENGTH * SR);
const out = process.argv[2] ?? "public/soundtrack.raw.wav";

const dry = [new Float32Array(N), new Float32Array(N)];
const wet = [new Float32Array(N), new Float32Array(N)]; // the reverb send

let seed = 7;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const f2s = (frame) => frame / FPS;
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

// Music enters with AYA at 0:05 (the catch), drops to the felt piano for the
// dream outcome, cuts for the 12 frames before "Don't believe me?", returns.
band(f2s(154), f2s(690), { full: true });
band(f2s(690), f2s(900), { full: false });
band(f2s(912), f2s(1080), { full: true });

// ---------------------------------------------------------------- effects

// Hook: a muffled ring, twice, then a flat voicemail beep.
for (const at of [10, 28]) {
  const lp = lowpass(1400);
  add(f2s(at), 0.42, (t) => lp((Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t)) * (Math.sin(2 * Math.PI * 20 * t) > 0 ? 1 : 0.2)) * Math.min(1, t * 80) * Math.min(1, (0.42 - t) * 30), { gain: 0.16, send: 0.1 });
}
add(f2s(50), 0.32, (t) => Math.sin(2 * Math.PI * 1000 * t) * Math.min(1, t * 200) * Math.min(1, (0.32 - t) * 200), { gain: 0.08 });
// One soft thunk per faded caller.
for (let i = 0; i < 17; i++) add(f2s(60 + i * 2), 0.18, (t) => Math.sin(2 * Math.PI * (70 + 30 * Math.exp(-30 * t)) * t) * Math.exp(-22 * t), { gain: 0.18, pan: -0.6 + i * 0.07 });
// The door closes.
{
  const lp = lowpass(500);
  add(f2s(134), 0.5, (t) => (Math.sin(2 * Math.PI * 55 * t) * 0.9 + lp(rand()) * 0.8) * Math.exp(-10 * t), { gain: 0.42, pan: 0.5, send: 0.2 });
}
// The coin rolls: a rattle that speeds up.
add(f2s(138), f2s(16), (t) => (Math.sin(2 * Math.PI * (8 + 20 * t) * t) > 0.9 ? rand() * 0.6 : 0) * 0.5, { gain: 0.25, pan: 0.3 });

// The catch.
tink(f2s(154), 0, 0.42);

// Keyboard: a soft click per character, then the button.
for (let k = 0; k < 19; k++) {
  const lp = lowpass(4000);
  add(f2s(285 + k * 1.8), 0.04, (t) => lp(rand()) * Math.exp(-120 * t), { gain: 0.16, pan: -0.2 + (k % 3) * 0.2 });
}
add(f2s(316), 0.06, (t) => Math.sin(2 * Math.PI * 180 * t) * Math.exp(-60 * t), { gain: 0.3 });
// The build's shimmer: a rising band of noise and a sparkle.
{
  const lpA = lowpass(9000);
  let lpB = 0;
  add(f2s(320), 0.9, (t) => {
    const cut = 400 + 6000 * (t / 0.9);
    const a = Math.exp((-2 * Math.PI * cut) / SR);
    const n = lpA(rand());
    lpB = (1 - a) * n + a * lpB;
    return (n - lpB) * Math.sin((Math.PI * t) / 0.9);
  }, { gain: 0.16, send: 0.4 });
  for (let k = 0; k < 6; k++) tink(f2s(330 + k * 3), 5 + k * 2, 0.05);
}

// The finger snap.
{
  const lp = lowpass(3500);
  const lp2 = lowpass(1500);
  add(f2s(452), 0.08, (t) => {
    const n = lp(rand());
    return (n - lp2(n)) * Math.exp(-70 * t) * 3;
  }, { gain: 0.35, send: 0.3, pan: -0.2 });
}
// Four cards burst out: paper-soft swooshes.
for (let i = 0; i < 4; i++) {
  const lp = lowpass(2500);
  add(f2s(465 + i * 12), 0.3, (t) => lp(rand()) * Math.sin((Math.PI * t) / 0.3), { gain: 0.14, pan: -0.5 + i * 0.33 });
}
// Four bookings, four tinks, rising a semitone each.
for (let i = 0; i < 4; i++) tink(f2s(540 + i * 20), i, 0.26);
// The deposit: the biggest tink, a fifth on top.
tink(f2s(626), 4, 0.42);
tink(f2s(626.5), 11, 0.18);
tink(f2s(648), 7, 0.12);

// Booked tiles settle; the lamp clicks off; one notification overnight.
tink(f2s(726), 2, 0.14);
add(f2s(790), 0.05, (t) => rand() * Math.exp(-150 * t), { gain: 0.3 });
tink(f2s(842), 4, 0.26);

// The end card.
tink(f2s(1044), 7, 0.36);
tink(f2s(1044.6), 0, 0.16);

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
