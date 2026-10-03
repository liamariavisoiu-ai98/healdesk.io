# Hero frame grid — production spec

How to generate the real frames for the frame-mapping hero, and how to get them
into the site.

## Seeing it now

One page, five renderers, picked by `?hero=`. `HeroStage.tsx` reads the param
once on mount and anything it does not recognise falls through to the default, so
a typo shows you the layered hero rather than a blank stage.

| | |
| --- | --- |
| Layered 2.5D renderer (default) | <http://localhost:3000/> |
| Frame grid, clip 1 — `public/hero-frames/`, 9×1 | <http://localhost:3000/?hero=frames> |
| Frame grid, clip 2 — `public/hero-frames-2/`, 5×3 portrait | <http://localhost:3000/?hero=frames2> |
| Scrubbed video, clip 1 — `public/hero-video/` | <http://localhost:3000/?hero=video> |
| Scrubbed video, clip 2 — `public/hero-video-2/` | <http://localhost:3000/?hero=video2> |

All five run off the same rig (`src/lib/useGazeRig.ts`) and differ only in how
they draw. The two grids and the two videos are the same two generated clips
processed two different ways, which is the reason the choice is a query param and
not an edit to the source: they only tell you anything when compared against each
other on one page.

Neither grid is a placeholder any more. The grid rendered from the 2.5D rig —
which existed to prove the engine, and inherited that rig's limits — is gone;
variant a is 9×1 real frames from the Seedance clip and variant b is the 5×3
portrait grid from the Gemini clip. Replacing either still changes no code: the
geometry lives in its `frames.json`.

## What the engine expects

A 2-D grid of complete images, indexed `[pitch][yaw]`.

| | |
| --- | --- |
| Default grid | 9 yaw × 5 pitch = 45 cells |
| Naming | `f_{row}_{col}.webp`, one directory per clip under `apps/web/public/` |
| Width | 900px (height follows the source aspect) |
| Background | white, matching the hero |
| Rest cell | the geometric centre (`f_2_4` on a 9×5) unless `frames.json` names another with `rest` — see below |

Columns run **her gaze left → right**, rows run **up → down**. The grid does not
have to be 9×5; set `cols`/`rows` in `frames.json` to whatever you produce. A
single row (`rows: 1`) is a legitimate v1 — yaw only, no pitch — and the engine
handles it without changes.

## `rest`: the cell where she is looking at the lens

An optional key in `frames.json`:

```json
"rest": { "row": 2, "col": 1 }
```

It names the cell in which she is looking **down the lens**, and the renderer maps
aim (0, 0) onto it — so first paint, the reduced-motion still and the static
fallback `<img>` under the canvas all show that cell. Omit it and the renderer
falls back to the geometric centre and behaves exactly as it did before, which is
why variant a, which has no `rest`, is unaffected by the key existing.

It is needed because **the geometric centre of the grid is not the camera**. The
binner normalises gaze over the clip's *observed* range, so the middle cell is the
middle of whatever the clip happened to do. On the Gemini clip that is neither
level nor centred: rows 0 and 1 are both looking UP — pupils high, whites showing
beneath — and row 2 is the only level row. So the old centre cell `f_1_2` had her
looking up and to her right, and that cell was what every visitor saw at first
paint, what a reduced-motion visitor saw permanently, and what the fallback
`<img>` showed. `f_2_1` is the frame where she meets the lens. It was picked by
eye off a contact sheet of all 15 cells, zoomed to the eyes.

Which is the instruction: **after a build, look at the grid zoomed to the eyes and
pick the cell where she meets the lens.** Do not assume it is the middle. The
binner cannot do this for you — it knows where the extremes of the clip are, not
where the camera is.

One consequence on this clip, because it constrains the renderer: its vertical
range runs level-to-**up**, with no downward gaze at all. With `rest` on row 2,
the bottom row, there is no "down" left to travel into — so the scroll-linked
downward glance that hands the visitor off to the demo (`gazeBiasY` in
`HeroStage.tsx`) has nowhere to go, and stays dormant until a clip that actually
looks down exists.

## The awkward part: these tools make video, not grids

HeyGen, Synthesia and Seedance hand you a clip. A clip traces **one path**
through the grid, so it becomes **one row**: film her sweeping her gaze left to
right while holding a fixed head pitch. Then run it once per pitch level.

```
./scripts/frames-from-video.sh row-centre.mp4 2      # centre pitch  -> row 2
./scripts/frames-from-video.sh row-up.mp4     0      # looking up    -> row 0
./scripts/frames-from-video.sh row-down.mp4   4      # looking down  -> row 4
```

