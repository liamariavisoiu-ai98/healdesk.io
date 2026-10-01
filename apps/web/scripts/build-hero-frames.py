#!/usr/bin/env python3
"""Render a gaze grid for the frame-mapping hero.

  python3 apps/web/scripts/build-hero-frames.py [--cols 9] [--rows 5] [--width 900]

Writes apps/web/public/hero-frames/ — one image per (pitch, yaw) cell plus a
frames.json describing the grid.

## What this is for

Frame mapping replaces synthesis with photography: instead of translating an
iris sprite over an inpainted socket and hoping the seams hold, every gaze
direction is a complete, correct picture. Nothing to matte, nothing to
composite, no seams to open.

Right now it renders the grid from the 2.5D rig, which is a stand-in — those
frames inherit that rig's limits. The point is that the ENGINE can be built and
verified against a real grid today, so when photographed or generated frames
arrive they drop into the same folder and the same manifest and nothing in the
component changes.

## The grid, not a strip

A linear frame sequence indexed by cursor X can only turn one way — it cannot
also look up and down, and it pins the head to absolute cursor position like a
scrub bar. So this emits a 2-D grid indexed [row][col] = [pitch][yaw], and the
component maps the rig's smoothed gaze into it.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageFilter

WEB = Path(__file__).resolve().parents[1]
SRC = WEB / "public" / "hero"
OUT = WEB / "public" / "hero-frames"

# Matches HeroPortrait: plane displacement at full deflection, percent of canvas.
FACE_PCT = {"x": 1.33, "y": 0.41}
HEAD_DEADZONE = 0.28
HEAD_GAZE_SHARE = 0.35


def arg(flag: str, default: int) -> int:
    return int(sys.argv[sys.argv.index(flag) + 1]) if flag in sys.argv else default


def _smooth(t: float) -> float:
    t = 0.0 if t < 0 else 1.0 if t > 1 else t
    return t * t * (3 - 2 * t)


def edge_mask(w: int, h: int, spec) -> Image.Image:
    """Union of four edge ramps: 255 at the frame edges, 0 in the middle.

    Built separably — a 1-D ramp resized across the frame is identical to
    evaluating it per pixel and about a thousand times faster than a Python
    loop over 1.4M pixels.

    Each pair is (start, end) as a fraction of the axis, measured inward from
    that edge: (0.0, 0.10) on the top means fully masked at the very top,
    clear by 10% down.
    """
    (t0, t1), (b0, b1), (s0, s1) = spec

    col = []
    for i in range(h):
        t = i / max(1, h - 1)
        top = 1 - _smooth((t - t0) / max(1e-6, t1 - t0))
        bot = _smooth((t - (1 - b1)) / max(1e-6, b1 - b0))
        col.append(int(255 * max(top, bot)))

    row = []
    for i in range(w):
        t = i / max(1, w - 1)
        left = 1 - _smooth((t - s0) / max(1e-6, s1 - s0))
        right = _smooth((t - (1 - s1)) / max(1e-6, s1 - s0))
        row.append(int(255 * max(left, right)))

    v = Image.new("L", (1, h)); v.putdata(col)
    hz = Image.new("L", (w, 1)); hz.putdata(row)
    return ImageChops.lighter(v.resize((w, h)), hz.resize((w, h)))


def feather() -> int:
    """Blur each frame's edges out into the white hero background, in place.

    Baked rather than done in CSS on purpose. The runtime equivalent is a mask
    on the canvas, and a masked canvas has to re-composite its whole layer every
    time drawImage touches it — which is exactly when the cursor is moving and
    the page can least afford it. A progressive blur in CSS is worse still:
    stacked backdrop-filters over a large area, every frame.

    Two ramps, not one. The wider one cross-fades to a blurred copy so detail
    dissolves before it reaches the edge; the tighter one fades that to white.
    Fading straight to white without the blur leaves recognisable hair and
    shoulders showing through a gradient, which reads as a cut-out on a card
    rather than a portrait melting into the page.
    """
    manifest = OUT / "frames.json"
    if not manifest.exists():
        print(f"no frames.json in {OUT}", file=sys.stderr)
        return 2
    files = sorted(OUT.glob("*.webp"))
    if not files:
        print(f"no frames in {OUT}", file=sys.stderr)
        return 2

    first = Image.open(files[0])
    w, h = first.size
    #                        top          bottom (inward)  sides (inward)
    blur_m = edge_mask(w, h, ((0.00, 0.07), (0.14, 0.46), (0.00, 0.10)))
    white_m = edge_mask(w, h, ((0.00, 0.02), (0.02, 0.32), (0.00, 0.04)))
    white = Image.new("RGB", (w, h), (255, 255, 255))

    for f in files:
        im = Image.open(f).convert("RGB")
        out = Image.composite(im.filter(ImageFilter.GaussianBlur(26)), im, blur_m)
        out = Image.composite(white, out, white_m)
        out.save(f, "WEBP", quality=86, method=4)
    print(f"  feathered {len(files)} frames ({w}x{h}) into white")
    return 0


def verify() -> int:
    """Check a hand-supplied grid before trusting it.

    Real frames arrive from a video generator one row at a time, so the usual
    failure is a grid that is simply incomplete, or cells that disagree on size
    — either of which shows up as a jump or a hole only once someone moves the
    cursor into that corner.
    """
    manifest = OUT / "frames.json"
    if not manifest.exists():
        print(f"no frames.json in {OUT}", file=sys.stderr)
        return 2
    m = json.loads(manifest.read_text())
    cols, rows = m["cols"], m["rows"]
    missing, sizes = [], {}
    for r in range(rows):
        for c in range(cols):
            f = OUT / m["pattern"].replace("{row}", str(r)).replace("{col}", str(c))
            if not f.exists():
                missing.append(f.name)
            else:
                sizes.setdefault(Image.open(f).size, []).append(f.name)
    total = sum(f.stat().st_size for f in OUT.glob("*.webp"))
    print(f"  grid {cols} x {rows} = {cols * rows} cells, {total / 1048576:.1f} MB")
    if missing:
        print(f"  MISSING {len(missing)}: {', '.join(missing[:8])}", file=sys.stderr)
    if len(sizes) > 1:
        print("  INCONSISTENT SIZES — every cell must match:", file=sys.stderr)
        for size, names in sizes.items():
            print(f"    {size[0]}x{size[1]}: {len(names)} file(s) e.g. {names[0]}", file=sys.stderr)
    if m.get("placeholder"):
        print("  note: frames.json still says placeholder:true — set it false for real frames")
    if not missing and len(sizes) <= 1:
        print("  complete and consistent.")
        return 0
    return 1


def main() -> int:
    if "--verify" in sys.argv:
        return verify()
    if "--feather" in sys.argv:
        return feather()
    cols, rows, width = arg("--cols", 9), arg("--rows", 5), arg("--width", 900)
    if not (SRC / "hero.json").exists():
        print(f"run build-hero-layers.py first — no manifest at {SRC}", file=sys.stderr)
        return 2
    m = json.loads((SRC / "hero.json").read_text())
    W, H = m["canvas"]["width"], m["canvas"]["height"]
    planes = [(p["follow"], Image.open(SRC / p["src"]).convert("RGBA")) for p in m["planes"]]
    eyes = []
    for e in m["eyes"]:
        ap = Image.open(SRC / e["aperture"]["src"]).convert("L")
        mask = Image.new("L", (W, H), 0)
        mask.paste(ap, (round(e["aperture"]["rect"][0] * W), round(e["aperture"]["rect"][1] * H)))
        eyes.append((e, Image.open(SRC / e["iris"]["src"]).convert("RGBA"), mask))

    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.webp"):
        old.unlink()

    def deadzone(v: float) -> float:
        if abs(v) < HEAD_DEADZONE:
            return 0.0
        return (v - (1 if v > 0 else -1) * HEAD_DEADZONE) / (1 - HEAD_DEADZONE)

    total = 0
    for r in range(rows):
        for c in range(cols):
            # cell centres span [-1, 1] on both axes
            gx = -1 + 2 * c / (cols - 1) if cols > 1 else 0.0
            gy = -1 + 2 * r / (rows - 1) if rows > 1 else 0.0
            hx, hy = deadzone(gx), deadzone(gy)

            frame = Image.new("RGB", (W, H), (255, 255, 255))
            for follow, im in planes:
                frame.paste(
                    im,
                    (round(hx * follow * FACE_PCT["x"] / 100 * W),
                     round(hy * follow * FACE_PCT["y"] / 100 * H)),
                    im,
                )
            # the eyes counter-rotate as the head takes over part of the gaze (VOR)
            ix, iy = gx - hx * HEAD_GAZE_SHARE, gy - hy * HEAD_GAZE_SHARE
            for e, iris, mask in eyes:
                px = e["rest"][0] * W + max(-1, min(1, ix)) * e["travel"][0] * W
                py = e["rest"][1] * H + max(-1, min(1, iy)) * e["travel"][1] * H
                # the head plane carries the eyes with it
                px += hx * FACE_PCT["x"] / 100 * W
                py += hy * FACE_PCT["y"] / 100 * H
                layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
                layer.paste(iris, (round(px - iris.width / 2), round(py - iris.height / 2)), iris)
                layer.putalpha(ImageChops.multiply(layer.getchannel("A"), mask))
                frame.paste(layer, (0, 0), layer)

            out = frame.resize((width, round(width * H / W)), Image.LANCZOS)
            out.save(OUT / f"f_{r}_{c}.webp", "WEBP", quality=82, method=4)
            total += 1

    bytes_total = sum(f.stat().st_size for f in OUT.glob("*.webp"))
    (OUT / "frames.json").write_text(
        json.dumps(
            {
                "_": "Generated by apps/web/scripts/build-hero-frames.py — do not hand-edit.",
                "cols": cols,
                "rows": rows,
                "pattern": "f_{row}_{col}.webp",
                "width": width,
                "height": round(width * H / W),
                "placeholder": True,
            },
            indent=2,
        )
        + "\n"
    )
    print(f"  {total} frames ({cols} yaw x {rows} pitch) at {width}px")
    print(f"  {bytes_total / 1024:.0f} KB total, {bytes_total / total / 1024:.0f} KB each")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
