// Builds the ad's soundtrack: an original track and every sound effect,
// synthesised here, so the ad needs no licensed or bought audio (owner,
// 1 November 2026). Every time comes from src/timeline.mjs, the picture's
// own timeline, so the music and the effects stay on the cuts.
//
// Usage: node scripts/soundtrack.mjs [out.wav]
// Writes 48 kHz stereo, 32-bit float, peaking at -1 dBFS. scripts/master.mjs
// then sets its loudness for the platforms. Deterministic: the noise comes
// from a seeded generator, so the same code always makes the same file.

import { writeFileSync } from "node:fs";

import { BPM, CUES, DROP_SECONDS, DURATION, FPS, GRID as GRID_FRAMES, shot } from "../src/timeline.mjs";

const SR = 48000;
const LENGTH = DURATION / FPS;
const N = Math.ceil(LENGTH * SR);
const OUT = process.argv[2] ?? "public/soundtrack.raw.wav";

const BEAT = 60 / BPM;
const BAR = 4 * BEAT;
const S16 = BEAT / 4;
const DROP = DROP_SECONDS;
/** The first downbeat; the drop falls exactly four bars after it. */
const GRID = GRID_FRAMES / FPS;
/** Seconds of beat `b` after the drop. */
const beat = (b) => DROP + b * BEAT;
/** Seconds of frame `f` of shot `id`, where the picture puts a cue. */
const cue = (id, f) => (shot(id).from + f) / FPS;
const CHANNELS = beat(shot("channels").beat);
const LINE = beat(shot("line").beat);
const CLOSE = beat(shot("close").beat);

// Seeded noise (mulberry32), -1 to 1.
let seed = 20261101;
function rand() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
}
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

// ---------------------------------------------------------------- buses

const stereo = () => [new Float32Array(N), new Float32Array(N)];
const drums = stereo(); // the beat, never ducked
const music = stereo(); // the tonal parts, side-chained to the kick
const musicVerb = stereo(); // the song's reverb send
const echo = stereo(); // the riff's ping-pong delay send
const sfx = stereo(); // the effects, never ducked
const sfxVerb = stereo();

/**
 * Render a voice into a bus: `fn(t)` returns a sample, mono or [left, right],
 * for `dur` seconds from `start`. A mono voice is placed by `pan` (-1 to 1);
 * `verb` and `delay` feed the sends.
 */
function add(bus, start, dur, fn, { gain = 1, pan = 0, verb = 0, delay = 0 } = {}) {
  const send = bus === sfx ? sfxVerb : musicVerb;
  const s0 = Math.round(start * SR);
  const len = Math.round(dur * SR);
  const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4);
  const gr = gain * Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = 0; i < len; i++) {
    const k = s0 + i;
    if (k >= N) break;
    const v = fn(i / SR); // always called, so a voice that starts before 0 keeps its state
    if (k < 0) continue;
    const l = typeof v === "number" ? v * gl : v[0] * gain;
    const r = typeof v === "number" ? v * gr : v[1] * gain;
    bus[0][k] += l;
    bus[1][k] += r;
    if (verb) {
      send[0][k] += l * verb;
      send[1][k] += r * verb;
    }
    if (delay) {
      echo[0][k] += l * delay;
      echo[1][k] += r * delay;
    }
  }
}

// ---------------------------------------------------------------- DSP

/** Simper's trapezoidal state-variable filter: stable while its cutoff moves. */
function svf(cutoff, q = 0.707) {
  let ic1 = 0;
  let ic2 = 0;
  let fc = -1;
  let a1 = 0;
  let a2 = 0;
  let a3 = 0;
  const k = 1 / q;
  const out = { lp: 0, bp: 0, hp: 0 };
  const set = (f) => {
    fc = f;
    const g = Math.tan((Math.PI * Math.min(Math.max(f, 10), SR * 0.45)) / SR);
    a1 = 1 / (1 + g * (g + k));
    a2 = g * a1;
    a3 = g * a2;
  };
  set(cutoff);
  return (x, f) => {
    if (f !== undefined && f !== fc) set(f);
    const v3 = x - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    out.lp = v2;
    out.bp = v1;
    out.hp = x - k * v1 - v2;
    return out;
  };
}