It samples `cols` evenly spaced *timestamps* (not frame numbers — generated
clips vary in frame rate and length, and even times keep the yaw steps even),
scales to 900px, and writes WebP.

Then set `cols`, `rows` and `placeholder: false` in
`public/hero-frames/frames.json`, and check the grid:

```
python3 scripts/build-hero-frames.py --verify
```

That catches the two failures that otherwise only appear when someone moves the
cursor into one corner: a missing cell, and cells that disagree on dimensions.

## Generating the clips — what must be locked

Frame-to-frame consistency is the real risk here, more than image quality. The
grid gets stepped through discretely, so anything that drifts between cells
reads as flicker. Lock:

- **Framing and crop.** Identical. Any change in head size or position across
  cells makes her jump as the cursor moves.
- **Lighting.** Same key, same intensity. A shifting highlight is very visible.
- **Expression.** Neutral, mouth closed, held. Only gaze and head angle change.
- **Hair.** No wind, no settling. Curls that move between cells shimmer.
- **Wardrobe and background.** Unchanged.

Prompt shape that works: *a single continuous take, camera locked off, subject
holds a neutral expression and slowly turns her gaze from far left to far right,
no other movement, no camera motion, plain white background.*

Slow and continuous beats fast — you are sampling instants out of it, and motion
blur at the sample points will soften those cells relative to the rest.

## Blinking needs its own strip

Blinking cannot share the gaze axis. If cells are indexed by where she is
looking, there is no dimension left for eyelids, and a full blink × gaze grid is
combinatorial.

The cheap answer is a short separate blink sequence shot looking down the lens —
the rest cell, not necessarily the middle of the grid — drawn over whatever cell
is showing, replacing it outright for the ~275ms of the blink rather than
blending with it. That is why the strip has to match the grid's lighting and
framing exactly: nothing softens it. Only ~20ms is fully closed, so her head
being slightly turned during one is not noticeable. Generate that strip in
the same session, while the lighting is still locked — coming back for it later
is how you end up with a blink that does not match the rest of the grid.

## Payload

The placeholder grid was 4.1MB for 45 cells at 900px, about 90KB each — roughly
ten times the layered hero. The grid that ships is 604K for 20 files at 405px,
having already pulled the first and third of these. Levers, in the order worth
pulling:

1. **Fewer cells.** 7×3 = 21 is less than half of 9×5 and the steps are still
   small enough to read as continuous once the rig is smoothing between them.
2. **Lower quality on the outer cells.** The centre of the grid is where the
   cursor spends most of its time and where a viewer is looking hardest.
3. **Narrower frames.** 900px is generous for a portrait that renders around
   675 CSS px wide.

Only one cell blocks first paint — the rest cell, named by `rest` in
`frames.json` or the geometric centre if it is absent. The engine loads that one,
shows it, and starts tracking immediately — then fetches the rest in the
background. It does NOT wait for the grid to be complete: a cell that has not
arrived is simply left out of the blend, whose weights renormalise over whatever
has. So on a cold cache she tracks from the first frame, snapping between the
cells that have landed, rather than holding still until all twenty have.

---

# Seedance 2.0 prompt (via ElevenLabs)

Use the **original photograph** as the reference image so the identity matches
the rest of the site: `14D57899-05E7-42BD-ADE6-2008DDD22112.PNG` (852×1846).

## What the first clip taught us

The first generation worked and is live in the hero, but it exposed two gaps in
the prompt below — both worth fixing in the next one.

| | measured | consequence |
| --- | --- | --- |
| Horizontal gaze range | spread 0.230 | good, filled 9 columns |
| **Vertical gaze range** | **spread 0.052** | she never looks up or down, so only ONE row |
| **Blinks** | **none** | nothing to harvest for the blink sequence |

So ask for the gaze to **wander in a circle**, not sweep in a line, and to
**blink naturally**. A circular path is better than a linear one for two
separate reasons: it reaches up and down as well as side to side, and — more
importantly — it fills the whole grid from a **single generation**. Rows shot as
separate clips drift apart in hair, lighting and framing, and that drift is far
more visible than any gap in coverage.

## What the second clip's ceiling is — measured

The shipped 5×3 grid comes from
`~/Downloads/ElevenLabs_video_Gemini Omni Flash_Static locked-off camera, no c.mp4`
— 1280×720, 24fps, **5 seconds = 120 frames**. Asking the binner for denser grids
out of those same 120 frames (`--dry-run`, eye box `0.40,0.28,0.60,0.40`), and
counting how many *distinct* frames it could find to fill them:

