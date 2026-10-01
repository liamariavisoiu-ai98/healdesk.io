#!/usr/bin/env python3
"""Sort a talking-head clip into the hero frame grid by MEASURED gaze.

  python3 apps/web/scripts/bin-frames-by-gaze.py <video> [--cols 9] [--rows 1]
        [--eye-box 0.33,0.36,0.66,0.45] [--out hero-frames] [--start 0]
        [--width 900] [--guard a,b,c,d] [--wall-lo 120] [--wall-hi 175]
        [--samples 0] [--flip-x] [--flip-y] [--blinks 6] [--dry-run]
        [--crop x0,y0,x1,y1] [--fade top,bottom,sides]
        [--vignette cx,cy,rx,ry,r0,r1]

Sampling a clip at even timestamps assumes it pans smoothly from one side to
the other. A generated avatar does not: its motion is driven by the audio and
its own idea of a performance, so it wanders. Sampling that by time gives an
arbitrary jumble of directions, and the grid then jumps around under the cursor.

So this measures instead. It estimates where the pupils sit on every frame and
keeps the frame nearest each cell's target gaze. Whatever the clip happened to
do, the grid comes out ordered.

## Blinks

A clip that blinks — and a good one should, it is most of what makes an idle
loop feel alive — will otherwise drop a half-closed frame into a grid cell,
where it stays forever. So blinks are detected by the collapse of visible
sclera, excluded from the grid, and optionally harvested into their own
sequence with --blinks. Getting the blink strip out of the SAME clip is worth a
lot: it shares the lighting, framing and hair of the grid, which a separately
generated blink never will.

## The estimate

Darkest-pixel centroid inside a fixed eye box, plus the fraction of near-white
pixels as an openness proxy. Crude in absolute terms — the centroid is dragged
toward the lashes — but the grid only needs consistent *ordering*, and with a
locked-off camera that bias is identical on every frame and cancels.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageChops

sys.path.insert(0, str(Path(__file__).resolve().parent))
from heroimg import (  # noqa: E402
    BLUR_SPEC, WHITE_SPEC, edge_mask, feather, guard_mask, vignette_mask, whiten_wall,
)

WEB = Path(__file__).resolve().parents[1]
# Measurement runs on a downscale for speed. Big enough that a tight eye box
# still holds a few hundred samples — a landscape framing puts the eyes in a
# much smaller slice of the frame than a portrait one does.
MEASURE_W = 520


def opt(flag: str, default):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else default


def measure(im: Image.Image, box: tuple[int, int, int, int]):
    """(gazeX, gazeY, openness) for one frame, each normalised 0-1.

    Openness is the fraction of scanlines across the eye box that contain any
    bright sclera at all — how far apart the lids are, in effect.

    Two earlier attempts at this were wrong and both put a half-shut frame into
    the grid, where it sits forever. Counting sclera *area* fails because a
    turned eye shows less white too, so it flags side glances as blinks. A
    temporal test — "the fastest change in the eye region" — fails because head
    motion moves that region faster than a lid does. Counting lit ROWS measures
    the thing itself: when the lid comes down the sclera vanishes from the rows
    it covers, and nothing else in a locked-off portrait does that.
    """
    crop = im.crop(box).convert("L")
    w, h = crop.size
    px = crop.load()
    vals = sorted(px[x, y] for y in range(0, h, 2) for x in range(0, w, 2))
    if not vals:
        return None
    dark = vals[max(0, len(vals) // 40)]  # darkest ~2.5% is pupil and lash
    sx = sy = n = 0
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            if px[x, y] <= dark:
                sx += x
                sy += y
                n += 1
    if n < 20:
        return None
    lit = sum(1 for y in range(h) if max(px[x, y] for x in range(w)) >= 190)
    return sx / n / w, sy / n / h, lit / h


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print(__doc__.strip().splitlines()[2].strip(), file=sys.stderr)
        return 2
    video = Path(args[0]).expanduser()
    if not video.exists():
        print(f"not found: {video}", file=sys.stderr)
        return 2

    cols, rows = int(opt("--cols", 9)), int(opt("--rows", 1))
    OUT = WEB / "public" / str(opt("--out", "hero-frames"))
    WIDTH = int(opt("--width", 900))
    start = int(opt("--start", 0))
    gbox = [float(v) for v in str(opt("--guard", "0.18,0.08,0.82,0.72")).split(",")]
    wall_lo, wall_hi = int(opt("--wall-lo", 120)), int(opt("--wall-hi", 175))
    bg = tuple(int(v) for v in str(opt("--bg", "255,255,255")).split(","))
    samples = int(opt("--samples", 0))  # 0 = every frame
    blinks = int(opt("--blinks", 0))
    dry = "--dry-run" in sys.argv
    ebox = [float(v) for v in str(opt("--eye-box", "0.33,0.36,0.66,0.45")).split(",")]
    # Pixels of the extracted frame, not fractions, because the number that
    # matters is an aspect ratio and fractions of an unknown width hide it.
    # Measured against the full frame, so `--eye-box` and the gaze binning are
    # unaffected — those run on the uncropped thumbnail pass.
    cropspec = str(opt("--crop", ""))
    # White-ramp widths, as fractions of the frame, one per edge. The defaults in
    # heroimg suit a subject floating in a wide field of backdrop, where the ramp
    # only ever fades empty paper and 1.5% at the top is plenty. A portrait crop
    # is the opposite case: it is cut close enough that the crown of her head is
    # at the top edge and her hair at both sides, so the same ramp terminates a
    # head at a hard line and she reads as a rectangle pasted on the page rather
    # than as part of it. Widen it and the cut dissolves.
    fade = [float(v) for v in str(opt("--fade", "")).split(",")] if "--fade" in sys.argv else None
    vign = [float(v) for v in str(opt("--vignette", "")).split(",")] if "--vignette" in sys.argv else None

    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        vf = f"scale={WIDTH}:-2"
        if samples:
            dur = float(
                subprocess.run(
                    ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                     "-of", "csv=p=0", str(video)],
                    capture_output=True, text=True, check=True).stdout.strip())
            vf = f"fps={max(1.0, samples / dur):.4f}," + vf
        # Two passes at different sizes, same numbering. Measuring on the
        # full-size frames means decoding a 900px PNG per frame, which dominates
        # everything else; the gaze estimate is unaffected by resolution, so it
        # runs on a thumbnail and only the chosen frames are ever read at size.
        small = tmpdir / "small"
        small.mkdir()
        subprocess.run(
            ["ffmpeg", "-nostdin", "-v", "error", "-i", str(video),
             "-vf", (vf.replace(f"scale={WIDTH}:-2", f"scale={MEASURE_W}:-2")),
             str(small / "s_%05d.png")], check=True)
        subprocess.run(
            ["ffmpeg", "-nostdin", "-v", "error", "-i", str(video), "-vf", vf,
             str(tmpdir / "s_%05d.png")], check=True)
        shots = sorted(small.glob("s_*.png"))
        if start:
            # Generated clips sometimes open on a different shot before settling;
            # left in, those frames sort into the middle of the grid as a cut.
            shots = shots[start:]
            print(f"dropped the first {start} frames")
        full = {f.name: tmpdir / f.name for f in shots}
        if not shots:
            print("ffmpeg produced no frames", file=sys.stderr)
            return 1
        W, H = Image.open(shots[0]).size
        box = (int(W * ebox[0]), int(H * ebox[1]), int(W * ebox[2]), int(H * ebox[3]))
        print(f"{len(shots)} frames, {W}x{H}, eye box {box}")

        m = []
        for f in shots:
            r = measure(Image.open(f), box)
            if r:
                m.append((r[0], r[1], r[2], f))
        if len(m) < cols * rows:
            print(f"only {len(m)} usable frames — is the eye box right?", file=sys.stderr)
            return 1

        # A blink is a frame whose lids are measurably closer together than the
        # clip's own resting state. Relative to the median because absolute
        # openness varies with framing; 0.88 sits comfortably between a side
        # glance and a real closure.
        med = sorted(x[2] for x in m)[len(m) // 2]
        cut = med * 0.88
        open_f = [x for x in m if x[2] >= cut]
        shut_f = sorted((x for x in m if x[2] < cut), key=lambda x: -x[2])
        print(f"openness median {med:.3f}, cut {cut:.3f} -> "
              f"{len(open_f)} open, {len(shut_f)} blink frames"
              + ("" if shut_f else "  (none — clip does not blink)"))

        xs = [x[0] for x in open_f]
        ys = [x[1] for x in open_f]
        sx, sy = max(xs) - min(xs), max(ys) - min(ys)
        print(f"horizontal spread {sx:.3f} ({'good' if sx > 0.05 else 'NARROW'})")
        print(f"vertical spread   {sy:.3f} ({'good' if sy > 0.05 else 'NARROW — one row only'})")
        if rows > 1 and sy <= 0.05:
            print("  refusing >1 row: the clip has no vertical range to bin with", file=sys.stderr)
            return 1

        def norm(v, lo, hi):
            return 0.5 if hi - lo < 1e-6 else (v - lo) / (hi - lo)

        fx = -1 if "--flip-x" in sys.argv else 1
        fy = -1 if "--flip-y" in sys.argv else 1
        chosen = {}
        for r in range(rows):
            for c in range(cols):
                tx = c / (cols - 1) if cols > 1 else 0.5
                ty = r / (rows - 1) if rows > 1 else 0.5
                if fx < 0:
                    tx = 1 - tx
                if fy < 0:
                    ty = 1 - ty
                best = min(open_f, key=lambda p: (
                    (norm(p[0], min(xs), max(xs)) - tx) ** 2
                    + (rows > 1) * (norm(p[1], min(ys), max(ys)) - ty) ** 2))
                chosen[(r, c)] = best
        distinct = len({v[3] for v in chosen.values()})
        print(f"picked {distinct} distinct frames for {rows * cols} cells"
              + ("" if distinct == rows * cols else "  <-- duplicates: not enough range"))

        if dry:
            for (r, c), v in sorted(chosen.items()):
                print(f"  cell {r},{c}: x={v[0]:.3f} y={v[1]:.3f}  {v[3].name}")
            print("\n--dry-run: nothing written")
            return 0

        OUT.mkdir(parents=True, exist_ok=True)
        # `rest` names the cell where she looks down the lens, and only a human
        # who has looked at the grid knows which one that is. It is not derivable
        # here: this script normalises gaze over the clip's OWN range, so the
        # middle of the grid is the middle of whatever the clip did, which on the
        # clip that prompted the field was her looking up and over your shoulder.
        # Rewriting frames.json without carrying it would silently reinstate that
        # as first paint, the reduced-motion still and the fallback image — a
        # regression whose only symptom is that the hero looks wrong.
        prior = {}
        if (OUT / "frames.json").exists():
            try:
                prior = json.loads((OUT / "frames.json").read_text())
            except json.JSONDecodeError:
                prior = {}
        carried = prior.get("rest")
        if carried and not (0 <= carried.get("row", -1) < rows and 0 <= carried.get("col", -1) < cols):
            print(f"dropping `rest` {carried}: outside the new {rows}x{cols} grid")
            carried = None
        for old in OUT.glob("*.webp"):
            old.unlink()

        probe = Image.open(full[next(iter(chosen.values()))[3].name])
        fw, fh = probe.size
        # The crop happens BEFORE the treatment, not after, and that ordering is
        # the whole point of doing it here rather than over the finished webps.
        # Both the wall key and the feather are computed from the frame's own
        # dimensions: crop afterwards and you slice through a vignette that was
        # ramped for a different width, leaving her hair terminating at a hard
        # vertical edge on both sides. Cropping first means the ramps are rebuilt
        # for the frame that actually ships, so a crop that cuts through hair
        # dissolves into the page instead of ending at it.
        if cropspec:
            cbox = tuple(int(v) for v in cropspec.split(","))
            if len(cbox) != 4:
                print("--crop wants x0,y0,x1,y1 in extracted-frame pixels", file=sys.stderr)
                return 2
            if not (0 <= cbox[0] < cbox[2] <= fw and 0 <= cbox[1] < cbox[3] <= fh):
                print(f"--crop {cbox} outside the {fw}x{fh} frame", file=sys.stderr)
                return 2
            fw, fh = cbox[2] - cbox[0], cbox[3] - cbox[1]
            print(f"cropping to {fw}x{fh} ({fw / fh:.3f}) at {cbox}")
        else:
            cbox = None
        guard = guard_mask(fw, fh, gbox)
        blur_spec, white_spec = BLUR_SPEC, WHITE_SPEC
        if fade:
            ft, fb, fs = fade
            # The blur ramp leads the white one — detail has to dissolve before
            # the fade reaches it, or recognisable hair shows through a gradient
            # and reads as a cut-out on a card.
            blur_spec = ((0.0, ft * 2.2), (BLUR_SPEC[1][0], max(BLUR_SPEC[1][1], fb * 2.2)),
                         (0.0, fs * 2.2))
            white_spec = ((0.0, ft), (0.0, fb), (0.0, fs))
            print(f"fade: top {ft} ({int(fh * ft)}px), bottom {fb}, sides {fs} ({int(fw * fs)}px)")
        blur_m = edge_mask(fw, fh, blur_spec)
        white_m = edge_mask(fw, fh, white_spec)
        if vign:
            vcx, vcy, vrx, vry, vr0, vr1 = vign
            # Lighter, not replace: the ellipse does the dissolving and the edge
            # ramp underneath guarantees the border is page colour, since an
            # inscribed ellipse never reaches the corners.
            white_m = ImageChops.lighter(white_m, vignette_mask(fw, fh, vcx, vcy, vrx, vry, vr0, vr1))
            blur_m = ImageChops.lighter(
                blur_m, vignette_mask(fw, fh, vcx, vcy, vrx, vry, max(0.0, vr0 - 0.22), vr1))
            print(f"vignette: centre ({vcx},{vcy}) radii ({vrx},{vry}) fade {vr0}->{vr1}")

        def treat(name):
            im = Image.open(full[name]).convert("RGB")
            if cbox:
                im = im.crop(cbox)
            return feather(whiten_wall(im, guard, wall_lo, wall_hi, bg), blur_m, white_m, bg)

        # Write each SOURCE frame once, and let the grid point at it.
        #
        # A rectangular grid over a wandering clip is mostly duplicates: the gaze
        # path is a curve through 2-D space, so the corners and the middle of the
        # rectangle are places the clip never looked, and their nearest frame is
        # one an occupied cell already claimed. On the clip this was built for, a
        # 15x7 grid resolves to 42 distinct frames — writing one file per cell
        # would ship 105 of them, 63 being byte-identical copies, and would pin
        # 123MB of decoded bitmaps at runtime instead of 47MB.
        #
        # Duplicates are not a defect to be tuned away, either. A cell whose
        # nearest frame is shared with its neighbour is the honest answer to
        # "what does she look like aiming there" when the clip never aimed there.
        # The indirection just stops us paying for the honesty twice.
        order: list[str] = []
        index: dict[str, int] = {}
        for r in range(rows):
            for c in range(cols):
                name = chosen[(r, c)][3].name
                if name not in index:
                    index[name] = len(order)
                    order.append(name)
        for i, name in enumerate(order):
            treat(name).save(OUT / f"g_{i:02d}.webp", "WEBP", quality=86, method=4)
        cells = [[index[chosen[(r, c)][3].name] for c in range(cols)] for r in range(rows)]
        print(f"{len(order)} distinct frames for {rows * cols} cells "
              f"({rows * cols - len(order)} cells share one)")

        blink_written = 0
        if blinks and shut_f:
            # Evenly through the closing/opening arc, ordered by how shut she is.
            seq = shut_f  # already ordered open -> shut
            step = max(1, len(seq) // blinks)
            for i, v in enumerate(seq[::step][:blinks]):
                treat(v[3].name).save(OUT / f"blink_{i}.webp", "WEBP", quality=86, method=4)
                blink_written += 1

        manifest = {
            "_": f"Binned by gaze from {video.name} — see docs/hero-frames.md",
            "cols": cols, "rows": rows,
            # `frames` + `cells` replaces the old `pattern` + implicit
            # row*cols+col addressing. The renderer still reads a grid; it just
            # looks the file up through `cells` instead of computing a name.
            "frames": [f"g_{i:02d}.webp" for i in range(len(order))],
            "cells": cells,
            "width": fw, "height": fh,
            "blinks": blink_written,
            "placeholder": False,
        }
        if carried:
            manifest["rest"] = carried
        (OUT / "frames.json").write_text(json.dumps(manifest, indent=2) + "\n")
        total = sum(f.stat().st_size for f in OUT.glob("*.webp"))
        print(f"\nwrote {rows}x{cols} grid"
              + (f" + {blink_written} blink frames" if blink_written else "")
              + f" to {OUT}  ({total / 1048576:.1f} MB)")
        print(f"carried `rest` forward as {carried} — CHECK it still points at the frame "
              "where she meets the lens" if carried else
              "no `rest` in the manifest: the renderer will anchor aim (0,0) on the grid's "
              "geometric middle, which is only the camera by luck. Look at the grid zoomed "
              "to the eyes and add one — see docs/hero-frames.md.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
