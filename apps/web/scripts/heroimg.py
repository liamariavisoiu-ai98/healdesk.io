"""Shared frame treatment for the hero pipelines.

Both the grid builder and the video builder have to do the same two things to
every frame before it ships: lift the studio backdrop to true white, and
dissolve the frame edges so it melts into the page instead of sitting on it as
a rectangle. Kept here so the two cannot drift apart — they were duplicated
once already and the copies had different ramps.
"""

from __future__ import annotations

from PIL import Image, ImageChops, ImageDraw, ImageFilter


def _smooth(t: float) -> float:
    t = 0.0 if t < 0 else 1.0 if t > 1 else t
    return t * t * (3 - 2 * t)


def edge_mask(w: int, h: int, spec) -> Image.Image:
    """255 at the frame edges, 0 in the middle.

    Built separably: a 1-D ramp resized across the frame is identical to
    evaluating it per pixel and about a thousand times faster than a Python
    loop over a megapixel.

    Each pair is (start, end) as a fraction of the axis measured INWARD from
    that edge, so (0.0, 0.10) on the top means fully masked at the very top and
    clear by 10% down.

    A ZERO-WIDTH pair means no ramp on that edge at all — recrop-hero-frames.py
    wants a side-only mask and expresses it that way. The 1e-6 divisor below
    almost gets there on its own, but not quite: the top term is 1 - smooth(...),
    and at the very first row the numerator is also 0, so it evaluates to 1 and
    paints a single fully-masked line across the top. Invisible when the crop
    starts at y=0 on already-feathered paper, a paper-coloured scanline across
    raw picture as soon as it does not.
    """
    (t0, t1), (b0, b1), (s0, s1) = spec
    top_off = t1 <= t0
    bot_off = b1 <= b0
    side_off = s1 <= s0
    col = []
    for i in range(h):
        t = i / max(1, h - 1)
        top = 0.0 if top_off else 1 - _smooth((t - t0) / max(1e-6, t1 - t0))
        bot = 0.0 if bot_off else _smooth((t - (1 - b1)) / max(1e-6, b1 - b0))
        col.append(int(255 * max(top, bot)))
    row = []
    for i in range(w):
        t = i / max(1, w - 1)
        near = 0.0 if side_off else 1 - _smooth((t - s0) / max(1e-6, s1 - s0))
        far = 0.0 if side_off else _smooth((t - (1 - s1)) / max(1e-6, s1 - s0))
        row.append(int(255 * max(near, far)))
    v = Image.new("L", (1, h))
    v.putdata(col)
    hz = Image.new("L", (w, 1))
    hz.putdata(row)
    return ImageChops.lighter(v.resize((w, h)), hz.resize((w, h)))


def vignette_mask(w: int, h: int, cx: float, cy: float, rx: float, ry: float,
                  r0: float, r1: float) -> Image.Image:
    """255 outside an ellipse, 0 inside, smooth between r0 and r1.

    The per-edge ramps in `edge_mask` assume the subject floats in a field of
    backdrop, so the ramp only ever fades empty paper. That assumption breaks on
    a tight portrait crop: she fills the frame to all four edges, so a ramp
    measured inward from an edge fades her hair to paper along a STRAIGHT LINE,
    and four straight lines are a rectangle however soft each one is. Widening
    them does not help — it just makes a bigger rectangle with blurrier sides.

    An ellipse has no straight edge to give away, so the fade reads as a
    vignette on a portrait rather than as the boundary of an image. Use it with
    `ImageChops.lighter` over a modest `edge_mask`, which costs nothing in the
    middle and guarantees the frame border itself lands on exactly the page
    colour — an ellipse inscribed in the frame does not reach the corners, and
    an ellipse that does reach them is clipped by the frame and shows the
    straight edge again.
    """
    m = Image.new("L", (w, h))
    px = m.load()
    span = max(1e-6, r1 - r0)
    for y in range(h):
        dy = ((y / max(1, h - 1)) - cy) / ry
        dy2 = dy * dy
        for x in range(w):
            dx = ((x / max(1, w - 1)) - cx) / rx
            px[x, y] = int(255 * _smooth(((dx * dx + dy2) ** 0.5 - r0) / span))
    return m


def guard_mask(w: int, h: int, box) -> Image.Image:
    """255 where the wall key MAY act; 0 over her face.

    Sclera and teeth are neutral and bright, exactly like the backdrop, so a
    saturation key with nothing held back punches holes through her eyes.
    """
    g = Image.new("L", (w, h), 255)
    ImageDraw.Draw(g).ellipse(
        [int(w * box[0]), int(h * box[1]), int(w * box[2]), int(h * box[3])], fill=0
    )
    return g.filter(ImageFilter.GaussianBlur(w * 0.03))


def whiten_wall(im: Image.Image, guard: Image.Image, lo: int = 120, hi: int = 175,
                target: tuple[int, int, int] = (255, 255, 255)) -> Image.Image:
    """Lift the studio backdrop and its cast shadow to the PAGE colour.

    Not necessarily white. A portrait keyed to white and dropped on a warm page
    reads as a card pasted onto the design — the cutout is invisible but the
    tonal mismatch is not, and no amount of feathering fixes a flat offset.

    Keyed on saturation, which is what separates a neutral wall from warm skin
    and hair at every brightness. A clip shot on an off-white or grey sweep
    otherwise reads as a slightly tinted rectangle sitting on a white page —
    a flat tonal offset rather than an edge, so no amount of feathering hides it.
    """
    r, g, b = im.split()
    mn = ImageChops.darker(ImageChops.darker(r, g), b)
    mx = ImageChops.lighter(ImageChops.lighter(r, g), b)
    sat = ImageChops.subtract(mx, mn)
    neutral = sat.point(lambda v: 255 if v <= 12 else 0 if v >= 30 else int((30 - v) * 255 / 18))
    bright = mn.point(
        lambda v: 0 if v <= lo else 255 if v >= hi else int((v - lo) * 255 / max(1, hi - lo))
    )
    wall = ImageChops.multiply(neutral, ImageChops.multiply(bright, guard))
    return Image.composite(Image.new("RGB", im.size, target), im, wall)


#                 top          bottom (inward)  sides (inward)
BLUR_SPEC = ((0.00, 0.05), (0.06, 0.26), (0.00, 0.07))
WHITE_SPEC = ((0.00, 0.015), (0.00, 0.16), (0.00, 0.03))


def feather(im: Image.Image, blur_m: Image.Image, white_m: Image.Image,
            target: tuple[int, int, int] = (255, 255, 255)) -> Image.Image:
    """Blur the frame's edges out, then fade that to white.

    Two ramps rather than one. The wider cross-fades to a blurred copy so detail
    dissolves before it reaches the edge; the tighter fades that to white.
    Fading straight to white without the blur leaves recognisable hair and
    shoulders showing through a gradient, which reads as a cut-out on a card.
    """
    out = Image.composite(im.filter(ImageFilter.GaussianBlur(26)), im, blur_m)
    return Image.composite(Image.new("RGB", im.size, target), out, white_m)
