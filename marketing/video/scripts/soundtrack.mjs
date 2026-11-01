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

// An original track in the style the owner chose (1 November 2026): warm,
// modern electronic in the manner of Bicep, a clean synth riff from the first
// beat over a subtle house beat at 122 BPM, lifting on the drop into a full
// groove with a broken-beat snare and a warm pad. Nothing here is taken from
// any existing record. Bars are laid so the drop lands on the cut to "Not on
// my watch."
const BPM = TIMELINE.bpm;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const S16 = BEAT / 4;
const DROP = at("interrupt", 0);
const GRID = DROP - Math.floor(DROP / BAR) * BAR; // the first downbeat after 0
const END_GROOVE = at("close", 0);
const SONG_END = f2s(S.close.to);
const CUTS = [at("aya", 0), at("dashboard", 0), at("deposit", 0)];

// vi – IV – I – V in C: Am, F, C, G. Melancholy that lifts.
const PROG = [
  { root: 45, tones: [57, 60, 64, 69] }, // Am
  { root: 41, tones: [57, 60, 65, 69] }, // F
  { root: 48, tones: [55, 60, 64, 67] }, // C
  { root: 43, tones: [55, 59, 62, 67] }, // G
];
const chordAt = (t) => PROG[Math.floor((t - GRID) / BAR + 400) % PROG.length];

// A band-limited saw, read from one table, so the synths stay cheap and clean.
const TABLE = 4096;
const SAW = new Float32Array(TABLE);
for (let i = 0; i < TABLE; i++) for (let h = 1; h <= 24; h++) SAW[i] += (Math.sin((2 * Math.PI * h * i) / TABLE) / h) * 0.55;
const saw = (phase) => SAW[Math.floor((((phase % 1) + 1) % 1) * TABLE)];