/** A band-limited sawtooth (PolyBLEP); call with the frequency each sample. */
function saw(phase = Math.abs(rand())) {
  let ph = phase;
  return (f) => {
    const dt = f / SR;
    ph += dt;
    if (ph >= 1) ph -= 1;
    let v = 2 * ph - 1;
    if (ph < dt) {
      const t = ph / dt;
      v -= t + t - t * t - 1;
    } else if (ph > 1 - dt) {
      const t = (ph - 1) / dt;
      v -= t * t + t + t + 1;
    }
    return v;
  };
}

/** A sine whose frequency may move; call with the frequency each sample. */
function sine(phase = 0) {
  let ph = phase;
  return (f) => {
    ph += f / SR;
    if (ph >= 1) ph -= 1;
    return Math.sin(2 * Math.PI * ph);
  };
}

/** Struck glass: inharmonic partials, the first ringing longest. */
const GLASS = [[1, 1, 2.6], [2.756, 0.42, 4.5], [5.404, 0.18, 7], [8.933, 0.07, 11]];
function glass(t, f, decay = 1) {
  let v = 0;
  for (const [m, a, d] of GLASS) if (f * m < SR * 0.45) v += a * Math.sin(2 * Math.PI * f * m * t) * Math.exp((-d / decay) * t);
  return v * Math.min(1, t * 2000);
}

// ---------------------------------------------------------------- the song

// An original track in the style the owner chose: warm, modern electronic in
// the manner of Bicep's "Glue", a clean synth riff from the first frame over
// a subtle house beat at 122 BPM, lifting on the drop into a full groove.
// Nothing here is taken from any record.
//
// vi – IV – I – V in C as Am9, Fmaj9, Cmaj9, G6/9: one upper voicing that
// barely moves over a walking bass, melancholy that lifts. Every melodic
// note, the riff's and the effects', is from A minor pentatonic (A C D E G),
// which sits inside all four chords.
const CHORDS = [
  { root: 33, pad: [57, 60, 64, 67, 71] }, // Am9: A | A C E G B
  { root: 29, pad: [57, 60, 64, 67, 72] }, // Fmaj9: F | A C E G C
  { root: 36, pad: [55, 59, 62, 64, 67] }, // Cmaj9: C | G B D E G
  { root: 31, pad: [55, 59, 62, 64, 69] }, // G6/9: G | G B D E A
];
/** The close resolves to the I chord instead of the IV the cycle would bring. */
const FINAL = { root: 36, pad: [55, 59, 64, 67, 71, 74] };
const chordAt = (t) => (t >= CLOSE - 1e-6 ? FINAL : CHORDS[(((Math.floor((t - GRID) / BAR + 1e-6)) % 4) + 4) % 4]);

// The hook: the same syncopated rhythm every bar (dotted eighths, then
// eighths), its notes following the chord.
const RIFF_STEPS = [0, 3, 6, 8, 10, 12, 14];
const RIFF_NOTES = [
  [76, 79, 81, 76, 74, 72, 74], // over Am9: E G A E D C D
  [72, 76, 79, 76, 74, 69, 72], // over Fmaj9: C E G E D A C
  [79, 76, 74, 76, 79, 81, 79], // over Cmaj9: G E D E G A G
  [74, 76, 79, 74, 69, 74, 76], // over G6/9: D E G D A D E
];

const kicks = [];

function kick(t0, gain) {
  kicks.push(t0);
  const body = sine(0.25);
  const lp = svf(5000);
  add(drums, t0, 0.42, (t) => {
    const f = 50 + 110 * Math.exp(-t / 0.03);
    const b = body(f) * Math.exp(-t / 0.17);
    // A soft knock rather than a noise click: it carries on a phone's speaker.
    const knock = lp(Math.sin(2 * Math.PI * 1900 * t) * Math.exp(-t / 0.0035), 3200).lp * 0.35;
    return Math.tanh(1.7 * (b + knock)) * Math.min(1, t * 1500) * Math.min(1, (0.42 - t) * 60);
  }, { gain });
}

