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
const song = [new Float32Array(N), new Float32Array(N)]; // the music, filtered and side-chained before the mix
const songWet = [new Float32Array(N), new Float32Array(N)]; // the music's own reverb send, filtered with it
let target = dry;

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
    target[0][k] += v * l;
    target[1][k] += v * r;
    if (send) {
      const bus = target === song ? songWet : wet;
      bus[0][k] += v * l * send;
      bus[1][k] += v * r * send;
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

// ---------------------------------------------------------------- the song

// A punchy, positive track in D major at 120 BPM. Bars are laid so the drop
// lands on the cut to "Not on my watch." (the interrupt's first frame).
const BPM = TIMELINE.bpm;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const DROP = at("interrupt", 0);
const GRID = DROP - Math.floor(DROP / BAR) * BAR; // the first downbeat after 0
const END_GROOVE = at("close", 0);
const SONG_END = f2s(S.close.to);

// I – V – vi – IV.
const PROG = [
  { root: 38, tones: [62, 66, 69, 74] }, // D
  { root: 45, tones: [61, 64, 69, 73] }, // A
  { root: 47, tones: [62, 66, 71, 74] }, // Bm
  { root: 43, tones: [62, 67, 71, 74] }, // G
];
const chordAt = (t) => PROG[Math.floor((t - GRID) / BAR + 400) % PROG.length];

// A band-limited saw, read from one table, so the synths stay cheap and clean.
const TABLE = 4096;
const SAW = new Float32Array(TABLE);
for (let i = 0; i < TABLE; i++) for (let h = 1; h <= 24; h++) SAW[i] += (Math.sin((2 * Math.PI * h * i) / TABLE) / h) * 0.55;
const saw = (phase) => SAW[Math.floor((((phase % 1) + 1) % 1) * TABLE)];

const kicks = [];
function songKick(t0, gain = 0.9) {
  kicks.push(t0);
  add(t0, 0.42, (t) => (Math.sin(2 * Math.PI * (48 * t + (110 / 22) * (1 - Math.exp(-22 * t)))) * Math.exp(-7 * t) + (t < 0.004 ? rand() * 0.6 : 0)), { gain });
}
function clap(t0, gain = 0.32) {
  const lp = lowpass(4200);
  const lp2 = lowpass(900);
  add(t0, 0.3, (t) => {
    const burst = [0, 0.011, 0.022].some((o) => t >= o && t < o + 0.008) ? 1 : 0;
    const n = lp(rand());
    return (n - lp2(n)) * (burst * 1.2 + Math.exp(-14 * t)) * 0.9;
  }, { gain, send: 0.35 });
}
function hat(t0, open = false, gain = 0.09, pan = 0.2) {
  const lp = lowpass(7000);
  const dur = open ? 0.22 : 0.05;
  add(t0, dur, (t) => {
    const n = rand();
    return (n - lp(n)) * Math.exp((open ? -14 : -70) * t);
  }, { gain, pan });
}
function bassNote(t0, m, dur, gain = 0.28) {
  const f = midi(m);
  let ph = 0;
  let y = 0;
  add(t0, dur, (t) => {
    ph += f / SR;
    const cut = 300 + 2600 * Math.exp(-18 * t);
    const a = Math.exp((-2 * Math.PI * cut) / SR);
    y = (1 - a) * (saw(ph) * 0.7 + Math.sin(2 * Math.PI * ph) * 0.6) + a * y;
    return y * Math.min(1, t * 400) * Math.min(1, (dur - t) * 60);
  }, { gain });
}
function stab(t0, tones, dur = 0.22, gain = 0.16) {
  const voices = tones.flatMap((m) => [-0.12, 0, 0.12].map((d) => ({ f: midi(m + 12) * 2 ** (d / 12), ph: (rand() + 1) / 2 })));
  let y = 0;
  add(t0, dur + 0.25, (t) => {
    let v = 0;
    for (const vc of voices) {
      vc.ph += vc.f / SR;
      v += saw(vc.ph);
    }
    const cut = 1200 + 5200 * Math.exp(-9 * t);
    const a = Math.exp((-2 * Math.PI * cut) / SR);
    y = (1 - a) * (v / voices.length) + a * y;
    const env = Math.min(1, t * 300) * (t < dur ? 1 : Math.exp(-14 * (t - dur)));
    return y * env * 2.2;
  }, { gain, send: 0.4 });
}
function songPad(t0, t1, gain = 0.07) {
  for (let t = t0; t < t1; t += BAR) {
    const ch = chordAt(t + 0.01);
    const len = Math.min(BAR + 0.5, t1 - t);
    const vs = ch.tones.map((m) => ({ f: midi(m), ph: 0 }));
    let y = 0;
    add(t, len, (tt) => {
      let v = 0;
      for (const vc of vs) {
        vc.ph += vc.f / SR;
        v += saw(vc.ph) + saw(vc.ph * 1.003);
      }
      const a = Math.exp((-2 * Math.PI * 1500) / SR);
      y = (1 - a) * (v / 8) + a * y;
      return y * Math.min(1, tt / 0.3) * Math.min(1, (len - tt) / 0.4);
    }, { gain, send: 0.6 });
  }
}
// A bright plucked hook over the chords, two bars long.
const HOOK = [0, 2, 3, 2, 1, 2, 3, 3, 0, 2, 3, 2, 3, 2, 1, 0];
function melody(t0, t1, gain = 0.12) {
  const step = BEAT / 2;
  for (let k = 0; t0 + k * step < t1; k++) {
    const t = t0 + k * step;
    const ch = chordAt(t + 0.01);
    if (k % 16 === 7 || k % 16 === 15) continue;
    pluck(t, ch.tones[HOOK[k % HOOK.length]] + 12, gain, k % 2 ? 0.3 : -0.3);
  }
}

target = song;
const beats = (from, to, fn) => {
  for (let i = Math.ceil((from - GRID) / BEAT - 1e-6); GRID + i * BEAT < to - 1e-6; i++) fn(GRID + i * BEAT, i);
};

// The opening: the same song, muffled behind a filter that opens toward the
// drop, with a riser and a snare roll.
beats(0, DROP, (t, i) => {
  songKick(t, 0.75);
  if (i % 2 === 1) hat(t, false, 0.05);
  bassNote(t, chordAt(t + 0.01).root, BEAT * 0.45, 0.24);
  bassNote(t + BEAT / 2, chordAt(t + 0.01).root + 12, BEAT * 0.4, 0.18);
});
songPad(GRID - BAR, DROP, 0.06);
{
  const lpA = lowpass(10000);
  let lpB = 0;
  const t0 = DROP - 2.2;
  add(t0, 2.2, (t) => {
    const cut = 300 + 7000 * (t / 2.2) ** 2;
    const a = Math.exp((-2 * Math.PI * cut) / SR);
    const n = lpA(rand());
    lpB = (1 - a) * n + a * lpB;
    return (n - lpB) * (t / 2.2) ** 1.6;
  }, { gain: 0.22, send: 0.4 });
  for (let k = 0; k < 16; k++) clap(DROP - BEAT * 2 + (k * BEAT) / 8, 0.05 + k * 0.012);
}

// The drop and the groove, through to the close.
{
  const lp = lowpass(9000);
  add(DROP, 1.6, (t) => {
    const n = rand();
    return (n - lp(n)) * Math.exp(-2.6 * t) * 1.2;
  }, { gain: 0.24, send: 0.5 });
}
const DASH = at("dashboard", 0);
beats(DROP, END_GROOVE, (t, i) => {
  const ch = chordAt(t + 0.01);
  songKick(t);
  if (i % 2 === 1) clap(t);
  hat(t + BEAT / 2, true, 0.08, 0.25);
  if (t >= DASH) {
    hat(t + BEAT / 4, false, 0.05, -0.3);
    hat(t + (3 * BEAT) / 4, false, 0.05, -0.3);
  }
  bassNote(t, ch.root, BEAT * 0.42);
  bassNote(t + BEAT / 2, ch.root + 12, BEAT * 0.38, 0.22);
  // Stabs on the "and" of 1 and on 3, the lift.
  if (i % 4 === 0) stab(t + BEAT / 2, ch.tones, 0.18);
  if (i % 4 === 2) stab(t, ch.tones, 0.3);
});
songPad(DROP, END_GROOVE, 0.05);
melody(at("aya", 0), END_GROOVE, 0.1);

// The close: the groove stops and one warm D chord rings out.
{
  const t0 = END_GROOVE;
  songKick(t0, 0.7);
  stab(t0, [62, 66, 69, 74, 78], 1.4, 0.13);
  bassNote(t0, 38, 2.4, 0.26);
  [50, 57, 62, 66, 69, 74].forEach((m, i) => piano(t0 + i * 0.03, m, 0.07, SONG_END - t0, (i - 2.5) * 0.18));
  songPad(t0, SONG_END, 0.05);
}
target = dry;

// The song's filter (closed in the opening, open from the drop) and the
// side-chain that makes it pump against the kick.
{
  const tails = [reverb(songWet[0]), reverb(songWet[1])];
  for (let n = 0; n < N; n++) {
    song[0][n] += tails[0][n];
    song[1][n] += tails[1][n];
  }
  kicks.sort((a, b) => a - b);
  let k = 0;
  const y1 = [0, 0];
  const y2 = [0, 0];
  for (let n = 0; n < N; n++) {
    const t = n / SR;
    while (k + 1 < kicks.length && kicks[k + 1] <= t) k++;
    const since = kicks[k] !== undefined && t >= kicks[k] ? t - kicks[k] : 9;
    const duck = 1 - 0.45 * Math.exp(-since / 0.09);
    const cut = t < DROP ? 280 + 2400 * (t / DROP) ** 2.2 : 18000;
    const a = Math.exp((-2 * Math.PI * cut) / SR);
    for (const ch of [0, 1]) {
      y1[ch] = (1 - a) * song[ch][n] + a * y1[ch];
      y2[ch] = (1 - a) * y1[ch] + a * y2[ch];
      // Kicks were written into the song bus too; leave their low end undimmed by the duck.
      dry[ch][n] += y2[ch] * (t < DROP ? 1.15 : duck) * 0.9;
    }
  }
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
  const lp = lowpass(700);
  add(t0, dur, (t) => {
    const motor = lp(Math.sign(Math.sin(2 * Math.PI * 165 * t)) * 0.6 + Math.sin(2 * Math.PI * 330 * t) * 0.3) * 1.6;
    return motor * Math.min(1, t * 120) * Math.min(1, (dur - t) * 60) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 22 * t));
  }, { gain });
}

