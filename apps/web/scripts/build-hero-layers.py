#!/usr/bin/env python3
"""Turn the supplied portrait layers into the planes the gaze rig animates.

Run:  python3 apps/web/scripts/build-hero-layers.py <layer-dir> <source-photo> [--debug]

Expects these files in <layer-dir>:

    14D57899-...PNG                  852x1846, the original photograph
    shoulders_layer.PNG              1086x1448, canvas space
    head+face_layer.PNG              1086x1448, canvas space
    hair-front+specular_layer.PNG    1086x1448, canvas space

## Mattes from the layers, pixels from the photograph

The exported layers carry a criss-cross mesh artefact through the hair — an
upscaler's signature, plainly visible at native resolution and absent from the
photograph. Their *alpha* is excellent, which is the hard part of cutting curly
hair, so this takes the matte from each layer and the colour from the photo,
registered by PHOTO_SCALE/PHOTO_ORIGIN. hair-back_layer is deliberately unused: it is invented hair that does not exist
in the photograph, so it cannot be re-sourced, and it carries the same mesh. It
only ever showed through the gaps between curls, where the photograph's own
answer — the white sweep behind her — is the correct one.

Why a build script and not a hand-cut PSD: every number the rig needs — iris
centre, limbus radius, how far an iris may travel before it reaches a canthus —
is *measured* here and written into hero.json, so the React component holds no
magic pixel offsets. Re-run it against new layers and the rig re-targets.

## Two things worth knowing

**Registration.** Three layers share a 1086x1448 canvas. `hair-back` does not:
it is 852x1846, the original photograph's dimensions. The transform between
them was fitted by correlating the face layer against the original photo, and
it came out as a 1.28x scale of the region x 6..852, y 270..1398. That is what
PHOTO_TO_CANVAS encodes, and it is also how the eye coordinates below — which
were measured on the original photograph — get onto the canvas.

**Follow, not depth.** The per-plane number in the manifest is not a z-distance.
The parallax here models a head *turning*, not a camera translating, so the
torso barely moves while the hair in front of the face moves slightly more than
the face itself. A body that swung with the head would look like a mannequin on
a turntable.

Dependencies: Pillow only.
"""

from __future__ import annotations

import json
import random
import sys
from collections import deque
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

CANVAS = (1086, 1448)
PHOTO_SIZE = (852, 1846)

# Overlap left between planes when they are punched out of each other: it must
# exceed the largest relative displacement the rig can produce, which is the
# widest follow gap (0.90 to 1.08) times 1.33% of canvas width, about 2.6px.
# Kept small on purpose — hair is wispy, and eroding by more than a few pixels
# leaves nothing of it to punch with.
OVERLAP_PX = 6

# Fitted by correlating head+face against the source photograph (err 14.5/255).
PHOTO_SCALE = 1.28
PHOTO_ORIGIN = (6, 270)

# Painted back to front. `follow` is how much of the head's motion each plane
# takes. The spread is deliberately narrow. The instinct is to hold the torso
# almost still against a turning head, but these planes each redraw content the
# others also have — the chest hair appears in all three — and a wide spread
# drags those duplicates apart into a visible translucent ghost. A real head
# also only shifts a few millimetres relative to the shoulders when it turns.
PLANES = [
    # `q` and `aq` are per-plane on purpose. The body needs a high `q` despite
    # being the simplest plane: it is mostly flat white fabric, and lossy chroma
    # over a large flat area produces a visible cool tint that hair hides.
    # `aq` matters more elsewhere: on a hair matte
    # the alpha channel is roughly 70% of the bytes, and WebP encodes it
    # losslessly unless told otherwise, so lowering it is the only large saving
    # available. hair-back sits almost entirely behind the others, so artefacts
    # there are invisible and its bytes are close to waste.
    {"key": "body", "src": "shoulders_layer.PNG", "out": "body.webp", "follow": 0.90, "q": 92, "aq": 88},
    {"key": "face", "src": "head+face_layer.PNG", "out": "face.webp", "follow": 1.0, "q": 80, "aq": 82},
    {"key": "hairFront", "src": "hair-front+specular_layer.PNG", "out": "hair-front.webp", "follow": 1.08, "q": 74, "aq": 72},
]