function clap(t0, gain = 0.3) {
  const fl = svf(1500, 1.1);
  const fr = svf(1650, 1.1);
  const hl = svf(4500, 0.7);
  const hr = svf(4800, 0.7);
  add(drums, t0, 0.36, (t) => {
    const bursts = [0, 0.0085, 0.0175].some((o) => t >= o && t < o + 0.0055) ? 1 : 0;
    const env = bursts * 0.9 + Math.exp(-t / 0.075) * (t > 0.0175 ? 1 : 0.3);
    const snap = Math.exp(-t / 0.03);
    const body = Math.sin(2 * Math.PI * 205 * t) * Math.exp(-t / 0.025) * 0.4;
    const a = Math.min(1, t / 0.0007);
    return [(fl(rand()).bp * env * 2.4 + hl(rand()).hp * snap * 0.9 + body) * a, (fr(rand()).bp * env * 2.4 + hr(rand()).hp * snap * 0.9 + body) * a];
  }, { gain, verb: 0.28 });
}

/** A rim or ghost snare: a short crack and a little body. */
function rim(t0, gain = 0.12, pan = 0) {
  const f = svf(2400, 1.4);
  add(drums, t0, 0.12, (t) => f(rand()).bp * 2.2 * Math.exp(-t / 0.028) + Math.sin(2 * Math.PI * 330 * t) * Math.exp(-t / 0.02) * 0.6, { gain, pan, verb: 0.2 });
}

// Hats as an 808 makes them: six square waves at inharmonic pitches, high-passed.
const HAT_PITCHES = [263, 400, 421, 474, 587, 845].map((f) => f * 1.55);
function hat(t0, open, gain, pan) {
  const f1 = svf(9500, 1.3);
  const f2 = svf(7200, 0.7);
  const ph = HAT_PITCHES.map(() => Math.abs(rand()));
  const dur = open ? 0.32 : 0.06;
  add(drums, t0, dur, (t) => {
    let m = 0;
    for (let i = 0; i < 6; i++) m += (((ph[i] + HAT_PITCHES[i] * t) % 1) < 0.5 ? 1 : -1);
    const x = f2(f1(m / 6 + rand() * 0.25).bp).hp;
    return x * Math.exp(-t / (open ? 0.1 : 0.017)) * Math.min(1, t * 3000);
  }, { gain, pan, verb: open ? 0.12 : 0.04 });
}

function shaker(t0, gain, pan) {
  const f = svf(7200, 1.6);
  add(drums, t0, 0.08, (t) => f(rand()).bp * Math.min(1, t / 0.004) * Math.exp(-t / 0.028), { gain, pan });
}

/**
 * The bass: a sine on the root with a filtered saw an octave above it,
 * saturated so that a phone, which plays nothing this low, still hears its
 * harmonics.
 */
function bass(t0, midi, dur, gain = 0.3, sub = 1, decay = 1.2) {
  const s = saw();
  const o = sine();
  const f = svf(400, 0.9);
  const fq = hz(midi);
  add(music, t0, dur, (t) => {
    const cut = 420 + 2400 * Math.exp(-t / 0.07);
    const x = f(s(fq * 2) * 0.85, cut).lp + o(fq) * 0.6 * sub;
    return Math.tanh(1.8 * x) * Math.exp(-t / decay) * Math.min(1, t * 400) * Math.min(1, (dur - t) * 80);
  }, { gain });
}

/** The riff's voice: two saws a few cents apart, a quick filter pluck. */
function riffNote(t0, midi, gain, bright) {
  const a = saw();
  const b = saw();
  const f = svf(1000, 1.2);
  const fq = hz(midi);
  add(music, t0, 0.5, (t) => {
    const cut = bright * (900 + 7000 * Math.exp(-t / 0.11));
    return f((a(fq * 1.0035) + b(fq * 0.9965)) * 0.5, cut).lp * Math.min(1, t * 700) * Math.exp(-t / 0.22) * Math.min(1, (0.5 - t) * 40);
  }, { gain, verb: 0.3, delay: 0.32 });
}

function riff(from, to, gain, brightness) {
  const first = Math.floor((from - GRID) / BAR);
  for (let bar = first; GRID + bar * BAR < to; bar++) {
    const barStart = GRID + bar * BAR;
    const notes = RIFF_NOTES[((bar % 4) + 4) % 4];
    RIFF_STEPS.forEach((step, i) => {
      const t = barStart + step * S16;
      if (t < from - 1e-6 || t >= to) return;
      riffNote(t, notes[i], gain * (i === 0 ? 1 : 0.86), brightness(t));
    });
  }
}