/** An RBJ band-pass, as a stateful step function. */
function bandpass(f, q) {
  const w = (2 * Math.PI * f) / SR;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0;
  const b2 = -alpha / a0;
  const a1 = (-2 * Math.cos(w)) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => {
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
}

const kicks = [];
function songKick(t0, gain = 1) {
  kicks.push(t0);
  add(t0, 0.38, (t) => Math.tanh(1.8 * (Math.sin(2 * Math.PI * (52 * t + (150 / 28) * (1 - Math.exp(-28 * t)))) * Math.exp(-8 * t))) + (t < 0.003 ? rand() * 0.8 : 0), { gain });
}
/** The stomp-clap on 2 and 4: a low thump under a layered clap and a snare's crack. */
function stompClap(t0, gain = 0.42) {
  const lp = lowpass(5200);
  const lp2 = lowpass(1100);
  add(t0, 0.32, (t) => {
    const burst = [0, 0.009, 0.019].some((o) => t >= o && t < o + 0.007) ? 1 : 0;
    const n = lp(rand());
    const clap = (n - lp2(n)) * (burst * 1.3 + Math.exp(-16 * t));
    const thump = Math.sin(2 * Math.PI * (55 + 50 * Math.exp(-40 * t)) * t) * Math.exp(-18 * t);
    return clap * 0.9 + thump * 0.8;
  }, { gain, send: 0.3 });
}
function hat(t0, open = false, gain = 0.09, pan = 0.2) {
  const lp = lowpass(8000);
  add(t0, open ? 0.2 : 0.045, (t) => {
    const n = rand();
    return (n - lp(n)) * Math.exp((open ? -15 : -80) * t);
  }, { gain, pan });
}
function bassNote(t0, m, dur, gain = 0.3) {
  const f = midi(m);
  let ph = 0;
  let y = 0;
  add(t0, dur, (t) => {
    ph += f / SR;
    const cut = 260 + 2200 * Math.exp(-22 * t);
    const a = Math.exp((-2 * Math.PI * cut) / SR);
    y = (1 - a) * (saw(ph) * 0.6 + Math.sin(2 * Math.PI * ph) * 0.8) + a * y;
    return Math.tanh(y * 1.4) * Math.min(1, t * 500) * Math.min(1, (dur - t) * 70);
  }, { gain });
}
/** The house piano: a bright chord, short and percussive, on the offbeat. */
function housePiano(t0, tones, gain = 0.1) {
  tones.forEach((m, i) => piano(t0 + i * 0.004, m + 12, gain, 0.42, (i - 1.5) * 0.2));
  piano(t0, tones[0], gain * 0.6, 0.42);
}
/** A vowel chop: a saw shaped by two formants, the "oh" of a pop hook. */
const VOWELS = { ah: [730, 1090], oh: [570, 840], ee: [300, 2250] };
function chop(t0, m, vowel = "ah", dur = 0.16, gain = 0.16, pan = 0) {
  const f = midi(m);
  const [f1, f2] = VOWELS[vowel];
  const b1 = bandpass(f1, 6);
  const b2 = bandpass(f2, 8);
  let ph = 0;
  add(t0, dur + 0.05, (t) => {
    ph += (f * (1 - 0.03 * Math.exp(-40 * t))) / SR;
    const x = saw(ph);
    const v = b1(x) * 1.0 + b2(x) * 0.7;
    return v * 3 * Math.min(1, t * 250) * (t < dur ? 1 : Math.exp(-40 * (t - dur)));
  }, { gain, pan, send: 0.35 });
}
function songPad(t0, t1, gain = 0.05) {
  for (let t = t0; t < t1; t += BAR) {
    const ch = chordAt(t + 0.01);
    const len = Math.min(BAR + 0.5, t1 - t);
    const vs = ch.tones.map((m) => ({ f: midi(m), ph: 0 }));
    let y = 0;
    add(t, len, (tt) => {
      let v = 0;
      for (const vc of vs) {
        vc.ph += vc.f / SR;
        v += saw(vc.ph) + saw(vc.ph * 1.004);
      }
      const a = Math.exp((-2 * Math.PI * 1700) / SR);
      y = (1 - a) * (v / 8) + a * y;
      return y * Math.min(1, tt / 0.3) * Math.min(1, (len - tt) / 0.4);
    }, { gain, send: 0.6 });
  }
}
/** A cut hit: a crash and a low boom. */
function hit(t0, gain = 0.3) {
  const lp = lowpass(9000);
  add(t0, 1.4, (t) => {
    const n = rand();
    return (n - lp(n)) * Math.exp(-3 * t) * 1.1 + Math.sin(2 * Math.PI * (40 + 60 * Math.exp(-20 * t)) * t) * Math.exp(-5 * t) * 0.9;
  }, { gain, send: 0.5 });
}


/** The riff's voice: a clean pluck, two saws a hair apart, a quick filter. */
function riffNote(t0, m, gain = 0.12, pan = 0) {
  const f = midi(m);
  let p1 = 0, p2 = 0.3, y = 0;
  add(t0, 0.5, (t) => {
    p1 += f / SR;
    p2 += (f * 1.004) / SR;
    const cut = 700 + 5200 * Math.exp(-16 * t);
    const a = Math.exp((-2 * Math.PI * cut) / SR);
    y = (1 - a) * (saw(p1) + saw(p2)) * 0.5 + a * y;
    return y * Math.min(1, t * 600) * Math.exp(-6 * t) * 1.6;
  }, { gain, pan, send: 0.45 });
}
/** The riff, with a ping-pong delay a dotted eighth behind. */
const RIFF = [
  [0, 3], [3, 2], [6, 3], [8, 1], [10, 2], [12, 3], [14, 0],
];
function riff(t0, t1, gain = 0.12) {
  for (let b = 0; t0 + b * BAR < t1; b++) {
    const barStart = t0 + b * BAR;
    const ch = chordAt(barStart + 0.01);
    for (const [pos, k] of RIFF) {
      const t = barStart + pos * S16;
      if (t >= t1) continue;
      const m = ch.tones[k] + 12;
      riffNote(t, m, gain, 0);
      riffNote(t + 3 * S16, m, gain * 0.42, -0.6);
      riffNote(t + 6 * S16, m, gain * 0.18, 0.6);
    }
  }
}
/** A soft shaker, sixteenths with a lilt. */
function shaker(t0, gain = 0.035) {
  const lp = lowpass(9000);
  const lp2 = lowpass(3500);
  add(t0, 0.06, (t) => {
    const n = lp(rand());
    return (n - lp2(n)) * Math.exp(-55 * t);
  }, { gain, pan: 0.3 });
}
/** A broken-beat snare: crack and body, with ghosts. */
function snare(t0, gain = 0.3) {
  const lp = lowpass(7000);
  const lp2 = lowpass(1400);
  add(t0, 0.25, (t) => {
    const n = lp(rand());
    return (n - lp2(n)) * Math.exp(-20 * t) + Math.sin(2 * Math.PI * 190 * t) * Math.exp(-30 * t) * 0.5;
  }, { gain, send: 0.35 });
}

target = song;
const beats = (from, to, fn) => {
  for (let i = Math.ceil((from - GRID) / BEAT - 1e-6); GRID + i * BEAT < to - 1e-6; i++) fn(GRID + i * BEAT, i);
};
// A half-beat of nothing before the drop and before the close.
const stopped = (t) => (t >= DROP - BEAT / 2 && t < DROP) || (t >= END_GROOVE - BEAT / 2 && t < END_GROOVE);

// From the first beat: the riff, the pad, a sub on the roots, a soft kick on
// one and three, a shaker. Enough to grab the ear in the first three seconds,
// leaving room for the lift.
riff(GRID - BAR, DROP - BEAT / 2, 0.11);
songPad(GRID - BAR, DROP - BEAT / 2, 0.045);
beats(0, DROP, (t, i) => {
  if (stopped(t)) return;
  if (i % 2 === 0) songKick(t, 0.6);
  if (i % 4 === 2) snare(t, 0.12);
  shaker(t + S16 * 2);
  shaker(t + S16 * 3, 0.02);
  if (i % 4 === 0) bassNote(t, chordAt(t + 0.01).root, BAR * 0.9, 0.2);
});
{
  // A rising sweep into the drop.
  const lpA = lowpass(10000);
  let lpB = 0;
  const t0 = DROP - 2.2;
  add(t0, 2.2 - BEAT / 2, (t) => {
    const cut = 300 + 7000 * (t / 2.2) ** 2;
    const a = Math.exp((-2 * Math.PI * cut) / SR);
    const n = lpA(rand());
    lpB = (1 - a) * n + a * lpB;
    return (n - lpB) * (t / 2.2) ** 1.6;
  }, { gain: 0.2, send: 0.5 });
}

// The lift: a full, warm house groove with a broken-beat snare layer.
hit(DROP, 0.3);
for (const cut of CUTS) hit(cut, 0.18);
beats(DROP, END_GROOVE, (t, i) => {
  if (stopped(t)) return;
  const ch = chordAt(t + 0.01);
  songKick(t, 0.95);
  if (i % 2 === 1) stompClap(t, 0.26);
  if (i % 4 === 3) snare(t + 2 * S16, 0.1);
  if (i % 8 === 6) snare(t + 3 * S16, 0.08);
  hat(t + BEAT / 2, true, 0.06, 0.25);
  shaker(t + S16);
  shaker(t + S16 * 3, 0.025);
  bassNote(t + BEAT / 2, ch.root, BEAT * 0.42, 0.28);
  if (i % 4 === 3) bassNote(t + 3 * S16, ch.root + 12, S16 * 0.9, 0.18);
});
songPad(DROP, END_GROOVE - BEAT / 2, 0.055);
riff(DROP, END_GROOVE - BEAT / 2, 0.12);

// The close: the groove stops, one warm chord rings out with the riff's last note.
{
  const t0 = END_GROOVE;
  songKick(t0, 0.8);
  hit(t0, 0.24);
  [45, 57, 60, 64, 69, 72, 76].forEach((m, i) => piano(t0 + i * 0.025, m, 0.075, SONG_END - t0, (i - 3) * 0.15));
  bassNote(t0, 33, 2.6, 0.24);
  riffNote(t0 + BEAT, 81, 0.1);
  riffNote(t0 + BEAT * 1.75, 81, 0.04, -0.6);
  songPad(t0, SONG_END, 0.05);
}
target = dry;

// The side-chain that makes the music breathe against the kick.
{
  const tails = [reverb(songWet[0]), reverb(songWet[1])];
  for (let n = 0; n < N; n++) {
    song[0][n] += tails[0][n];
    song[1][n] += tails[1][n];
  }
  kicks.sort((a, b) => a - b);
  let k = 0;
  for (let n = 0; n < N; n++) {
    const t = n / SR;
    while (k + 1 < kicks.length && kicks[k + 1] <= t) k++;
    const since = kicks[k] !== undefined && t >= kicks[k] ? t - kicks[k] : 9;
    const duck = 1 - 0.38 * Math.exp(-since / 0.1);
    for (const ch of [0, 1]) dry[ch][n] += song[ch][n] * (since < 0.012 ? 1 : duck) * 0.9;
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

// The scenes after the drop are cut on the beat; these frames match the
// scene files (beats of 14.75 frames at 122 BPM).
const SB = (FPS * 60) / BPM;
const b = (n) => Math.round(n * SB);

// Aya: two badges; then the website types in on soft mechanical keys, a
// chime when it is read, the treatments settle.
pop(at("aya", 54), 0.12, 2);
const TYPE_FROM = b(9) + 22;
for (let k = 0; k < 19; k++) mechKey(at("aya", TYPE_FROM + k * 2.4), 0.13, -0.2 + (k % 3) * 0.2);
const READ = TYPE_FROM + 19 * 2.4;
tink(at("aya", READ), 7, 0.2);
for (let i = 0; i < 3; i++) pop(at("aya", READ + 14 + i * 6), 0.1, 4 + i * 2, -0.4 + i * 0.4);

// The five channels; then each booking flies into the counter on the beat, a
// whoosh and a tink a step higher, the digits rolling.
for (let i = 0; i < 5; i++) pop(at("dashboard", 26 + i * 4), 0.11, -2 + i, -0.5 + i * 0.25);
for (let i = 0; i < 5; i++) {
  const land = b(6) + i * b(2);
  if (i > 0) swoosh(at("dashboard", land - 18), 0.55, 0.08, i % 2 ? 0.5 : -0.5);
  tink(at("dashboard", land), i * 2, 0.19);
  for (let k = 0; k < 6; k++) add(at("dashboard", land + k * 2), 0.02, (t) => Math.sin(2 * Math.PI * 5200 * t) * Math.exp(-300 * t), { gain: 0.035 });
}

// The card rises, the button is pressed, the confirmation chime, healdesk's
// notification.
swoosh(at("deposit", 0), 0.5, 0.11);
add(at("deposit", b(2)), 0.06, (t) => Math.sin(2 * Math.PI * 200 * t) * Math.exp(-60 * t), { gain: 0.26 });
confirm(at("deposit", b(3)), 0.32);
pop(at("deposit", b(4)), 0.16, 7);

// The end card lands.
tink(at("close", 28), 7, 0.15);

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
