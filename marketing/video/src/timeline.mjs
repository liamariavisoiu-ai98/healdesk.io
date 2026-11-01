// The one timeline. The picture (src/Ad.tsx and the shots) and the
// soundtrack (scripts/soundtrack.mjs) both import this file, so a cut and the
// sound on it can never drift apart.
//
// Everything after the drop is counted in beats of the song. Every frame
// number below is the frame nearest an exact beat, computed from the drop,
// never by adding rounded lengths, so nothing is ever more than half a frame
// off the music.

export const FPS = 30;
export const BPM = 122;
/** The drop: the cut from the phone to "Not on my watch.", on a downbeat. */
export const DROP_SECONDS = 9;

/** One beat of the song, in frames. */
const BEAT = (FPS * 60) / BPM;
const DROP = DROP_SECONDS * FPS;
/** The frame nearest beat `b` after the drop (negative before it). */
const frameOfBeat = (b) => Math.round(DROP + b * BEAT);

/**
 * The shots in order and their lengths in beats after the drop; the opening
 * runs from 0 to the drop. The cuts to the channels and to the close fall on
 * a bar's first beat (beats 20 and 52), where the song changes too.
 */
const PLAN = [
  ["missed", null],
  ["interrupt", 3],
  ["meet", 7],
  ["website", 10],
  ["channels", 6],
  ["value", 13],
  ["pay", 7],
  ["line", 6],
  ["close", 10],
];

let count = 0;
/** @type {{ id: string, from: number, to: number, beat: number }[]} `beat` is where the shot starts, in beats after the drop. */
export const SHOTS = PLAN.map(([id, n]) => {
  if (n === null) return { id, from: 0, to: DROP, beat: -DROP / BEAT };
  const beat = count;
  count += n;
  return { id, from: frameOfBeat(beat), to: frameOfBeat(count), beat };
});

export const DURATION = SHOTS[SHOTS.length - 1].to;

/** @param {string} id */
export const shot = (id) => {
  const s = SHOTS.find((x) => x.id === id);
  if (!s) throw new Error(`no shot ${id}`);
  return s;
};

/** Frames from the start of shot `id` to `k` beats into it. */
const on = (id, k) => frameOfBeat(shot(id).beat + k) - shot(id).from;

// Before the drop the song's bars start at GRID, the first downbeat after 0,
// so the drop is a downbeat too.
export const GRID = DROP - Math.floor(DROP / (4 * BEAT)) * 4 * BEAT;
const pre = (k) => Math.round(GRID + k * BEAT);
const pres = (fromBeat, n, step) => Array.from({ length: n }, (_, i) => pre(fromBeat + i * step));

/**
 * Cue points inside the shots, in frames from each shot's start. The shots
 * animate on them and the soundtrack puts its sounds on them.
 */
export const CUES = {
  missed: {
    // The call rings until the first beat, then goes unanswered; one missed
    // call lands on each beat after that.
    callEnd: pre(0),
    calls: pres(0, 5, 1),
    // "calls?" rolls to "DMs?" on the seventh beat; the messages then come on
    // eighths, then sixteenths, faster and faster.
    swap: pre(6),
    dms: [...pres(7, 9, 0.5), ...pres(11.5, 6, 0.25)],
    // The camera flies into the screen over the last beat.
    exit: pre(15),
  },
  meet: { sub: on("meet", 0.5), signature: on("meet", 1.5), badges: [on("meet", 2.5), on("meet", 3)] },
  website: { typeFrom: on("website", 1), typeTo: on("website", 4), learned: on("website", 5), treatments: [on("website", 6), on("website", 6.5), on("website", 7)] },
  channels: { icons: [2, 2.5, 3, 3.5, 4].map((k) => on("channels", k)) },
  value: { lands: [1, 3, 5, 7, 9].map((k) => on("value", k)) },
  pay: { press: on("pay", 2), paid: on("pay", 3), notify: on("pay", 4) },
  line: { second: on("line", 1.5) },
  close: { tagline: on("close", 1), button: on("close", 2), hold: shot("close").to - shot("close").from - 15 },
};