# Measured on the ORIGINAL photograph and mapped through PHOTO_TO_CANVAS.
# c = limbus centre, r = limbus radius, ap = a generous box for the aperture
# flood fill (it only has to contain the fissure, not match it).
EYES_PHOTO = [
    {"n": "l", "c": (284, 784), "r": 19, "ap": (244, 752, 362, 814)},
    {"n": "r", "c": (512, 778), "r": 20, "ap": (484, 746, 604, 808)},
]

# Her gaze in the source is hard to the viewer's left. The rest pose is the
# fissure centre plus this nasal bias — partly because a forward gaze really
# does sit nasal of centre once the head is a few degrees off axis, and partly
# because every pixel of re-centring is a pixel of sclera that has to be
# invented. Landing close to the photographed position keeps the inpainted
# crescent narrow enough to disappear.
REST_BIAS_X = -14
REST_BIAS_Y = 0

BACKDROP = (255, 255, 255)  # the hero sits on white, not the page's paper
OUT_DIR = Path(__file__).resolve().parents[1] / "public" / "hero"


def to_canvas(x: float, y: float) -> tuple[int, int]:
    return (
        round((x - PHOTO_ORIGIN[0]) * PHOTO_SCALE),
        round((y - PHOTO_ORIGIN[1]) * PHOTO_SCALE),
    )


def load_layer(path: Path) -> Image.Image:
    """Normalise alpha and clean the matte edge.

    The exporter tops out at alpha 252-254 rather than 255. Left alone, four
    stacked planes each at 99% opacity composite to a visible haze, so anything
    essentially opaque is snapped to fully opaque. Partial-alpha pixels also get
    their chroma pulled back toward neutral-for-their-luminance, which kills the
    coloured fringe a cutout picks up along a hair silhouette without touching
    the (fully opaque) lips and tear ducts, whose saturation is real.
    """
    im = Image.open(path).convert("RGBA")
    a = im.getchannel("A").point(lambda v: 255 if v >= 250 else v)
    im.putalpha(a)

    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, av = px[x, y]
            if av == 0 or av >= 250:
                continue
            mx, mn = max(r, g, b), min(r, g, b)
            if mx - mn <= 90:
                continue
            # pull the outlying channel most of the way back to the others
            mid = (r + g + b) // 3
            px[x, y] = (
                int(r * 0.35 + mid * 0.65),
                int(g * 0.35 + mid * 0.65),
                int(b * 0.35 + mid * 0.65),
                av,
            )
    return im


def decool(im: Image.Image, protect: list[tuple[int, int, int, int]]) -> None:
    """Remove cool-hued flecks from hair and skin, in place.

    The supplied layers carry a scatter of cyan/teal pixels along strand edges —
    a few hundred on the face layer — left over from whatever cut them out. Hair
    and skin are warm: R >= G >= B always holds, so a pixel where blue or green
    outruns red is an artefact and can be keyed on hue alone. Blue irises and
    sclera are the obvious exception, hence `protect`.
    """
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            if any(x0 <= x < x1 and y0 <= y < y1 for (x0, y0, x1, y1) in protect):
                continue
            r, g, b, a = px[x, y]
            if a < 24:
                continue
            if b > r + 5 or g > r + 9:
                warm = (r * 2 + g + b) // 4
                px[x, y] = (max(r, warm), min(g, warm), min(b, warm), a)


def lift_photo(photo: Image.Image) -> Image.Image:
    """The photograph resampled into canvas space."""
    big = photo.resize(
        (round(photo.width * PHOTO_SCALE), round(photo.height * PHOTO_SCALE)), Image.LANCZOS
    )
    ox, oy = round(PHOTO_ORIGIN[0] * PHOTO_SCALE), round(PHOTO_ORIGIN[1] * PHOTO_SCALE)
    return big.crop((ox, oy, ox + CANVAS[0], oy + CANVAS[1]))