/**
 * The pad: each chord tone as three detuned saws spread across the stereo
 * field, a chord a bar, or one held chord (`hold`) that fades over `release`.
 */
function pad(from, to, gain, cutoff = 1900, { hold = false, release = 0.35 } = {}) {
  const spans = [];
  if (hold) spans.push([from, to]);
  else for (let b = Math.floor((from - GRID) / BAR + 1e-6); GRID + b * BAR < to - 1e-6; b++) spans.push([Math.max(from, GRID + b * BAR), Math.min(to, GRID + (b + 1) * BAR)]);
  for (const [start, end] of spans) {
    const ch = chordAt(start + 0.01);
    const len = end - start + (hold ? 0 : release);
    const voices = ch.pad.map((m, i) => ({ f: hz(m), pan: -0.75 + (1.5 * i) / (ch.pad.length - 1), osc: [saw(), saw(), saw()] }));
    const fl = svf(cutoff, 0.6);
    const fr = svf(cutoff, 0.6);
    add(music, start, len, (tt) => {
      let l = 0;
      let r = 0;
      for (const v of voices) {
        const x = v.osc[0](v.f * 0.9942) + v.osc[1](v.f) + v.osc[2](v.f * 1.0058);
        l += x * (1 - v.pan) * 0.5;
        r += x * (1 + v.pan) * 0.5;
      }
      const env = Math.min(1, tt / 0.18) * Math.min(1, (len - tt) / release);
      const c = cutoff * (1 + 0.12 * Math.sin(2 * Math.PI * 0.11 * (start + tt)));
      return [fl(l, c).lp * env * 0.1, fr(r, c).lp * env * 0.1];
    }, { gain, verb: 0.45 });
  }
}

/** A chord stab on the offbeat, band-limited to the mids, where a phone speaker lives. */
function stab(t0, gain) {
  const ch = chordAt(t0 + 0.01);
  const osc = ch.pad.map(() => saw());
  const f = svf(1300, 0.8);
  add(music, t0, 0.2, (t) => {
    let x = 0;
    ch.pad.forEach((m, i) => (x += osc[i](hz(m))));
    return f(x / ch.pad.length, 1400 + 2600 * Math.exp(-t / 0.05)).bp * 2.2 * Math.exp(-t / 0.07) * Math.min(1, t * 900);
  }, { gain, pan: 0, verb: 0.25, delay: 0.12 });
}

/** A felt piano note: a soft hammer and a few decaying harmonics. */
function piano(t0, midi, gain, dur, pan = 0) {
  const fq = hz(midi);
  add(music, t0, dur, (t) => {
    let v = 0;
    [[1, 1, 0.8], [2, 0.32, 1.5], [3, 0.12, 2.3], [4, 0.05, 3.1]].forEach(([h, a, d]) => (v += a * Math.sin(2 * Math.PI * fq * h * t * (1 + 0.0004 * h)) * Math.exp(-d * t)));
    return v * Math.min(1, t * 150) * Math.min(1, (dur - t) / 0.6);
  }, { gain, pan, verb: 0.5 });
}

function crash(t0, gain = 0.16, dur = 2.2) {
  const fl = svf(5200, 0.7);
  const fr = svf(5600, 0.7);
  add(drums, t0, dur, (t) => {
    const env = Math.exp(-t / 0.65) * Math.min(1, t * 2000);
    return [fl(rand()).hp * env, fr(rand()).hp * env];
  }, { gain, verb: 0.35 });
}

/** The impact on the drop: a sub that falls in pitch, and a low thump. */
function impact(t0, gain = 0.5) {
  const o = sine();
  const lp = svf(180, 0.7);
  add(drums, t0, 1.6, (t) => Math.tanh(1.5 * (o(32 + 30 * Math.exp(-t / 0.18)) * Math.exp(-t / 0.55) + lp(rand()).lp * Math.exp(-t / 0.06) * 1.5)), { gain });
}

/** Noise swelling through a rising band-pass into `t1`. */
function riser(t0, t1, gain = 0.12) {
  const fl = svf(400, 1.4);
  const fr = svf(400, 1.4);
  const dur = t1 - t0;
  add(drums, t0, dur, (t) => {
    const p = t / dur;
    const c = 350 * 22 ** p;
    return [fl(rand(), c).bp * p ** 1.8 * 2, fr(rand(), c * 1.07).bp * p ** 1.8 * 2];
  }, { gain, verb: 0.4 });
}

