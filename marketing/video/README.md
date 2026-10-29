# The Aya ad, built in Remotion

`SCRIPT.md` is the brief. This folder builds its hero cut (about 37 seconds) in
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
- `src/scenes/S1Hook.tsx` … `S7Dare.tsx`: one file per scene, each counting
  its own frames from 0. The timeline is `SCENES` in `src/copy.ts`;
  `src/Ad.tsx` places the scenes on it.
- `src/parts.tsx`: the glass kit: `Glass`, the drifting colour field behind
  it (`Backdrop`), the notification banner, the orb that stands for Aya,
  blur-in kinetic type, the dollar burst, the captions.
- `scripts/soundtrack.mjs`: the music bed and every effect, synthesised (no
  licensed audio), cued to the same timeline, then loudness-normalised to
  -14 LUFS, -1 dBTP. Deterministic.
- `public/`: Aya's 3-second brand clip (`aya-gesture-720.mp4`, from
  `apps/web/public/brand/aya-final-cta.mp4`) and its last frame, the healdesk
  app icon and wordmark, and the channel and Stripe icons, copied from
  `apps/web/public` (Messenger's is drawn in `messenger.svg`).

## The cut, scene by scene

Frames come from `src/timeline.json`, which the scenes and the soundtrack
both read; change a scene's length there.

| # | Frames | What happens |
| --- | --- | --- |
| 1 | 0–240 | Slow on purpose: "Missed calls?" while the phone rings out, "Missed DMs?" while Instagram, Messenger, WhatsApp and website chat pile up, then the line, the pile leaving for "Clinic down the street", and "That booking? Gone." The coin drops. |
| 2 | 240–320 | The coin is caught; ivory floods out; Aya arrives as a glowing glass orb. Three badges. |
| 3 | 320–500 | The orb becomes the caret of a URL box; the clinic's brand, prices and chat assemble. |
| 4 | 500–680 | Five glass conversations burst from the orb (phone, WhatsApp, Instagram, Messenger, website chat), each books into the week with its price, the booked value counts to $1,646, and a healdesk notification lands. |
| 5 | 680–800 | In website chat Aya sends the deposit link; the patient pays $100.00 on Stripe's checkout; coins and sparkles; healdesk notifies the clinic. |
| 6 | 800–950 | The night on the owner's lock screen: healdesk notifications at 11:48 PM, 2:15 AM and 7:02 AM. |
| 7 | 950–1100 | The close, and the only time Aya's face appears: "Try me out now. Just add your website, and I'll be ready in a few minutes." A URL box, "Try Aya free", the wordmark; the last 15 frames hold still. |

## Where this build differs from SCRIPT.md

- **Aya, not AYA,** on screen and in the captions (owner, 29 October 2026).
  The website still writes AYA.
- **Aya is an orb until the close.** Her face appears only in the last scene,
  from her real brand clip. Before that, a glowing glass orb stands for her,
  so the acting beats (the catch, the snap, the counting) are carried by
  motion rather than by an illustrated character.
- **The deposit is a Stripe checkout for a real booking:** a HydraFacial
  ($199) booked in website chat, held by a $100.00 deposit. The checkout
  shows only the clinic, "Appointment deposit", the amount and a reference:
  no treatment name reaches Stripe, which CLAUDE.md requires. The card is
  Stripe's well-known test number, masked. Treatments are named only in
  website chat; the Meta messages stay non-clinical, and their prices appear
  only on the clinic's own calendar.
- **Every notification Aya sends the clinic carries the healdesk icon.**
- **No voice yet.** The voiceover runs as burned-in, word-by-word captions on
  the script's timings. When a voice is recorded, add it as an `<Audio>` in
  `src/Ad.tsx`, replace `VO` in `src/copy.ts` with its word timestamps, and
  duck the music by 8 dB under it.
- **The dare is gone; the close is the owner's line**, "Try me out now. Just
  add your website, and I'll be ready in a few minutes." The owner asked for
  "ready in 1 min"; the demo a URL builds estimates about three minutes and
  has not been timed (`apps/web/src/lib/demo/build-progress.ts`), so the
  line says "a few minutes" until a real build is timed. For the same reason
  "Seconds later, I know your treatments" lost its "seconds". "Try Aya free"
  offers the free demo built from the URL; healdesk has no free trial.
- **The opening questions and the closing line are not captioned**, because
  the same words are already on screen.
- **The default hook is the soft one** ("Most callers who hit voicemail never
  call back"), the script's own fallback until the 85% figure has a named
  primary source. `AyaHeroStat` renders the 85% / $1,500 version for the hook
  test, with a placeholder where the source must go.
- The fictional clinic's treatments carry made-up prices (`src/copy.ts`).
  Check that the name Bella Skin Studio and its domain belong to no real
  clinic before publishing.

The script's "Before publishing" list still applies in full; above all,
booking into the calendar and the deposit link in chat must be live in
production before the ad runs.