/** A soft mechanical key: a low thock and a small high click. */
function mechKey(t0, gain = 0.16, pan = 0) {
  const lp = lowpass(1800);
  add(t0, 0.06, (t) => Math.sin(2 * Math.PI * 140 * t) * Math.exp(-70 * t) * 0.9 + lp(rand()) * Math.exp(-90 * t) * 0.6 + Math.sin(2 * Math.PI * 4200 * t) * Math.exp(-260 * t) * 0.3, { gain, pan });
}

/** A high-end confirmation chime: two soft bell notes, a fifth apart. */
function confirm(t0, gain = 0.32) {
  tink(t0, -5, gain);
  tink(t0 + 0.11, 2, gain * 0.9);
  piano(t0 + 0.11, 86, 0.05, 1.6);
}

// 0:00–0:09 the phone: rings, buzzes for each missed call, pops for each DM.
for (const f of [2, 18]) haptic(at("missed", f), 0.36, 0.2);
[40, 60, 80, 98, 114].forEach((f) => { haptic(at("missed", f), 0.2, 0.17); pop(at("missed", f), 0.08, -12); });
swoosh(at("missed", 128), 0.35, 0.12);
[136, 142, 148, 154].forEach((f, i) => pop(at("missed", f), 0.16, 4 + i * 2, i % 2 ? 0.4 : -0.4));
[146, 160, 172, 183, 193, 202, 210, 217, 223, 229, 234, 239, 244, 248].forEach((f, i) => {
  haptic(at("missed", f), 0.1, 0.1);
  pop(at("missed", f), 0.08, -5 + i, -0.5 + (i % 5) * 0.25);
});
swoosh(at("missed", 252), 0.6, 0.16);