/** A cymbal played backwards, swelling into `t1`. */
function reverseCymbal(t1, dur = 0.7, gain = 0.1) {
  const fl = svf(6000, 0.7);
  const fr = svf(6400, 0.7);
  add(drums, t1 - dur, dur, (t) => {
    const env = Math.exp(-(dur - t) / 0.25);
    return [fl(rand()).hp * env, fr(rand()).hp * env];
  }, { gain });
}

// The intro, 0:00–0:09. The riff from the first frame, its filter opening
// bar by bar, over the pad and a sub; the beat builds a layer a bar (kick on
// one and three, then rims and shaker, then four on the floor and hats, then
// a snare run and a riser). It stops half a beat before the drop.
const STOP = DROP - BEAT / 2;
riff(-0.3, STOP, 0.19, (t) => 0.45 + 0.55 * Math.min(1, Math.max(0, t / STOP)) ** 1.4);
pad(0, STOP, 0.75, 1800);
// A pickup into the first downbeat, so the beat is there from the first second.
[8, 10, 12, 13, 14, 15].forEach((step, i) => rim(GRID - BAR + step * S16, 0.05 + 0.012 * i, i % 2 ? 0.2 : -0.2));
reverseCymbal(GRID, 0.5, 0.06);
for (let bar = 0; bar < 4; bar++) {
  const b0 = GRID + bar * BAR;
  bass(b0, chordAt(b0 + 0.01).root, BAR * 0.92, 0.2, 0.7);
  for (let i = 0; i < 4; i++) {
    const t = b0 + i * BEAT;
    if (t >= STOP) continue;
    if (bar >= 2 || i % 2 === 0) kick(t, bar >= 2 ? 0.6 : 0.52);
    if (bar >= 1 && i % 2 === 1) rim(t, 0.13 + 0.03 * bar, -0.1);
    for (let s = 0; s < 4; s++) if (bar >= 1 || s % 2 === 0) shaker(t + s * S16 + (s % 2 ? S16 * 0.12 : 0), s % 2 ? 0.045 : 0.07, 0.35);
    if (bar >= 2) hat(t + BEAT / 2, false, 0.18, 0.25);
  }
}
// The snare run in the last bar, eighths then sixteenths, rising.
for (let i = 0; i < 12; i++) {
  const t = GRID + 3 * BAR + (i < 4 ? i * 2 * S16 : 8 * S16 + (i - 4) * S16);
  if (t < STOP) rim(t, 0.05 + 0.012 * i, i % 2 ? 0.15 : -0.15);
}
riser(DROP - 2 * BAR, STOP, 0.14);
reverseCymbal(DROP, 0.6, 0.1);

// The drop, 0:09: an impact and a crash, then the full groove until the close.
impact(DROP, 0.35);
crash(DROP, 0.2);
const GROOVE_END = CLOSE - BEAT / 2;
riff(DROP, GROOVE_END, 0.26, (t) => (t >= CHANNELS ? 1.3 : 1.1));
pad(DROP, GROOVE_END, 1.2, 5000);
for (let i = 0; beat(i) < GROOVE_END - 1e-6; i++) {
  const t = beat(i);
  const lift = t >= CHANNELS;
  const ch = chordAt(t + 0.01);
  kick(t, 0.75);
  if (i % 2 === 1) clap(t, 0.45);
  hat(t + BEAT / 2, true, 0.24, -0.3);
  for (const s of [1, 3]) hat(t + s * S16, false, s === 3 ? 0.18 : 0.14, 0.3);
  if (lift) for (const s of [0, 1, 2, 3]) shaker(t + s * S16 + (s % 2 ? S16 * 0.12 : 0), s % 2 ? 0.055 : 0.08, -0.45);
  bass(t + BEAT / 2, ch.root, BEAT * 0.42, 0.3, 0.6);
  if (i % 4 === 3) bass(t + 3 * S16, ch.root + 12, S16 * 0.9, 0.18, 0.3);
  stab(t + BEAT / 2, lift ? 0.13 : 0.11);
  if (i % 8 === 6) rim(t + 3 * S16, 0.06, 0.2);
  if (i % 4 === 1) rim(t + 3 * S16, 0.045, -0.2);
}
// Fills into the two cuts to black, and a crash on each.
for (const at of [CHANNELS, LINE]) {
  rim(at - 2 * S16, 0.11, -0.1);
  rim(at - S16, 0.14, 0.1);
  reverseCymbal(at, 0.45, 0.07);
  crash(at, 0.1, 1.6);
}

