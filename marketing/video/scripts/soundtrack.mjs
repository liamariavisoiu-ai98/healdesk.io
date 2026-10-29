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
// night, cuts for the 12 frames before "Don't believe me?", returns. Every
// cue below is a global frame of the timeline in src/copy.ts (SCENES).
band(f2s(154), f2s(720), { full: true });
band(f2s(720), f2s(900), { full: false });
band(f2s(912), f2s(1080), { full: true });

// ---------------------------------------------------------------- effects

/** A soft glassy pop: a notification or a card landing. */
function pop(at, gain = 0.2, pitch = 0, pan = 0) {
  const f = 520 * 2 ** (pitch / 12);
  add(at, 0.14, (t) => Math.sin(2 * Math.PI * (f + 900 * Math.exp(-40 * t)) * t) * Math.exp(-30 * t), { gain, pan, send: 0.2 });
}

/** A swoosh: noise swelling and falling, for things flying. */
function swoosh(at, dur = 0.3, gain = 0.14, pan = 0) {
  const lp = lowpass(2500);
  add(at, dur, (t) => lp(rand()) * Math.sin((Math.PI * t) / dur), { gain, pan });
}

// Scene 1: a muffled ring, twice; a flat voicemail beep; the pile-up, a dull
// pop per notification; the pile-up flies off; the coin drops and rattles.
for (const at of [12, 28]) {
  const lp = lowpass(1400);
  add(f2s(at), 0.42, (t) => lp((Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t)) * (Math.sin(2 * Math.PI * 20 * t) > 0 ? 1 : 0.2)) * Math.min(1, t * 80) * Math.min(1, (0.42 - t) * 30), { gain: 0.16, send: 0.1 });
}
add(f2s(44), 0.32, (t) => Math.sin(2 * Math.PI * 1000 * t) * Math.min(1, t * 200) * Math.min(1, (0.32 - t) * 200), { gain: 0.08 });
for (let i = 0; i < 6; i++) pop(f2s(44 + i * 9), 0.12, -12, -0.3 + i * 0.12);
swoosh(f2s(100), 0.8, 0.16, 0.4);
add(f2s(134), f2s(16), (t) => (Math.sin(2 * Math.PI * (8 + 20 * t) * t) > 0.9 ? rand() * 0.6 : 0) * 0.5, { gain: 0.25, pan: 0.3 });

// Scene 2: the catch, the orb blooms, three badges.
tink(f2s(152), 0, 0.42);
{
  const lp = lowpass(900);
  add(f2s(158), 1.2, (t) => lp(rand()) * Math.sin((Math.PI * t) / 1.2) * 0.8 + Math.sin(2 * Math.PI * 110 * t) * Math.exp(-3 * t) * 0.4, { gain: 0.2, send: 0.4 });
}
for (let i = 0; i < 3; i++) pop(f2s(194 + i * 6), 0.18, i * 2, -0.4 + i * 0.4);

// Scene 3: keys, the button, the box shatters into the build.
for (let k = 0; k < 19; k++) {
  const lp = lowpass(4000);
  add(f2s(255 + k * 1.6), 0.04, (t) => lp(rand()) * Math.exp(-120 * t), { gain: 0.16, pan: -0.2 + (k % 3) * 0.2 });
}
add(f2s(286), 0.06, (t) => Math.sin(2 * Math.PI * 180 * t) * Math.exp(-60 * t), { gain: 0.3 });
{
  const lpA = lowpass(9000);
  let lpB = 0;
  add(f2s(290), 0.9, (t) => {
    const cut = 400 + 6000 * (t / 0.9);
    const a = Math.exp((-2 * Math.PI * cut) / SR);
    const n = lpA(rand());
    lpB = (1 - a) * n + a * lpB;
    return (n - lpB) * Math.sin((Math.PI * t) / 0.9);
  }, { gain: 0.16, send: 0.4 });
  for (let k = 0; k < 6; k++) tink(f2s(304 + k * 3), 5 + k * 2, 0.05);
}
for (let i = 0; i < 3; i++) pop(f2s(312 + i * 6), 0.12, 4 + i, -0.5 + i * 0.3);

// Scene 4: the orb pulses, five cards burst out, five bookings land rising a
// semitone each, and healdesk's notification.
pop(f2s(420), 0.22, -5);
for (let i = 0; i < 5; i++) swoosh(f2s(428 + i * 6), 0.3, 0.12, -0.6 + i * 0.3);
for (let i = 0; i < 5; i++) tink(f2s(488 + i * 16), i, 0.24);
tink(f2s(558), 7, 0.3);
pop(f2s(558), 0.2, 7);

// Scene 5: the tap, Stripe's sheet, the card typing, pay, paid, the money and
// healdesk's notification.
pop(f2s(622), 0.2, 2);
swoosh(f2s(626), 0.45, 0.16);
for (let k = 0; k < 12; k++) {
  const lp = lowpass(4000);
  add(f2s(640 + k * 1.4), 0.035, (t) => lp(rand()) * Math.exp(-120 * t), { gain: 0.12 });
}
add(f2s(664), 0.06, (t) => Math.sin(2 * Math.PI * 200 * t) * Math.exp(-60 * t), { gain: 0.3 });
tink(f2s(676), 4, 0.44);
tink(f2s(676.5), 11, 0.2);
for (let k = 0; k < 8; k++) tink(f2s(678 + k * 2), 12 + (k % 4) * 2, 0.05);
tink(f2s(684), 7, 0.22);
swoosh(f2s(694), 0.4, 0.12);

// Scene 6: the lamp clicks off; three notifications overnight, the last brightest.
add(f2s(740), 0.05, (t) => rand() * Math.exp(-150 * t), { gain: 0.3 });
tink(f2s(760), 2, 0.2);
tink(f2s(796), 4, 0.22);
tink(f2s(832), 7, 0.3);

// Scene 7: the end card.
tink(f2s(1042), 7, 0.36);
tink(f2s(1042.6), 0, 0.16);

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