def harden_matte(im: Image.Image) -> None:
    """Push a soft matte toward binary, in place.

    The layers' alpha does not agree with the photograph's actual coverage — a
    pixel the matte calls 40% can be almost solid hair in the photo. Trying to
    un-premultiply the backdrop out against that mismatched alpha drives the
    colour to black, and compositing it back produces neutral grey where the
    photo had warm brown. That was the haze in the hairstyle.

    It is also unnecessary work: she was shot on a white sweep and the hero sits
    on white, so the photograph's own anti-aliasing is already the correct blend.
    Drawing those pixels at full strength and keeping only a short toe at the
    silhouette gives a cleaner result than any matting arithmetic. The trade is
    that the cutout now assumes a white backdrop.
    """
    a = im.getchannel("A").point(
        lambda v: 0 if v <= 8 else 255 if v >= 48 else int((v - 8) * 255 / 40)
    )
    im.putalpha(a)


def drop_wall(im: Image.Image, keep: list[tuple[int, int, int, int]]) -> None:
    """Take the studio wall back out of a generous matte, in place.

    The exported mattes are soft: through the gaps between curls their alpha
    still covers the backdrop, and their own RGB painted hair over it. Swapping
    in the photograph's pixels exposes what was really there — grey wall and its
    shadow — as a haze inside the hairstyle. The wall is neutral where hair and
    skin are warm, so it can be keyed on saturation and scaled out of the alpha
    rather than the whole pixel being discarded, which preserves the soft strand
    edges the matte is good at. `keep` guards the neutral parts of *her*: sclera
    and a white tank top would otherwise key out too.
    """
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            if any(x0 <= x < x1 and y0 <= y < y1 for (x0, y0, x1, y1) in keep):
                continue
            mn = min(r, g, b)
            sat = max(r, g, b) - mn
            # Saturation is doing the work: the wall and its shadow are neutral
            # at every brightness, while hair keeps a warm cast even in its
            # darkest shadows. The brightness term only excludes near-black.
            bright = 0.0 if mn <= 70 else 1.0 if mn >= 120 else (mn - 70) / 50
            neutral = 0.0 if sat >= 30 else 1.0 if sat <= 14 else (30 - sat) / 16
            wall = bright * neutral
            if wall > 0:
                px[x, y] = (r, g, b, int(a * (1 - wall)))


def place_photo_space(im: Image.Image) -> Image.Image:
    """Lift a layer that lives in the photograph's coordinates onto the canvas."""
    scaled = im.resize(
        (round(im.width * PHOTO_SCALE), round(im.height * PHOTO_SCALE)), Image.LANCZOS
    )
    out = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
    ox, oy = to_canvas(0, 0)
    out.paste(scaled, (ox, oy), scaled)
    return out


# ------------------------------------------------------------------- eyes -----
def aperture_mask(rgb: Image.Image, e: dict) -> Image.Image:
    """The eyeball opening — sclera plus iris, bounded by lid and lash.

    Flood-filled outward from the pupil through neutral-or-dark pixels. Lid skin
    and lashes are warm-saturated and stop the fill, so the rim follows the real
    lid line instead of a hand-drawn spline. Intersected with an almond ellipse
    to trim the odd leak through a gap in the lower lashes.
    """
    x0, y0, x1, y1 = e["ap"]
    w, h = rgb.size
    px = rgb.load()
    cx, cy, r = e["c"][0], e["c"][1], e["r"]

    def eyeish(x, y):
        if (x - cx) ** 2 + (y - cy) ** 2 <= (r + 3) ** 2:
            return True
        rr, gg, bb = px[x, y]
        return (max(rr, gg, bb) - min(rr, gg, bb)) <= 42 and min(rr, gg, bb) >= 62

    seen = {e["c"]}
    q: deque = deque([e["c"]])
    while q:
        x, y = q.popleft()
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if x0 <= nx < x1 and y0 <= ny < y1 and (nx, ny) not in seen and eyeish(nx, ny):
                seen.add((nx, ny))
                q.append((nx, ny))

    m = Image.new("L", (w, h), 0)
    mp = m.load()
    for x, y in seen:
        mp[x, y] = 255
    m = m.filter(ImageFilter.MaxFilter(7)).filter(ImageFilter.MinFilter(7))

    trim = Image.new("L", (w, h), 0)
    ImageDraw.Draw(trim).ellipse([x0 + 1, y0 + 4, x1 - 1, y1 - 4], fill=255)
    return ImageChops.multiply(m, trim).filter(ImageFilter.GaussianBlur(1.0))