// The close, 0:35.5: the groove stops half a beat early; on the cut one last
// kick, a crash, and the I chord rings out under the end card.
{
  kick(CLOSE, 0.7);
  crash(CLOSE, 0.17, 3);
  impact(CLOSE, 0.2);
  const tail = LENGTH - CLOSE;
  pad(CLOSE, LENGTH, 0.9, 1700, { hold: true, release: 2.2 });
  FINAL.pad.forEach((m, i) => piano(CLOSE + i * 0.03, m, 0.05, tail, -0.5 + i * 0.2));
  piano(CLOSE, 48, 0.06, tail);
  bass(CLOSE, 36, 3.2, 0.22, 1, 0.9);
  riffNote(CLOSE + BEAT, 79, 0.12, 0.9);
  riffNote(CLOSE + 2 * BEAT, 76, 0.08, 0.8);
}

// ---------------------------------------------------------------- effects

/** A notification: a soft glassy pop on a note of the scale. */
function pop(t0, midi, gain = 0.1, pan = 0) {
  const f = hz(midi);
  add(sfx, t0, 0.5, (t) => Math.sin(2 * Math.PI * f * t * (1 + 0.6 * Math.exp(-t / 0.006))) * Math.exp(-t / 0.05) * 0.8 + glass(t, f * 2, 0.35) * 0.35, { gain, pan, verb: 0.25 });
}

/** A booking or a confirmation: a struck glass note. */
function tink(t0, midi, gain = 0.12, pan = 0) {
  add(sfx, t0, 2.2, (t) => glass(t, hz(midi)), { gain, pan, verb: 0.45 });
}

/** A phone's vibration motor: a buzz with a rough edge, rich enough in harmonics to be heard on a phone. */
function buzz(t0, dur, gain = 0.1) {
  const f = svf(900, 0.8);
  add(sfx, t0, dur, (t) => {
    const motor = Math.sign(Math.sin(2 * Math.PI * 172 * t)) * 0.55 + Math.sin(2 * Math.PI * 344 * t) * 0.3;
    return f(motor).lp * Math.min(1, t * 200) * Math.min(1, (dur - t) * 120) * (0.75 + 0.25 * Math.sin(2 * Math.PI * 26 * t));
  }, { gain });
}

/** A soft key: a low thock and a small, bright click. */
function key(t0, gain = 0.07, pan = 0) {
  const f = svf(4200, 1.2);
  add(sfx, t0, 0.06, (t) => Math.sin(2 * Math.PI * 170 * t) * Math.exp(-t / 0.012) * 0.8 + f(rand()).bp * Math.exp(-t / 0.004) * 1.4, { gain, pan });
}

/** Air moving: noise through a band-pass that rises or falls, swelling and fading. */
function whoosh(t0, dur, gain = 0.08, rise = true) {
  const fl = svf(800, 1);
  const fr = svf(800, 1);
  add(sfx, t0, dur, (t) => {
    const p = t / dur;
    const c = rise ? 500 * 12 ** p : 6000 / 12 ** p;
    const env = Math.sin(Math.PI * p) ** 2;
    return [fl(rand(), c).bp * env * 2, fr(rand(), c * 1.1).bp * env * 2];
  }, { gain, verb: 0.2 });
}

// 0:00–0:09, the phone. It buzzes while it rings, then each missed call is a
// short buzz and a low note, each message a pop climbing the scale.
const M = CUES.missed;
[[0, 0.3], [16 / FPS, 0.3], [32 / FPS, (M.callEnd - 32) / FPS]].forEach(([t, d]) => buzz(t, d, 0.11));
M.calls.forEach((f, i) => {
  buzz(cue("missed", f), 0.14, 0.08);
  pop(cue("missed", f), 57 + [0, 3, 5, 7, 10][i], 0.08, -0.2);
});
whoosh(cue("missed", M.swap) - 0.12, 0.3, 0.05);
const DM_NOTES = [76, 79, 81, 84, 86, 88];
M.dms.forEach((f, i) => {
  pop(cue("missed", f), DM_NOTES[i % DM_NOTES.length] - (i < 9 ? 0 : 12), i < 9 ? 0.075 : 0.06, ((i % 5) - 2) * 0.22);
  if (i % 3 === 0) buzz(cue("missed", f), 0.07, 0.05);
});
whoosh(cue("missed", M.exit), DROP - cue("missed", M.exit), 0.1);

