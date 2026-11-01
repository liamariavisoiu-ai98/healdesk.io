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
/** Seconds at `frame` frames of scene time into `scene`, honouring its speed. */
const at = (scene, frame) => (S[scene].from + frame / S[scene].speed) / FPS;
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

const CHORDS = [
  { bass: 38, tones: [62, 66, 69, 73, 76] }, // Dmaj9
  { bass: 35, tones: [59, 62, 66, 69, 73] }, // Bm9
  { bass: 43, tones: [59, 62, 66, 67, 71] }, // Gmaj9
  { bass: 45, tones: [61, 64, 69, 71, 76] }, // A(add9)
];

/** The low, resonant drone of the opening; its pitch can glide up for tension. */
function drone(t0, t1, from, to, gain = 0.32) {
  const dur = t1 - t0;
  let phase = [0, 0, 0];
  add(t0, dur, (t) => {
    const k = t / dur;
    const f = midi(from + (to - from) * k * k);
    const env = Math.min(1, t / 1.2) * Math.min(1, (dur - t) / 0.08);
    const parts = [f, f * 1.5, f * 2.003];
    let v = 0;
    parts.forEach((pf, i) => {
      phase[i] += (2 * Math.PI * pf) / SR;
      v += Math.sin(phase[i] + 0.6 * Math.sin(phase[i] * 0.5)) * [1, 0.35, 0.22 + 0.25 * k][i];
    });
    return v * env * (0.85 + 0.15 * Math.sin(2 * Math.PI * 0.3 * t));
  }, { gain, send: 0.35 });
}

/** A warm pad that breathes: detuned sines per chord tone, a slow swell in and out. */
function pad(t0, t1, gain = 0.1, breathe = 0.25) {
  const barLen = 2.4;
  for (let b = 0; t0 + b * barLen < t1; b++) {
    const start = t0 + b * barLen;
    const len = Math.min(barLen + 0.9, t1 - start);
    const ch = CHORDS[b % CHORDS.length];
    const freqs = [ch.bass + 12, ...ch.tones.slice(0, 4)].map(midi);
    add(start, len, (t) => {
      let v = 0;
      for (const f of freqs) for (const d of [-0.003, 0, 0.003]) v += Math.sin(2 * Math.PI * f * (1 + d) * t) + 0.18 * Math.sin(4 * Math.PI * f * (1 + d) * t);
      const env = Math.min(1, t / 0.7) * Math.min(1, (len - t) / 0.9);
      const lfo = 1 - breathe + breathe * Math.sin(2 * Math.PI * 0.25 * (start + t));
      return (v / 14) * env * lfo;
    }, { gain, send: 0.6 });
  }
}

/** Rhythmic micro-clicks: a soft 16th-note tick with an accent on the beat. */
function ticks(t0, t1, bpm = 112, gain = 0.07) {
  const step = 60 / bpm / 4;
  for (let k = 0; t0 + k * step < t1; k++) {
    const accent = k % 4 === 0;
    const lp = lowpass(accent ? 5000 : 8000);
    const f = accent ? 2400 : 3600;
    add(t0 + k * step, 0.03, (t) => (Math.sin(2 * Math.PI * f * t) * 0.6 + lp(rand()) * 0.4) * Math.exp(-160 * t), { gain: accent ? gain * 1.4 : gain, pan: k % 2 ? 0.25 : -0.25 });
    if (k % 8 === 0) kick(t0 + k * step, 0.18);
  }
}

// 0:00–0:10 the drone, rising a tone for "Missed DMs?"; cut dead at the dark.
drone(at("missed", 0), at("missed", 150), 33, 33);
drone(at("missed", 150), at("missed", 298), 33, 36, 0.36);
// 0:15 on, the warm pad breathes under Aya, the dashboard and the deposit.
pad(at("interrupt", 56), at("aya", 0), 0.06, 0.15);
pad(at("aya", 0), at("close", 0) + 0.4, 0.1, 0.25);
// 0:25–0:35 the rhythm of everything arriving at once.
ticks(at("dashboard", 6), at("dashboard", 296));
// 0:40 the music resolves: one warm chord that lingers.
{
  const t0 = at("close", 0);
  const ch = CHORDS[0];
  bass(t0, ch.bass, 3.6, 0.2);
  [ch.bass + 12, ...ch.tones].forEach((m, i) => piano(t0 + i * 0.03, m, 0.075, 3.9, (i - 2.5) * 0.18));
  pad(t0, f2s(S.close.to), 0.09, 0.05);
}

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

/** A phone's vibration motor: a buzzing burst with a rough edge. */
function haptic(t0, dur = 0.26, gain = 0.22) {
  add(t0, dur, (t) => {
    const motor = Math.sign(Math.sin(2 * Math.PI * 165 * t)) * 0.6 + Math.sin(2 * Math.PI * 330 * t) * 0.3;
    return motor * Math.min(1, t * 120) * Math.min(1, (dur - t) * 60) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 22 * t));
  }, { gain });
}