| grid | cells | distinct frames |
| --- | --- | --- |
| **5×3 — shipped** | 15 | **12** |
| 7×3 | 21 | 16 |
| 9×3 | 27 | 18 |
| 9×2 | 18 | 13 |

So the grid that ships already contains duplicate cells, and going denser buys
almost nothing: 9×3 nearly doubles the cell count for six more photographs, and a
third of that grid would be cells repeating a neighbour.

The range is not the problem — the spreads measure good, h 0.348 and v 0.261. The
problem is that a circular wander visits a **ring**, not a filled area: the frames
cluster along the path it traced, the corners of the grid have nothing near them,
and five seconds is not even much of one ring. More processing cannot invent a
frame the clip never contained.

**A denser grid needs a new clip, not more processing.** This is the evidence
behind the 10s+ in the Settings table below: every extra second is another 24
frames to choose from, and a second orbit lands in different places than the
first.

## The prompt — and why it is a LINE, not a circle

An earlier version of this file asked for the gaze to wander in a circle. That
was right for the frame **grid**, which is two-dimensional. It is wrong for the
renderer we actually use, which scrubs a video: that is a **one-dimensional**
axis, so whatever the clip does vertically comes along for the ride and cannot
be separated out. Ordering a wandering clip along one axis scrambles the other.

Measured over the two clips generated so far:

| clip | vertical/horizontal motion | usable for scrubbing |
| --- | --- | --- |
| Seedance, "sweep left to right" | 0.16 — six times more horizontal | yes, 133 positions |
| Gemini, "wander in a circle" | 0.68 | no — holding the vertical steady leaves almost no horizontal range |

So: **one slow continuous horizontal pass, and nothing else.**

```
Static locked-off camera, no camera movement whatsoever. Medium close-up
portrait of the same young woman, head and shoulders, centred, filling the
frame exactly as in the reference image. Plain seamless WHITE studio
background, evenly lit, no cast shadow behind her.

She holds a calm neutral expression with her lips gently closed. She does not
speak. Her eye line stays level throughout — she never looks up or down.

The only movement: her eyes track slowly and continuously from far left to far
right, one single unbroken pass taking the whole clip. Her head turns gently to
follow, a few degrees only. Shoulders motionless. Hair still.

She blinks naturally two or three times.

Photorealistic, sharp focus on the eyes, natural skin texture, consistent
exposure and colour from first frame to last.
```

**Negative / avoid:**

```
camera movement, zoom, dolly, push in, pan, handheld shake, cuts, speaking,
talking, mouth movement, smiling, changing expression, looking up, looking
down, tilting head, large head turns, hair moving, wind, changing light,
flickering, grey background, cast shadow, background elements, props, hands,
text, watermark
```

Three details that each cost a whole regeneration when missed:

- **Portrait, 1080p or better.** A 16:9 clip in a tall hero crops to a head with
  no shoulders, and 720p upscales visibly.
- **White background, no cast shadow.** A grey sweep reads as a rectangle on the
  page. It can be keyed out, but a shadow inside the frame cannot be, cleanly.
- **One continuous take.** The Gemini clip opened on a different, closer shot
  and cut at frame 7; those frames sort into the middle of the sweep.

## Settings

| | |
| --- | --- |
| Duration | As long as it allows — 10s+. A circular path needs more time than a line to cover the same ground, and every extra second is more frames to choose from. The 5s clip we have yields 12 distinct frames for 15 cells; see the measured ceiling above. |
| Motion / dynamism | **Lowest available.** High motion is what breaks this. |
| Resolution | 1080p or better; downscaled to 900px. |
| Aspect | Portrait, matching the reference. |

## Processing it

```
# does it have the range and the blinks this time?
python3 apps/web/scripts/bin-frames-by-gaze.py clip.mp4 --cols 9 --rows 3 \
    --eye-box 0.33,0.37,0.66,0.46 --dry-run

# write the grid, harvesting blinks
python3 apps/web/scripts/bin-frames-by-gaze.py clip.mp4 --cols 9 --rows 3 \
    --eye-box 0.33,0.37,0.66,0.46 --blinks 6

python3 apps/web/scripts/build-hero-frames.py --verify
```

Takes a couple of minutes — it decodes every frame twice. It reports the
horizontal and vertical spread it measured and **refuses to build more than one
row if the clip has no vertical range**, rather than silently filling the extra
rows with duplicates.