// 0:09, the drop: a bright triad of glass over the impact.
[[81, 0], [88, 0.012], [93, 0.024]].forEach(([m, d], i) => tink(DROP + d, m, 0.045 - i * 0.01, (i - 1) * 0.3));

// Aya: a soft pop for each fact.
CUES.meet.badges.forEach((f, i) => pop(cue("meet", f), [79, 84][i], 0.07, i ? 0.25 : -0.25));

// The website types itself on soft keys, is sent, read, and what Aya learned settles.
{
  const W = CUES.website;
  const step = (W.typeTo - W.typeFrom) / 19;
  for (let k = 0; k < 19; k++) key(cue("website", W.typeFrom + k * step), 0.06 + 0.015 * ((k * 7) % 3), ((k % 3) - 1) * 0.2);
  key(cue("website", W.typeTo), 0.11);
  whoosh(cue("website", W.typeTo), (W.learned - W.typeTo) / FPS, 0.035);
  tink(cue("website", W.learned), 88, 0.06);
  W.treatments.forEach((f, i) => pop(cue("website", f), [76, 79, 81][i], 0.06, (i - 1) * 0.3));
}

// The channels land on eighths, a note up the scale each.
CUES.channels.icons.forEach((f, i) => pop(cue("channels", f), [72, 74, 76, 79, 81][i], 0.11, (i - 2) * 0.25));

// Each booking: a glass note a step higher, and the counter's fine ticks as it rolls.
CUES.value.lands.forEach((f, i) => {
  tink(cue("value", f), [81, 84, 86, 88, 93][i], [0.11, 0.1, 0.085, 0.07, 0.055][i], (i - 2) * 0.2);
  for (let k = 0; k < 7; k++) add(sfx, cue("value", f + 6) + k * 0.045, 0.02, (t) => Math.sin(2 * Math.PI * 5600 * t) * Math.exp(-t / 0.0025), { gain: 0.025, pan: 0.15 });
});

// The deposit: the button, a two-note confirmation, healdesk's alert.
{
  const P = CUES.pay;
  key(cue("pay", P.press), 0.14);
  tink(cue("pay", P.paid), 76, 0.06, -0.15);
  tink(cue("pay", P.paid) + 0.1, 81, 0.065, 0.15);
  pop(cue("pay", P.notify), 88, 0.09);
  whoosh(cue("pay", P.notify) - 0.05, 0.35, 0.03, false);
}

// The end card's button.
tink(cue("close", CUES.close.button), 88, 0.022);

// ---------------------------------------------------------------- mix

/** Freeverb: eight combs and four all-passes per side, the right a little longer, for a real stereo room. */
function freeverb(input, { feedback = 0.86, damp = 0.22 } = {}) {
  const scale = SR / 44100;
  const out = stereo();
  for (let ch = 0; ch < 2; ch++) {
    const spread = ch ? 23 : 0;
    const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((d) => ({ buf: new Float32Array(Math.round((d + spread) * scale)), i: 0, z: 0 }));
    const aps = [556, 441, 341, 225].map((d) => ({ buf: new Float32Array(Math.round((d + spread) * scale)), i: 0 }));
    const hp = svf(220, 0.7);
    const o = out[ch];
    for (let n = 0; n < N; n++) {
      const x = (input[0][n] + input[1][n]) * 0.015;
      let s = 0;
      for (const c of combs) {
        const y = c.buf[c.i];
        c.z = y * (1 - damp) + c.z * damp;
        c.buf[c.i] = x + c.z * feedback;
        if (++c.i >= c.buf.length) c.i = 0;
        s += y;
      }
      for (const a of aps) {
        const b = a.buf[a.i];
        a.buf[a.i] = s + b * 0.5;
        if (++a.i >= a.buf.length) a.i = 0;
        s = b - s;
      }
      o[n] = hp(s).hp;
    }
  }
  return out;
}

