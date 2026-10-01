#!/usr/bin/env python3
"""Re-frame an existing hero grid to a new aspect, in place of a re-bin.

  python3 apps/web/scripts/recrop-hero-frames.py <dir> --crop x0,y0,x1,y1
        [--sides 0.07,0.03] [--quality 92] [--out <dir>] [--dry-run]

## Why this exists rather than `bin-frames-by-gaze.py --crop`

That flag is the right way to do it, and it is what a build from a fresh clip
should use — it crops before the wall key and the feather, so the ramps are
computed for the frame that ships and only one lossy encode ever happens.

It is the wrong way to do it to an ALREADY BINNED grid, because re-running the
binner does not just re-frame: it re-picks. The gaze estimate depends on the eye
box, the eye box depends on the framing, and a box retuned for a landscape clip
sorts the same 120 frames into different cells and a different row order. On the
clip this grid came from it also pulls two frames out of the tighter shot the
clip opens with, which land mid-grid as a visible cut. Re-binning is a rebuild;
this is a crop, and the difference matters when the grid's ordering has already
been eyeballed and something downstream (`rest` in frames.json) names a cell.

## The one thing it has to get right

The frames arrive already keyed and feathered — but feathered for their ORIGINAL
width, so the ramps sit outside any sane portrait crop and the crop lands on raw,
hard-edged picture. Feathering the result again would double the top and bottom
ramps, which are inside the crop and already done. So this applies a SIDE-ONLY
feather: the left and right edges get the blur-then-fade treatment they now need,
and the top and bottom are left exactly as the binner made them.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from heroimg import BLUR_SPEC, WHITE_SPEC, edge_mask, feather  # noqa: E402

WEB = Path(__file__).resolve().parents[1]


def opt(flag: str, default):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else default


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print(__doc__.strip().splitlines()[2].strip(), file=sys.stderr)
        return 2
    src = WEB / "public" / args[0]
    dst = WEB / "public" / str(opt("--out", args[0]))
    meta_path = src / "frames.json"
    if not meta_path.exists():
        print(f"no frames.json in {src}", file=sys.stderr)
        return 2
    meta = json.loads(meta_path.read_text())

    cropspec = str(opt("--crop", ""))
    if not cropspec:
        print("--crop x0,y0,x1,y1 is required", file=sys.stderr)
        return 2
    box = tuple(int(v) for v in cropspec.split(","))
    if len(box) != 4 or not (box[0] < box[2] and box[1] < box[3]):
        print("--crop wants x0,y0,x1,y1", file=sys.stderr)
        return 2
    w0, h0 = meta["width"], meta["height"]
    if not (0 <= box[0] and box[2] <= w0 and 0 <= box[1] and box[3] <= h0):
        print(f"--crop {box} outside the {w0}x{h0} frame", file=sys.stderr)
        return 2
    fw, fh = box[2] - box[0], box[3] - box[1]

    blur_s, white_s = (float(v) for v in str(opt("--sides", "0.07,0.03")).split(","))
    quality = int(opt("--quality", 92))
    dry = "--dry-run" in sys.argv

    # Zero-width top and bottom ramps: `edge_mask` builds the vertical ramp from
    # (start, end) pairs measured inward, and a zero-width pair evaluates to no
    # contribution at every row, so the mask is purely horizontal.
    none = (0.0, 0.0)
    blur_m = edge_mask(fw, fh, (none, none, (0.0, blur_s)))
    white_m = edge_mask(fw, fh, (none, none, (0.0, white_s)))
    bg = tuple(int(v) for v in str(opt("--bg", "251,244,234")).split(","))

    names = sorted(p.name for p in src.glob("*.webp"))
    print(f"{len(names)} frames  {w0}x{h0} -> {fw}x{fh} ({fw / fh:.4f})  at {box}")
    print(f"side ramps: blur {blur_s} ({int(fw * blur_s)}px), white {white_s} ({int(fw * white_s)}px)")
    if dry:
        print("--dry-run: nothing written")
        return 0

    dst.mkdir(parents=True, exist_ok=True)
    total = 0
    for n in names:
        im = Image.open(src / n).convert("RGB").crop(box)
        feather(im, blur_m, white_m, bg).save(dst / n, "WEBP", quality=quality, method=6)
        total += (dst / n).stat().st_size

    meta["width"], meta["height"] = fw, fh
    meta["_recrop"] = f"re-framed to {fw}x{fh} from {w0}x{h0} at {box} — see scripts/recrop-hero-frames.py"
    (dst / "frames.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(f"wrote {len(names)} frames to {dst}  ({total / 1048576:.2f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
