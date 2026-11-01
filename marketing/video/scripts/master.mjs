// Masters the soundtrack for the platforms: -14 LUFS integrated, the level
// Instagram, TikTok and YouTube normalise to, with true peaks at or below
// -1 dBTP.
//
// Usage: node scripts/master.mjs <in.wav> <out.wav>
//
// It measures the mix (ffmpeg's EBU R128 meter), applies the one gain that
// lands it on -14 LUFS, and catches the few peaks that gain pushes past the
// ceiling with a fast limiter. A limiter takes a little loudness with it, so
// it measures again and corrects; then it checks the result and fails if it
// is off. A plain loudnorm pass does the same job by riding the gain through
// the song, which audibly pumps a mix like this.

import { spawnSync } from "node:child_process";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("usage: node scripts/master.mjs <in.wav> <out.wav>");

const TARGET = -14;
const CEILING = -1;

/** Integrated loudness (LUFS) and true peak (dBTP) of a file, after `filter`. */
function measure(file, filter = "anull") {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", `${filter},ebur128=peak=true`, "-f", "null", "-"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  const summary = r.stderr.slice(r.stderr.lastIndexOf("Summary:"));
  const lufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1]);
  const peak = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary.slice(summary.indexOf("True peak")))?.[1]);
  if (!Number.isFinite(lufs) || !Number.isFinite(peak)) throw new Error(`could not read loudness from ffmpeg:\n${summary}`);
  return { lufs, peak };
}

// The limiter runs at four times the sample rate, so it sees the peaks that
// fall between samples (a bright hi-hat rises a couple of decibels past its
// samples there). Resampling back to 48 kHz adds a little of its own, so the
// limiter's ceiling is lowered by whatever the meter still finds over.
const chain = (gain, limit) =>
  `volume=${gain.toFixed(3)}dB,aresample=192000,alimiter=limit=${(10 ** (limit / 20)).toFixed(5)}:attack=4:release=60:level=disabled,aresample=48000`;

const before = measure(input);
let gain = TARGET - before.lufs;
let limit = CEILING - 0.3;
for (let i = 0; i < 8; i++) {
  const m = measure(input, chain(gain, limit));
  const peakOk = m.peak <= CEILING - 0.05;
  if (Math.abs(m.lufs - TARGET) <= 0.1 && peakOk) break;
  if (!peakOk) limit -= m.peak - (CEILING - 0.1);
  gain += TARGET - m.lufs;
}

const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", input, "-af", chain(gain, limit), "-ar", "48000", "-c:a", "pcm_s24le", output], { encoding: "utf8" });
if (r.status !== 0) throw new Error(r.stderr);

const after = measure(output);
console.log(`${input}: ${before.lufs.toFixed(1)} LUFS, peak ${before.peak.toFixed(1)} dBTP`);
console.log(`${output}: ${after.lufs.toFixed(1)} LUFS, peak ${after.peak.toFixed(1)} dBTP (gain ${gain.toFixed(2)} dB, limiter at ${limit.toFixed(2)} dBFS)`);
if (Math.abs(after.lufs - TARGET) > 0.3 || after.peak > CEILING) {
  throw new Error(`mastered file is off target: ${after.lufs} LUFS, ${after.peak} dBTP`);
}