/** A soft mechanical key: a low thock and a small high click. */
function mechKey(t0, gain = 0.16, pan = 0) {
  const lp = lowpass(1800);
  add(t0, 0.06, (t) => (Math.sin(2 * Math.PI * 140 * t) * Math.exp(-70 * t) * 0.9 + lp(rand()) * Math.exp(-90 * t) * 0.6 + Math.sin(2 * Math.PI * 4200 * t) * Math.exp(-260 * t) * 0.3), { gain, pan });
}

/** A high-end confirmation chime: two soft bell notes, a fifth apart. */
function confirm(t0, gain = 0.32) {
  tink(t0, -5, gain);
  tink(t0 + 0.11, 2, gain * 0.9);
  piano(t0 + 0.11, 86, 0.05, 1.6);
}

// 0:00–0:05 an incoming call buzzing, then a buzz for every missed call.
for (const f of [14, 28]) haptic(at("missed", f), 0.34, 0.24);
[44, 58, 72, 86, 100].forEach((f) => { haptic(at("missed", f), 0.22, 0.2); pop(at("missed", f), 0.08, -12); });
// 0:05–0:10 messages multiply: quicker, lighter buzzes and pops, rising.
for (let i = 0; i < 12; i++) {
  haptic(at("missed", 166 + i * 8), 0.14, 0.13);
  pop(at("missed", 166 + i * 8), 0.09, -7 + i, -0.5 + (i % 5) * 0.25);
}

// 0:10–0:15 the coin falls through the dark and lands; the flash is a crisp
// click and a high-end chime instead of a till.
swoosh(at("interrupt", 12), 0.9, 0.12);
{
  const partials = [[1, 1, 7], [2.4, 0.5, 10], [5.2, 0.25, 14], [8.9, 0.12, 18]];
  for (const [delay, g] of [[0, 1], [0.16, 0.45], [0.27, 0.2]]) {
    add(at("interrupt", 40) + delay, 0.8, (t) => {
      let v = 0;
      for (const [m, a, d] of partials) v += a * Math.sin(2 * Math.PI * 2100 * m * t) * Math.exp(-d * t);
      return v * Math.min(1, t * 500);
    }, { gain: 0.16 * g, send: 0.3 });
  }
}
add(at("interrupt", 43), 0.02, (t) => (rand() * 0.6 + Math.sin(2 * Math.PI * 3000 * t)) * Math.exp(-300 * t), { gain: 0.35 });
tink(at("interrupt", 43), 0, 0.36);
tink(at("interrupt", 43) + 0.012, 7, 0.22);
tink(at("interrupt", 43) + 0.024, 12, 0.14);

// 0:15–0:25 the orb blooms; badges; soft mechanical typing; the site is read.
{
  const lp = lowpass(900);
  add(at("aya", 0), 1.6, (t) => lp(rand()) * Math.sin((Math.PI * t) / 1.6) * 0.6, { gain: 0.16, send: 0.5 });
}
pop(at("aya", 84), 0.16, 2);
pop(at("aya", 94), 0.16, 5);
for (let k = 0; k < 19; k++) mechKey(at("aya", 128 + k * 2.4), 0.15, -0.2 + (k % 3) * 0.2);
tink(at("aya", 174), 7, 0.24);
for (let i = 0; i < 4; i++) pop(at("aya", 186 + i * 7), 0.12, 4 + i * 2, -0.4 + i * 0.25);

// 0:25–0:35 every conversation arriving, every booking landing a semitone
// higher, the counter rolling.
for (let i = 0; i < 5; i++) pop(at("dashboard", 22 + i * 10), 0.14, -2 + i, -0.5 + i * 0.25);
for (let i = 0; i < 5; i++) {
  tink(at("dashboard", 92 + i * 30), i * 2, 0.22);
  for (let k = 0; k < 8; k++) add(at("dashboard", 92 + i * 30 + k * 2), 0.02, (t) => Math.sin(2 * Math.PI * 5200 * t) * Math.exp(-300 * t), { gain: 0.05 });
}

// 0:35–0:40 Stripe's sheet slides down, the card, pay, the confirmation chime,
// coins, healdesk's notification.
swoosh(at("deposit", 0), 0.5, 0.16);
for (let k = 0; k < 12; k++) mechKey(at("deposit", 22 + k * 0.72), 0.08);
add(at("deposit", 46), 0.06, (t) => Math.sin(2 * Math.PI * 200 * t) * Math.exp(-60 * t), { gain: 0.3 });
confirm(at("deposit", 58));
for (let k = 0; k < 8; k++) tink(at("deposit", 60 + k * 2), 12 + (k % 4) * 2, 0.04);
pop(at("deposit", 74), 0.2, 7);

// 0:40–0:44 the address.
tink(at("close", 52), 7, 0.16);

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