// 0:09 the flash: a crisp click and a high chime over the drop.
add(at("interrupt", 0), 0.02, (t) => (rand() * 0.6 + Math.sin(2 * Math.PI * 3000 * t)) * Math.exp(-300 * t), { gain: 0.3 });
tink(at("interrupt", 2), 0, 0.3);
tink(at("interrupt", 2) + 0.012, 7, 0.18);
tink(at("interrupt", 2) + 0.024, 12, 0.12);

// 0:13–0:23 the orb blooms; badges; soft mechanical typing; the site is read.
pop(at("aya", 84), 0.16, 2);
pop(at("aya", 94), 0.16, 5);
for (let k = 0; k < 19; k++) mechKey(at("aya", 128 + k * 2.4), 0.14, -0.2 + (k % 3) * 0.2);
tink(at("aya", 174), 7, 0.22);
for (let i = 0; i < 4; i++) pop(at("aya", 186 + i * 7), 0.11, 4 + i * 2, -0.4 + i * 0.25);

// 0:23–0:33 every conversation arriving, every booking a tink a step higher,
// the counter rolling.
for (let i = 0; i < 5; i++) pop(at("dashboard", 22 + i * 10), 0.13, -2 + i, -0.5 + i * 0.25);
for (let i = 0; i < 5; i++) {
  tink(at("dashboard", 92 + i * 30), i * 2, 0.2);
  for (let k = 0; k < 8; k++) add(at("dashboard", 92 + i * 30 + k * 2), 0.02, (t) => Math.sin(2 * Math.PI * 5200 * t) * Math.exp(-300 * t), { gain: 0.04 });
}

// 0:33–0:38 Stripe's sheet, the card, pay, the confirmation chime, coins,
// healdesk's notification.
swoosh(at("deposit", 0), 0.5, 0.15);
for (let k = 0; k < 12; k++) mechKey(at("deposit", 22 + k * 0.72), 0.07);
add(at("deposit", 46), 0.06, (t) => Math.sin(2 * Math.PI * 200 * t) * Math.exp(-60 * t), { gain: 0.28 });
confirm(at("deposit", 58), 0.34);
for (let k = 0; k < 8; k++) tink(at("deposit", 60 + k * 2), 12 + (k % 4) * 2, 0.035);
pop(at("deposit", 74), 0.18, 7);

// 0:38–0:42 the address.
tink(at("close", 52), 7, 0.14);

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