def mask_bbox(m: Image.Image, thresh: int = 128):
    return m.point(lambda v: 255 if v > thresh else 0).getbbox()


def inpaint_iris(rgb: Image.Image, ap: Image.Image, e: dict, rng: random.Random) -> None:
    """Paint clean sclera over the photographed iris, in place.

    Row-wise: for each scanline crossing the limbus, take healthy sclera from
    each side and blend across the gap. The sclera is a smooth vertical ramp —
    shadowed under the upper lid, bright toward the lower — so a per-row
    horizontal blend reproduces it convincingly, and a little grain goes back on
    top because a perfectly smooth fill reads as plastic beside real skin.

    Two details keep it from showing. Donors fall back to *neighbouring rows*
    rather than to the opposite side: at the outer canthus there is no sclera on
    the temporal side, and mirroring the bright nasal field into that gap paints
    a flat white slab. And the fill is composited through a blurred mask rather
    than written pixel by pixel, so its rim melts into untouched sclera instead
    of ending on a hard disc edge.
    """
    px, ap_px = rgb.load(), ap.load()
    cx, cy, r = e["c"][0], e["c"][1], e["r"]
    x0, y0, x1, y1 = e["ap"]
    # Wide enough to swallow the limbus RING, not just the coloured disc. The
    # dark outer edge of the iris and the lash shadow sitting on it extend past
    # the radius, and leaving them behind paints a crescent ghost of the old eye
    # position that only becomes visible once the iris travels away from it.
    fill_r, donor_r = r + 9, r + 14

    disc = Image.new("L", rgb.size, 0)
    ImageDraw.Draw(disc).ellipse([cx - fill_r, cy - fill_r, cx + fill_r, cy + fill_r], fill=255)
    region = ImageChops.multiply(disc, ap.filter(ImageFilter.MinFilter(5)))
    rg = region.load()

    def donors(y, step):
        for dy in (0, -1, 1, -2, 2, -3, 3, -4, 4):
            yy = y + dy
            if not (y0 <= yy < y1):
                continue
            ddy = yy - cy
            dhalf = int((donor_r**2 - ddy**2) ** 0.5) if abs(ddy) <= donor_r else 0
            xs = []
            x = cx + step * (dhalf + 1)
            while x0 <= x < x1 and len(xs) < 5:
                if ap_px[x, y] > 170 and rg[x, yy] < 8:
                    rr, gg, bb = px[x, yy]
                    # skip lash bleed and blown speculars; neither is sclera
                    if 70 <= min(rr, gg, bb) and max(rr, gg, bb) <= 232:
                        xs.append((rr, gg, bb))
                x += step
            if xs:
                n = len(xs)
                return tuple(sum(c[i] for c in xs) // n for i in range(3))
        return None

    filled = rgb.copy()
    fp = filled.load()
    for y in range(max(y0, cy - fill_r), min(y1, cy + fill_r + 1)):
        dy = y - cy
        if abs(dy) > fill_r:
            continue
        half = int((fill_r**2 - dy**2) ** 0.5)
        left, right = donors(y, -1), donors(y, +1)
        if left is None and right is None:
            continue
        left = left or right
        right = right or left
        for x in range(cx - half, cx + half + 1):
            if not (x0 <= x < x1):
                continue
            t = (x - (cx - half)) / max(1, 2 * half)
            n = rng.randint(-3, 3)
            fp[x, y] = tuple(
                max(0, min(255, int(left[i] + (right[i] - left[i]) * t) + n)) for i in range(3)
            )

    rgb.paste(filled, (0, 0), region.filter(ImageFilter.GaussianBlur(2.6)))


def sprite(src: Image.Image, box, alpha: Image.Image) -> Image.Image:
    out = src.crop(box).convert("RGBA")
    out.putalpha(alpha.crop(box))
    return out


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) < 2:
        print("usage: build-hero-layers.py <layer-dir> <source-photo> [--debug]", file=sys.stderr)
        return 2
    src_dir = Path(args[0]).expanduser()
    photo_path = Path(args[1]).expanduser()
    if not photo_path.exists():
        print(f"source photograph not found: {photo_path}", file=sys.stderr)
        return 2
    debug = "--debug" in sys.argv
    rng = random.Random(7)

    missing = [p["src"] for p in PLANES if not (src_dir / p["src"]).exists()]
    if missing:
        print(f"missing layer files in {src_dir}: {', '.join(missing)}", file=sys.stderr)
        return 2

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Blue irises and sclera are legitimately cool; everything else on a warm
    # portrait is not. Protect a generous box around each eye.
    protect = [
        (
            to_canvas(e["ap"][0] - 14, e["ap"][1] - 14)[0],
            to_canvas(e["ap"][0] - 14, e["ap"][1] - 14)[1],
            to_canvas(e["ap"][2] + 14, e["ap"][3] + 14)[0],
            to_canvas(e["ap"][2] + 14, e["ap"][3] + 14)[1],
        )
        for e in EYES_PHOTO
    ]

    photo = Image.open(photo_path).convert("RGB")
    # Named explicitly and checked, never sniffed from the directory: an earlier
    # version picked the alphabetically-first PNG and silently built the hero out
    # of an unrelated photograph.
    if photo.size != PHOTO_SIZE:
        print(
            f"{photo_path.name} is {photo.size}, expected {PHOTO_SIZE} — the eye "
            f"coordinates and PHOTO_SCALE are measured against that frame.",
            file=sys.stderr,
        )
        return 2
    photo_canvas = lift_photo(photo)

    loaded = {}
    for p in PLANES:
        layer = load_layer(src_dir / p["src"])
        if p.get("own_pixels"):
            im = layer  # invented hair; the photograph has nothing to offer here
        else:
            # matte from the layer, colour from the photograph
            base = photo if p.get("photo_space") else photo_canvas
            if base.size != layer.size:
                print(
                    f"warning: {p['src']} is {layer.size}, photo base is {base.size}",
                    file=sys.stderr,
                )
            im = base.convert("RGBA")
            im.putalpha(layer.getchannel("A"))
            harden_matte(im)
            if p["key"] in ("face", "hairFront"):
                drop_wall(im, protect + [(0, 1180, CANVAS[0], CANVAS[1])])
        decool(im, protect if p["key"] == "face" else [])
        if p.get("photo_space"):
            im = place_photo_space(im)
        loaded[p["key"]] = im

    eyes = [
        {
            "n": e["n"],
            "c": to_canvas(*e["c"]),
            "r": max(3, round(e["r"] * PHOTO_SCALE)),
            "ap": (*to_canvas(e["ap"][0], e["ap"][1]), *to_canvas(e["ap"][2], e["ap"][3])),
        }
        for e in EYES_PHOTO
    ]

    face = loaded["face"]
    face_alpha = face.getchannel("A")
    face_rgb = face.convert("RGB")

    meta, irises, lids, apertures = [], {}, {}, {}
    for e in eyes:
        ap = aperture_mask(face_rgb, e)
        fb = mask_bbox(ap)  # the real fissure, measured rather than assumed
        if fb is None:
            print(f"could not find an aperture for eye {e['n']}", file=sys.stderr)
            return 1
        cx, cy, r = e["c"][0], e["c"][1], e["r"]

        # iris sprite comes off the ORIGINAL pixels, before the socket is cleaned
        disc = Image.new("L", CANVAS, 0)
        ImageDraw.Draw(disc).ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
        disc = disc.filter(ImageFilter.GaussianBlur(1.4))
        irises[e["n"]] = sprite(face_rgb, (cx - r - 2, cy - r - 2, cx + r + 3, cy + r + 3), disc)

        # Upper lid and lash line, slid down to blink.
        #
        # The feathering matters more than it looks. A plain rectangle cropped to
        # its own bounds is opaque right to the edge, so a half-closed lid reads
        # as a hard-edged box sliding over the eye rather than as an eyelid. So
        # the crop carries a margin on the left, right and top that the blur can
        # fall off into, while the fill runs past the bottom of the crop to keep
        # the lash line — the feature that actually sells the blink — crisp.
        # It also has to reach as far ABOVE the lash line as it will travel: the
        # sprite slides down as a whole, so a short one drags its own top edge
        # into the socket and leaves the top of the eye showing at full close.
        # Extending it by the fissure height means a drop of exactly that height
        # lands its top edge on the top of the fissure — full cover, no gap.
        pad = 14
        fh = fb[3] - fb[1]
        lid_box = (fb[0] - 8 - pad, fb[1] - fh - pad, fb[2] + 8 + pad, fb[1] + 16)
        lid_a = Image.new("L", CANVAS, 0)
        ImageDraw.Draw(lid_a).rectangle(
            [fb[0] - 8, fb[1] - fh, fb[2] + 8, fb[1] + 16 + pad], fill=255
        )
        lid_a = ImageChops.multiply(lid_a.filter(ImageFilter.GaussianBlur(7)), face_alpha)
        lids[e["n"]] = sprite(face_rgb, lid_box, lid_a)

        inpaint_iris(face_rgb, ap, e, rng)
        apertures[e["n"]] = (ap, fb)

        meta.append(
            {
                "id": e["n"],
                "rest": ((fb[0] + fb[2]) // 2 + REST_BIAS_X, (fb[1] + fb[3]) // 2 + REST_BIAS_Y),
                "radius": r,
                # Two limits, whichever is tighter. The anatomical one comes
                # first: a real iris shifts about a quarter of its own diameter
                # before the flat-decal illusion fails, which is also roughly
                # what keeps it overlapping its own inpainted socket, so the
                # repaired sclera never gets fully uncovered. The second is the
                # canthus — it must not slide out through the corner of the eye.
                "travel": {
                    "x": max(4, min(round(0.50 * r), (fb[2] - fb[0]) // 2 - r - 4)),
                    "y": max(3, min(round(0.28 * r), (fb[3] - fb[1]) // 2 - r + 5)),
                },
                "lidBox": lid_box,
                "lidDrop": fb[3] - fb[1],
            }
        )

    face = face_rgb.convert("RGBA")
    face.putalpha(face_alpha)
    loaded["face"] = face

    # Every plane redraws content the ones above it already have: head+face
    # carries the WHOLE hairstyle that hair-front draws again, and shoulders
    # carries the chest hair and neck skin a third time. Nearly half of the body
    # plane is also painted by hair-front. At rest the duplicates sit exactly on
    # top of each other and nothing shows; under parallax they travel at
    # different rates and separate into a translucent ghost — which is precisely
    # the doubling visible over her chest.
    #
    # So punch each plane out of the ones beneath it, leaving exactly one owner
    # per pixel. The erosion is the important part: punching on the raw alpha
    # would trim the lower plane flush to the upper one, and the moment they
    # separate a hole opens along every shared boundary. Eroding first leaves an
    # overlap band wider than the largest relative displacement the rig can
    # produce, so the seam is always covered.
    overlap = 2 * OVERLAP_PX + 1
    for i in range(len(PLANES)):
        lower = loaded[PLANES[i]["key"]]
        a = lower.getchannel("A")
        for j in range(i + 1, len(PLANES)):
            upper = loaded[PLANES[j]["key"]].getchannel("A")
            a = ImageChops.multiply(
                a, ImageChops.invert(upper.filter(ImageFilter.MinFilter(overlap)))
            )
        lower.putalpha(a)

    sizes = {}

    def save(img, name, q=90, aq=100):
        img.save(OUT_DIR / name, "WEBP", quality=q, method=4, alpha_quality=aq)
        sizes[name] = (OUT_DIR / name).stat().st_size

    for p in PLANES:
        save(loaded[p["key"]], p["out"], p["q"], p["aq"])
    for n in ("l", "r"):
        # sprites are tiny and sit at the focal point; keep them near-lossless
        save(irises[n], f"iris-{n}.webp", 94)
        save(lids[n], f"lid-{n}.webp", 94)
        ap, fb = apertures[n]
        pad = (fb[0] - 5, fb[1] - 5, fb[2] + 5, fb[3] + 5)
        ap.crop(pad).save(OUT_DIR / f"aperture-{n}.png", optimize=True)
        sizes[f"aperture-{n}.png"] = (OUT_DIR / f"aperture-{n}.png").stat().st_size
        for m in meta:
            if m["id"] == n:
                m["aperturePad"] = pad

    cw, ch = CANVAS

    def rel(pt):
        return [round(pt[0] / cw, 6), round(pt[1] / ch, 6)]

    manifest = {
        "_": "Generated by apps/web/scripts/build-hero-layers.py — do not hand-edit.",
        "canvas": {"width": cw, "height": ch},
        # Painted back to front. `follow` is the share of the head's motion this
        # plane takes, not a z-distance — see the module docstring.
        "planes": [{"src": p["out"], "follow": p["follow"]} for p in PLANES],
        "eyes": [
            {
                "id": m["id"],
                "rest": rel(m["rest"]),
                "travel": [round(m["travel"]["x"] / cw, 6), round(m["travel"]["y"] / ch, 6)],
                "aperture": {
                    "src": f"aperture-{m['id']}.png",
                    "rect": [
                        *rel((m["aperturePad"][0], m["aperturePad"][1])),
                        round((m["aperturePad"][2] - m["aperturePad"][0]) / cw, 6),
                        round((m["aperturePad"][3] - m["aperturePad"][1]) / ch, 6),
                    ],
                },
                "iris": {
                    "src": f"iris-{m['id']}.webp",
                    "size": round((m["radius"] + 2) * 2 / cw, 6),
                },
                "lid": {
                    "src": f"lid-{m['id']}.webp",
                    "rect": [
                        *rel((m["lidBox"][0], m["lidBox"][1])),
                        round((m["lidBox"][2] - m["lidBox"][0]) / cw, 6),
                        round((m["lidBox"][3] - m["lidBox"][1]) / ch, 6),
                    ],
                    "drop": round(m["lidDrop"] / ch, 6),
                },
            }
            for m in meta
        ],
    }
    (OUT_DIR / "hero.json").write_text(json.dumps(manifest, indent=2) + "\n")

    for k, v in sorted(sizes.items()):
        print(f"  {k:<20} {v / 1024:7.1f} KB")
    print(f"  {'TOTAL':<20} {sum(sizes.values()) / 1024:7.1f} KB   canvas {cw}x{ch}")

    if debug:
        paper = Image.new("RGB", CANVAS, BACKDROP)
        for p in PLANES:
            layer = loaded[p["key"]]
            paper.paste(layer, (0, 0), layer)
        for m in meta:
            ir = irises[m["id"]]
            rx, ry = m["rest"]
            paper.paste(ir, (rx - ir.width // 2, ry - ir.height // 2), ir)
        dbg = Path(__file__).resolve().parent / "_debug-hero.png"
        paper.save(dbg)
        print(f"  debug composite -> {dbg}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
