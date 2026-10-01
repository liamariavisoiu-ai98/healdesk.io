#!/usr/bin/env python3
"""Re-encode a clip into gaze order so the hero can scrub it smoothly.

  python3 apps/web/scripts/build-hero-video.py <video> [--eye-box a,b,c,d]
        [--width 900] [--flip] [--out hero-video] [--start 0] [--positions 0]
        [--wall-lo 120] [--wall-hi 175]

Writes apps/web/public/<out>/ — one mp4 plus a video.json.

## Why not a grid of stills

A grid quantises. Nine columns across a 1440px viewport is one snap per 160px
of cursor travel, and no amount of smoothing upstream hides that, because the
renderer discards the smooth value when it picks a cell. Going finer is not an
option as stills: every frame held decoded costs width x height x 4 bytes, so a
hundred of them is hundreds of megabytes.

A video has neither problem. The browser decodes on demand and manages the
memory itself, and every frame in the clip becomes an available gaze position —
roughly a hundred and forty instead of nine.

## Why it has to be re-ordered

The clip's frames are in time order, and its gaze wanders. Scrubbing that
directly would swing her eyes back and forth as the cursor moved steadily in
one direction. So this measures the gaze on every frame, sorts by it, and
re-encodes. Afterwards, time in the output IS gaze, monotonically, and the
renderer can map one to the other with a multiply.

## Why every frame is a keyframe

Seeking to an arbitrary time in a normally-encoded video means decoding forward
from the previous keyframe, which is exactly the stutter this is meant to fix.
`-g 1` makes every frame independently decodable. The file is several times
larger; it is streamed rather than held, so that costs far less than it sounds.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

WEB = Path(__file__).resolve().parents[1]
OUT_ROOT = WEB / "public"
# Measurement runs on a downscale for speed. Big enough that a tight eye box
# still contains a few hundred samples — a landscape framing puts the eyes in a
# much smaller slice of the frame than a portrait one does.
MEASURE_W = 520


def _smooth(t: float) -> float:
    t = 0.0 if t < 0 else 1.0 if t > 1 else t
    return t * t * (3 - 2 * t)


def edge_mask(w: int, h: int, spec) -> Image.Image:
    """255 at the frame edges, 0 in the middle. Separable, so it stays fast."""
    (t0, t1), (b0, b1), (s0, s1) = spec
    col = []
    for i in range(h):
        t = i / max(1, h - 1)
        col.append(int(255 * max(1 - _smooth((t - t0) / max(1e-6, t1 - t0)),
                                 _smooth((t - (1 - b1)) / max(1e-6, b1 - b0)))))
    row = []
    for i in range(w):
        t = i / max(1, w - 1)
        row.append(int(255 * max(1 - _smooth((t - s0) / max(1e-6, s1 - s0)),
                                 _smooth((t - (1 - s1)) / max(1e-6, s1 - s0)))))
    v = Image.new("L", (1, h)); v.putdata(col)
    hz = Image.new("L", (w, 1)); hz.putdata(row)
    return ImageChops.lighter(v.resize((w, h)), hz.resize((w, h)))


def whiten_wall(im: Image.Image, keep: Image.Image, lo: int = 120, hi: int = 175) -> Image.Image:
    """Lift the studio wall and its cast shadow to true white, outside `keep`.

    The clip was shot on an off-white sweep — about (246,249,247) — with a grey
    shadow down one side. Dropped onto a pure-white page that whole frame reads
    as a slightly grey rectangle with a smudge in it, however well the edges are
    feathered, because the difference is a flat tonal offset rather than an edge.

    Keyed on saturation, which is what separates a neutral wall from warm skin
    and hair at every brightness. `keep` guards her face: sclera and teeth are
    neutral and bright too, and would otherwise be keyed straight out.
    """
    r, g, b = im.split()
    mn = ImageChops.darker(ImageChops.darker(r, g), b)
    mx = ImageChops.lighter(ImageChops.lighter(r, g), b)
    sat = ImageChops.subtract(mx, mn)
    neutral = sat.point(lambda v: 255 if v <= 12 else 0 if v >= 30 else int((30 - v) * 255 / 18))
    bright = mn.point(
        lambda v: 0 if v <= lo else 255 if v >= hi else int((v - lo) * 255 / max(1, hi - lo)))
    wall = ImageChops.multiply(neutral, ImageChops.multiply(bright, keep))
    return Image.composite(Image.new("RGB", im.size, (255, 255, 255)), im, wall)


def opt(flag: str, default):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else default


def measure(im: Image.Image, box):
    """(gazeX, openness) for one frame, normalised 0-1."""
    crop = im.crop(box).convert("L")
    w, h = crop.size
    px = crop.load()
    vals = sorted(px[x, y] for y in range(0, h, 2) for x in range(0, w, 2))
    if not vals:
        return None
    dark = vals[max(0, len(vals) // 40)]
    sx = n = bright = 0
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            v = px[x, y]
            if v <= dark:
                sx += x
                n += 1
            if v >= 200:
                bright += 1
    if n < 20:
        return None
    return sx / n / w, bright / ((h // 2 + 1) * (w // 2 + 1))


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print("usage: build-hero-video.py <video> [--eye-box a,b,c,d] [--width 900] [--flip]",
              file=sys.stderr)
        return 2
    src = Path(args[0]).expanduser()
    if not src.exists():
        print(f"not found: {src}", file=sys.stderr)
        return 2
    width = int(opt("--width", 900))
    out_dir = OUT_ROOT / str(opt("--out", "hero-video"))
    start = int(opt("--start", 0))
    positions = int(opt("--positions", 0))
    wall_lo, wall_hi = int(opt("--wall-lo", 120)), int(opt("--wall-hi", 175))
    gbox = [float(v) for v in str(opt("--guard", "0.18,0.08,0.82,0.72")).split(",")]
    crf = int(opt("--crf", 18))
    vtol = float(opt("--vtol", 2.0))
    ebox = [float(v) for v in str(opt("--eye-box", "0.33,0.37,0.66,0.46")).split(",")]

    with tempfile.TemporaryDirectory() as tmp:
        t = Path(tmp)
        small, full, ordered = t / "s", t / "f", t / "o"
        for d in (small, full, ordered):
            d.mkdir()
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(src),
                        "-vf", f"scale={MEASURE_W}:-2", str(small / "%05d.png")], check=True)
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(src),
                        "-vf", f"scale={width}:-2", str(full / "%05d.png")], check=True)
        shots = sorted(small.glob("*.png"))
        if start:
            # Generated clips sometimes open on a different shot before settling.
            # Those frames are a different framing entirely, and left in they
            # would be sorted into the middle of the sweep as a hard cut.
            shots = shots[start:]
            print(f"dropped the first {start} frames")
        W, H = Image.open(shots[0]).size
        box = (int(W * ebox[0]), int(H * ebox[1]), int(W * ebox[2]), int(H * ebox[3]))
        print(f"{len(shots)} frames, measuring in {box}")

        m = []
        for f in shots:
            r = measure(Image.open(f), box)
            if r:
                m.append((r[0], r[1], f.name))
        if len(m) < 8:
            print("too few usable frames — check --eye-box", file=sys.stderr)
            return 1

        # Drop blinks: the fastest local changes in the eye band. A half-shut
        # frame parked in the middle of the sweep would flash as the cursor
        # crossed it.
        d = [0.0] + [abs(m[i][1] - m[i - 1][1]) for i in range(1, len(m))]
        spike = sorted(d)[int(len(d) * 0.94)] if len(d) > 20 else 1e9
        drop = {i for i, v in enumerate(d) if v > spike and spike > 1e-4}
        drop |= {j for i in drop for j in (i - 1, i + 1) if 0 <= j < len(m)}
        keep = [x for i, x in enumerate(m) if i not in drop]
        print(f"kept {len(keep)}, dropped {len(drop)} as blink/transition")

        # Monotonic by construction: filter to one horizontal "level", sort by
        # measured gaze, then resample by RANK.
        #
        # The previous version binned by target position and fell back to the
        # whole set when a bin came up empty, which let it choose a frame from
        # anywhere in the clip — so the output was not ordered at all, and the
        # gaze jumped around as the cursor moved steadily.
        #
        # Sorting and resampling cannot do that. The vertical filter runs first
        # because a single video is a one-dimensional scrub: whatever the clip
        # did on the other axis comes along for the ride, and without this,
        # dragging sideways also bobs her head up and down.
        ys = sorted(x[1] for x in keep)
        med_y = ys[len(ys) // 2]
        devs = sorted(abs(x[1] - med_y) for x in keep)
        mad = devs[len(devs) // 2] or 1e-6
        level = [c for c in keep if abs(c[1] - med_y) <= mad * vtol] or keep
        level.sort(key=lambda c: c[0])
        n_out = positions or len(level)
        keep = [level[round(i * (len(level) - 1) / max(1, n_out - 1))] for i in range(n_out)]
        if "--flip" in sys.argv:
            keep.reverse()
        print(f"gaze {level[0][0]:.3f} -> {level[-1][0]:.3f} over {len(keep)} positions "
              f"({len(level)} frames survived the vertical filter of {len(level) + 0}, "
              f"median vertical {med_y:.3f})")

        # Feather every frame into white before encoding, for the same reason
        # the stills pipeline does it: a mask on the element would force the
        # whole layer to re-composite on every seek, which is exactly when the
        # cursor is moving. Baked, it costs nothing at runtime.
        probe0 = Image.open(full / keep[0][2])
        fw, fh = probe0.size
        # Everything outside this ellipse may be whitened. Fixed, because the
        # camera is locked off and she barely translates.
        guard = Image.new("L", (fw, fh), 255)
        ImageDraw.Draw(guard).ellipse(
            [int(fw * gbox[0]), int(fh * gbox[1]), int(fw * gbox[2]), int(fh * gbox[3])], fill=0)
        guard = guard.filter(ImageFilter.GaussianBlur(fw * 0.03))
        blur_m = edge_mask(fw, fh, ((0.00, 0.07), (0.14, 0.46), (0.00, 0.10)))
        white_m = edge_mask(fw, fh, ((0.00, 0.02), (0.02, 0.32), (0.00, 0.04)))
        white = Image.new("RGB", (fw, fh), (255, 255, 255))
        for i, (_, _, name) in enumerate(keep):
            im = Image.open(full / name).convert("RGB")
            im = whiten_wall(im, guard, wall_lo, wall_hi)
            im = Image.composite(im.filter(ImageFilter.GaussianBlur(26)), im, blur_m)
            im = Image.composite(white, im, white_m)
            im.save(ordered / f"{i:05d}.png")
        print(f"feathered {len(keep)} frames into white")

        out_dir.mkdir(parents=True, exist_ok=True)
        mp4 = out_dir / "gaze.mp4"
        subprocess.run([
            "ffmpeg", "-nostdin", "-v", "error", "-framerate", "30",
            "-i", str(ordered / "%05d.png"),
            # every frame a keyframe, so any seek is a single decode
            "-c:v", "libx264", "-g", "1", "-keyint_min", "1", "-sc_threshold", "0",
            "-bf", "0", "-pix_fmt", "yuv420p", "-crf", str(crf),
            "-movflags", "+faststart", str(mp4), "-y",
        ], check=True)

        probe = Image.open(ordered / "00000.png")
        (out_dir / "video.json").write_text(json.dumps({
            "_": f"Gaze-ordered re-encode of {src.name} — see docs/hero-frames.md",
            "src": "gaze.mp4",
            "frames": len(keep),
            "fps": 30,
            "width": probe.width,
            "height": probe.height,
        }, indent=2) + "\n")
        mb = mp4.stat().st_size / 1048576
        print(f"\nwrote {mp4.name}: {len(keep)} gaze positions, {probe.width}x{probe.height}, {mb:.1f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