Add `--flip-x` if column 0 comes out looking right instead of left.

### `--crop x0,y0,x1,y1` — a portrait grid out of a landscape clip

The generators keep handing back 16:9 however hard the prompt asks for portrait,
and a 16:9 cell in a tall hero rig is a close-up with no shoulders. So the binner
crops, in **extracted-frame pixels** — pixels of the frame after `--width`, not of
the source, and not fractions, because the number that matters is an aspect ratio
and fractions of an unknown width hide it. Clip 2's grid in one pass, had the flag
existed when it was built:

```
python3 apps/web/scripts/bin-frames-by-gaze.py clip.mp4 --cols 5 --rows 3 \
    --eye-box 0.40,0.28,0.60,0.40 --crop 470,0,875,720 --guard ... --blinks 5
```

The crop happens **before** the wall key and the feather, and that ordering is the
entire reason to do it here rather than over the finished WebPs. The guard ellipse
and the edge ramps are both computed from the frame's own dimensions, so cropping
first means they are built for the frame that actually ships — and the frames are
encoded once instead of twice. This is what a build from a fresh clip should use.

Two things follow from where in the pipeline it sits:

- **`--eye-box` and the gaze binning are unaffected.** Both run on the uncropped
  thumbnail pass, so the measured spreads and the cell assignment come out
  identical cropped or not. The eye box is a fraction of the *full* frame even
  when the output is a narrow slice of it.
- **`--guard` must be retuned.** It is a fraction of the **cropped** frame. The
  default `0.18,0.08,0.82,0.72` describes a face filling a full frame; against a
  narrower one it leaves an eye outside the ellipse, and the wall key punches
  straight through it.

## Re-framing a grid that already exists

```
python3 apps/web/scripts/recrop-hero-frames.py <dir> --crop x0,y0,x1,y1 \
    [--sides blur,white]
```

`--crop` on the binner is right for a fresh build and wrong for a grid that has
already been built and eyeballed, because re-running the binner does not re-frame
— it **re-picks**. The gaze estimate depends on the eye box, the eye box depends on
the framing, and a box retuned for landscape sorts the same 120 frames into
different cells *and* into a different row order. On this clip it also pulls two
frames out of the tighter shot the clip opens with, which land mid-grid as a
visible cut — the `--start` problem above. And `rest` names a cell by index, so a
silent re-pick points it at a frame nobody chose.

So this script crops and nothing else. It applies a **side-only** feather: the
frames arrive already keyed and feathered, but feathered for their original width,
so the top and bottom ramps fall inside the crop and are already correct while the
newly cut left and right edges have none at all. Doing all four again would double
the ramps that were fine.

What was actually run for `hero-frames-2`:

```
python3 apps/web/scripts/recrop-hero-frames.py hero-frames-2 \
    --crop 470,0,875,720 --sides 0.14,0.06
```

1280×720 → 405×720 (9:16), 928K → 604K across 20 files (15 cells and 5 blinks).

| | |
| --- | --- |
| Crop centre | x = 672 — the measured **median face centre** over all 20 frames |
| Not | the frame centre (640), and not the hair midpoint (636) |
| Face | spans 530..811 in source pixels, so 60..341 of the 405-wide crop |
| Side ramps | 0.14 / 0.06, against a default of 0.07 / 0.03 |

Her hair is asymmetric, so centring the crop on it put the face off-axis; on the
face centre the margins are even and both cheeks sit clear of the 56px blur ramp.
The ramps are wider than the default because this crop cuts through **hair**
rather than through empty paper, and at the default width the blur ended while
there was still hair to fade, leaving it terminating at a visible vertical edge.

## A note on the blink detector

Two designs were tried and discarded before the one in the script. Keying on
"less visible sclera than usual" fires every time she looks sideways — a turned
eye shows less white too — and it returned six wide-open frames. A temporal test,
"the fastest local change in the eye region", fails for the opposite reason: head
motion moves that region faster than a lid does.

What ships counts lit SCANLINES. For each row across the eye box it asks whether
any pixel is bright enough to be sclera, and a frame is a blink when that count
falls below 0.88 of the clip's own median. It measures the thing itself — when
the lid comes down the sclera vanishes from the rows it covers, and nothing else
in a locked-off portrait does that — and being relative to the median means it
does not care how tightly the clip is framed.

It has since met a clip that blinks. The Gemini clip gave up five frames —
`blink_0..4` in `hero-frames-2/`, ordered open → shut — and they are what the
grid renderer draws over the look-away, which is why variant b can afford that
break and variant a cannot.
