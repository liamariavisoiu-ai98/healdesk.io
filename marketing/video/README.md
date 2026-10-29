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
- `src/scenes/S1Hook.tsx` … `S7Dare.tsx`: one file per scene, each counting
  its own frames from 0. The timeline is `SCENES` in `src/copy.ts`;
  `src/Ad.tsx` places the scenes on it.
- `src/parts.tsx`: the glass kit: `Glass`, the drifting colour field behind
  it (`Backdrop`), the notification banner, the orb that stands for AYA,
  blur-in kinetic type, the dollar burst, the captions.
- `scripts/soundtrack.mjs`: the music bed and every effect, synthesised (no
  licensed audio), cued to the same timeline, then loudness-normalised to
  -14 LUFS, -1 dBTP. Deterministic.
- `public/`: AYA's 3-second brand clip (`aya-gesture-720.mp4`, from
  `apps/web/public/brand/aya-final-cta.mp4`) and its last frame, the healdesk
  app icon and wordmark, and the channel and Stripe icons, copied from
  `apps/web/public` (Messenger's is drawn in `messenger.svg`).

## The cut, scene by scene

| # | Frames | What happens |
| --- | --- | --- |
| 1 | 0–150 | A glass lock screen: the call rings out, then missed calls, Instagram, Messenger, WhatsApp and website chat pile up and fly off to "Clinic down the street". |
| 2 | 150–240 | The coin is caught; ivory floods out; AYA arrives as a glowing glass orb. Three badges. |
| 3 | 240–420 | The orb becomes the caret of a URL box; the clinic's brand, prices and chat assemble. |
| 4 | 420–600 | Five glass conversations burst from the orb (phone, WhatsApp, Instagram, Messenger, website chat), each books into the week with its price, the booked value counts to $1,646, and a healdesk notification lands. |
| 5 | 600–720 | In website chat AYA sends the deposit link; the patient pays $100.00 on Stripe's checkout; the money lands; healdesk notifies the clinic. |
| 6 | 720–900 | The night on the owner's lock screen: healdesk notifications at 11:48 PM, 2:15 AM and 7:02 AM. |
| 7 | 900–1080 | AYA's face, the only time it appears; the dare; the end card. |

## Where this build differs from SCRIPT.md

- **AYA is an orb until the end.** Her face appears only in the last scene,
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
- **Every notification AYA sends the clinic carries the healdesk icon.**
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
