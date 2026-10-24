# The AYA ad, built in Remotion

`SCRIPT.md` is the brief. This folder builds its 36-second hero cut in
[Remotion](https://www.remotion.dev) (React rendered to video), in the
script's three formats from one timeline:

| Composition | Size | File |
| --- | --- | --- |
| `AyaHero` | 1080 × 1920 (9:16) | `out/aya-hero-9x16.mp4` |
| `AyaFeed` | 1080 × 1350 (4:5) | `out/aya-feed-4x5.mp4` |
| `AyaWide` | 1920 × 1080 (16:9) | `out/aya-wide-16x9.mp4` |
| `AyaHeroStat` | 1080 × 1920, the 85% hook | `out/aya-hero-9x16-stat-hook-UNSOURCED.mp4` |

It sits outside the npm workspaces on purpose: Remotion and its Chromium
renderer never enter the apps' installs, builds or CI. It handles no patient
data and talks to no service.

## Running it

```sh
cd marketing/video
npm ci
npm run studio          # preview and scrub in the browser
npm run soundtrack      # rebuild public/soundtrack.wav (needs ffmpeg)
npm run render          # soundtrack, then all four MP4s into out/
```

Remotion downloads its own headless Chrome unless `REMOTION_BROWSER` names
one; in the cloud container it is
`/opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`.

## Where things are

- `src/copy.ts`: every word the ad says or prints, both hooks and the
  captions' timing. Check claims here.
- `src/tokens.ts`: the script's palette, Plus Jakarta Sans, the enter, exit
  and snap curves.
- `src/motion.tsx`: the stage (1080 × 1500 for 9:16 and 4:5, 1920 × 1080 for
  16:9) and the motion helpers.
- `src/scenes/S1Hook.tsx` … `S6Dare.tsx`: one file per scene. Timings are the
  global frame numbers SCRIPT.md gives; `src/Ad.tsx` switches scenes on the
  frame rather than wrapping them in `<Sequence>`.
- `scripts/soundtrack.mjs`: the music bed and every effect from the cue
  sheet, synthesised (no licensed audio), then loudness-normalised to
  -14 LUFS, -1 dBTP. Deterministic.
- `public/`: AYA cut out of her brand portrait (`aya-cutout.webp`), her
  3-second brand clip (`aya-gesture-720.mp4`, from
  `apps/web/public/brand/aya-final-cta.mp4`), its last frame, the channel
  icons and the healdesk wordmark, copied from `apps/web/public`.

## Where this build differs from SCRIPT.md

- **AYA is the existing brand photography, not an illustrated rig.** The repo
  has no character artwork, so the acting beats are carried by motion: the
  coin stops dead mid-roll with a tink and a coral ring (the catch), the
  finger snap is a coral spark, and the dare plays her real brand clip. The
  wink, eyebrow raises and finger counting need the rig the script's asset
  list describes.
- **No voice yet.** The voiceover runs as burned-in, word-by-word captions on
  the script's timings. When a voice is recorded, add it as an `<Audio>` in
  `src/Ad.tsx`, replace `VO` in `src/copy.ts` with its word timestamps, and
  duck the music by 8 dB under it.
- **"Grab your free trial" reads "build your free AYA".** healdesk has no free
  trial: billing starts on the day AYA first answers a patient and the setup
  fee is paid at checkout. What is free is the AYA built from the visitor's
  URL, which is what the end card already offers.
- **The default hook is the soft one** ("Most callers who hit voicemail never
  call back"), the script's own fallback until the 85% and 82% figures have a
  named primary source. `AyaHeroStat` renders the 85% / 82% / $1,500 version
  for the hook test, with a placeholder where the source must go.
- The fictional clinic's treatments carry made-up prices (`src/copy.ts`).
  Check that the name Bella Skin Studio and its domain belong to no real
  clinic before publishing.

The script's "Before publishing" list still applies in full; above all,
booking into the calendar and the deposit link in chat must be live in
production before the ad runs.