/** A ping-pong delay a dotted eighth long, darker on every repeat. */
function pingPong(input, time, feedback = 0.4) {
  const d = Math.round(time * SR);
  const bl = new Float32Array(d);
  const br = new Float32Array(d);
  const lpl = svf(3800, 0.6);
  const lpr = svf(3800, 0.6);
  const hp = svf(300, 0.7);
  const out = stereo();
  let i = 0;
  for (let n = 0; n < N; n++) {
    const yl = bl[i];
    const yr = br[i];
    bl[i] = hp((input[0][n] + input[1][n]) * 0.5).hp + lpr(yr).lp * feedback;
    br[i] = lpl(yl).lp * feedback;
    out[0][n] = yl;
    out[1][n] = yr;
    if (++i >= d) i = 0;
  }
  return out;
}

const musicTail = freeverb(musicVerb);
const echoes = pingPong(echo, 3 * S16);
const sfxTail = freeverb(sfxVerb, { feedback: 0.84, damp: 0.25 });

// The side-chain: the music dips under each kick and swells back, the
// breathing that makes house feel alive. The effects are never ducked, and
// sit up to a few decibels under the music in the band where they speak.
const SFX = 3.5;
kicks.sort((a, b) => a - b);
const mix = stereo();
{
  let k = 0;
  for (let n = 0; n < N; n++) {
    const t = n / SR;
    while (k + 1 < kicks.length && kicks[k + 1] <= t) k++;
    const since = kicks[k] !== undefined && t >= kicks[k] ? t - kicks[k] : 9;
    // Down by a third within 4 ms of the kick, back with a 110 ms time constant.
    const duck = 1 - 0.35 * Math.min(1, since / 0.004) * Math.exp(-since / 0.11);
    for (const ch of [0, 1]) {
      mix[ch][n] = drums[ch][n] + (music[ch][n] + musicTail[ch][n] * 0.9 + echoes[ch][n] * 0.55) * duck + (sfx[ch][n] + sfxTail[ch][n] * 0.8) * SFX;
    }
  }
}

// The master: a high-pass under the kick's fundamental and a gentle tilt (a
// little less below 120 Hz, a little more above 4 kHz), so the mix carries
// on a phone's speaker; then gentle saturation to round the peaks, then
// -1 dBFS. scripts/master.mjs sets the loudness.
{
  for (const ch of [0, 1]) {
    const hp = svf(30, 0.707);
    const low = svf(120, 0.707);
    const high = svf(4000, 0.707);
    const x = mix[ch];
    for (let n = 0; n < N; n++) {
      const y = hp(x[n]).hp;
      x[n] = y - 0.25 * low(y).lp + 0.6 * high(y).hp;
    }
  }
  let peak = 0;
  for (const ch of mix) for (let n = 0; n < N; n++) peak = Math.max(peak, Math.abs(ch[n]));
  const drive = 1.25;
  for (const ch of mix) for (let n = 0; n < N; n++) ch[n] = Math.tanh((drive * ch[n]) / peak) / Math.tanh(drive);
  // Fade the last few milliseconds so the file never ends on a click.
  for (const ch of mix) for (let n = Math.max(0, N - 960); n < N; n++) ch[n] *= (N - n) / 960;
  peak = 0;
  for (const ch of mix) for (let n = 0; n < N; n++) peak = Math.max(peak, Math.abs(ch[n]));
  const g = 10 ** (-1 / 20) / peak;
  for (const ch of mix) for (let n = 0; n < N; n++) ch[n] *= g;
}

// 32-bit float WAV.
{
  const buf = Buffer.alloc(44 + N * 8);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + N * 8, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 8, 28);
  buf.writeUInt16LE(8, 32);
  buf.writeUInt16LE(32, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(N * 8, 40);
  for (let n = 0; n < N; n++) {
    buf.writeFloatLE(mix[0][n], 44 + n * 8);
    buf.writeFloatLE(mix[1][n], 48 + n * 8);
  }
  writeFileSync(OUT, buf);
}
console.log(`${OUT}: ${LENGTH.toFixed(2)} s at ${SR} Hz`);
