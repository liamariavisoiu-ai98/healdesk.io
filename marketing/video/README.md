# The Aya ad, built in Remotion

A 39.5-second ad for Aya, built to the owner's Apple-style storyboard of
1 November 2026 in [Remotion](https://www.remotion.dev) (React rendered to
video), in three formats from one timeline, cut to its own original track.

| Composition | Size | File |
| --- | --- | --- |
| `AyaHero` | 1080 × 1920 (9:16: Reels, Shorts, TikTok) | `out/aya-hero-9x16.mp4` |
| `AyaFeed` | 1080 × 1350 (4:5: the feeds) | `out/aya-feed-4x5.mp4` |
| `AyaWide` | 1920 × 1080 (16:9: YouTube, the site) | `out/aya-wide-16x9.mp4` |

It sits outside the npm workspaces on purpose: Remotion and its Chromium
renderer never enter the apps' installs, builds or CI. It handles no patient
data and talks to no service. `SCRIPT.md` is the first brief, kept for the
record; the storyboard replaced it, and this file describes the ad as built.

## Running it

```sh
cd marketing/video
npm ci
npm run studio          # preview and scrub in the browser
npm run soundtrack      # rebuild and master public/soundtrack.wav (needs ffmpeg)
npm run render          # the soundtrack, then the three MP4s into out/
npm run typecheck
```

Remotion downloads its own headless Chrome unless `REMOTION_BROWSER` names
one; in the cloud container it is
`/opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`.

## The cut

Nine shots, cut on the beat of a 122 BPM track. `src/timeline.mjs` is the one
timeline: it counts every shot after the drop in beats and computes each
frame from the drop, so no cut drifts more than half a frame (16 ms) off its
beat, and it holds the cue points inside each shot. The shots animate on
those cues and `scripts/soundtrack.mjs` puts its sounds on them.

| Time | Shot | Picture | Type |
| --- | --- | --- | --- |
| 0:00–0:09 | `Missed` | A real-looking iPhone on black, ringing on frame 0; the call goes unanswered; a "Front desk closed" Focus; a missed call on each beat, the Phone badge counting; "calls?" rolls to "DMs?" and the messages pour in on eighths, then sixteenths, each app's badge counting; the camera flies into the screen | Is your clinic missing calls? / DMs? |
| 0:09–0:10.5 | `Interrupt` | The drop: a hard cut to white, the line already rising | Not on my watch. |
| 0:10.5–0:13.9 | `Meet` | Aya, cut out of her own footage, smiling, then pointing at the text; the camera pushes in on her, the text stays still | Hi, I'm Aya. · Your clinic's 24/7 assistant. · by healdesk · Built for medspas · We sign a BAA |
| 0:13.9–0:18.8 | `Website` | On Apple's light grey: the address types itself on the beat, is sent and read (skeleton rows), and what she learned settles in one card | Just add your website. · Aya learned Bella Skin Studio |
| 0:18.8–0:21.8 | `Channels` | On black: the five channels land on eighths on a glass floor | Calls, DMs, chats. All at once. |
| 0:21.8–0:28.2 | `Value` | From $0, five greyed channels light up one per two beats; each price rises into the number, which rolls to $1,648 | Booked value · N bookings at your own prices |
| 0:28.2–0:31.6 | `Pay` | One deposit page, through Stripe; pressed on the beat, paid on the next; healdesk's alert drops in | Appointment deposit · $100.00 · Deposit received |
| 0:31.6–0:34.6 | `Line` | On black, large | You do the treatments. Aya handles the rush. |
| 0:34.6–0:39.5 | `Close` | The wordmark, its line in Fraunces, the button, on white warmed from below; still for the last half second | An AI front desk you can rely on. · Try Aya free |

No frame is a blank: every shot opens with its first line already in motion,
and every line rises out of a mask that hides it completely until it moves
(`Reveal`). The light runs black, white, white, grey, black, white, grey,
black, white, so the middle never sits on one ground for long.

## Where things are

- `src/timeline.mjs`: the shots, their beats and every cue. Plain JavaScript
  so the soundtrack script can import it too.
- `src/copy.ts`: every word the ad prints and all its made-up data (the
  clinic, its prices, the bookings, the messages), with the claims rules at
  the top. Check claims here.
- `src/brand.ts`: the brand system: healdesk's orange-to-red accent, Apple's
  greys, Instrument Sans for every line and Fraunces for the end card's, the
  easing curves.
- `src/layout.tsx`: the stage (1080 × 1500 for the tall cuts, 9:16 sitting
  150 px down to clear the platforms' own header and captions; 1920 × 1080 for
  16:9), and the motion: `Reveal`, `settle`, `Push`.
- `src/components/`: the iPhone; Aya and her measured proportions; app icons,
  notifications, the tick, the wordmark and her avatar.
- `src/shots/`: one file per shot, each counting its frames from 0.
- `src/Ad.tsx`: the shots in sequence, and the soundtrack.
- `scripts/soundtrack.mjs`: the track and every sound effect, synthesised
  (nothing licensed, nothing bought), deterministic. `scripts/master.mjs`:
  loudness and peaks.
- `public/`: Aya's cut-out (`aya-cut.webm`, an alpha channel made with a
  portrait-matting model from her brand clip, and `aya-cut-end.webp`, its
  last frame) and portrait (`aya.webp`, from `apps/web/public/brand`); the
  healdesk app icon and wordmark and the channel icons, from `apps/web/public`.
  `messenger.svg` and `web-chat.svg` (the website chat, healdesk's own
  widget) are drawn here.

## Sound

An original track in the style the owner chose: warm, modern electronic in
the manner of Bicep's "Glue", a clean plucked riff from the first frame over a
subtle house beat at 122 BPM. Am9, Fmaj9, Cmaj9, G6/9 under one barely moving
voicing; every melodic note, the riff's and the effects', is from A minor
pentatonic, so nothing clashes. The intro adds a layer a bar and stops half a
beat before the drop, which lands with an impact and the full groove: four on
the floor, a clap, 808-style hats, an offbeat bass, chord stabs, a wide pad,
side-chained to the kick. The groove stops half a beat before the close,
which resolves to the I chord.

The effects are restrained and on the picture's cues: the phone's buzz, a
pop per message climbing the scale, soft keys as the address types, a glass
note per booking a step higher each time, a two-note confirmation, the alert.

`scripts/master.mjs` sets the mix to -14 LUFS integrated with true peaks at or
below -1 dBTP: one measured gain, and a limiter running at four times the
sample rate for the peaks between samples. It fails if the result is off.

Measured on this build: -14.0 LUFS and -1.1 dBTP; the drop lifts the level
3.6 dB; 4.1 dB is lost through a phone's speaker (energy under 200 Hz) against
6.8 dB before; the left-right correlation is 0.78 (0.998, mono, before); each
effect sits within a few decibels of the music in the band it speaks in.

## Picture

Frames are captured as PNG, so nothing is compressed twice. The MP4s are
H.264 at CRF 16 (x264 `slow`), 4:2:0 in limited range and tagged BT.709, which
is what the platforms expect and what keeps a phone from shifting the colours;
the audio is AAC at 320 kbps, 48 kHz.

## Choices made in building it

- **healdesk's own type, not SF Pro.** Apple's licence does not allow SF Pro
  outside its own platforms, and the brand's faces tie the ad to the site.
- **Booked value reaches $1,648**, five bookings at the clinic's own prices:
  $299, $650, $200, $299, $200. It is "booked value", bookings times the
  clinic's prices, the figure v1 may claim; never "revenue".
- **The deposit page shows no treatment.** It carries the clinic,
  "Appointment deposit", the amount and one button, as CLAUDE.md requires.
- **No treatment is named in a Meta message.** The Instagram, Messenger and
  WhatsApp lines are non-clinical; only the website chat's card names them.
- **healdesk's alert points into the portal.** About a single patient it
  carries an amount, never a time or a treatment. v1 has no mobile app: it
  stands for healdesk's email.
- **"Try Aya free"** offers the free Aya built from a clinic's website.
  healdesk has no free trial: the setup fee is paid at checkout.
- **The website still writes AYA**; the ad writes Aya, on the owner's word.
  Renaming it across the site is its own change (copy, tests, legal pages).
- **No voice and no subtitles.** Every line is on screen as type, at a size a
  phone can read, and the track carries the rest.
- **Aya never freezes.** Her clip is slowed by 5% to fill her shot exactly.
  Her hair runs off the top of the original footage: in 16:9 the frame's own
  edge hides it, and in the tall cuts it dissolves into the white.
- The fictional clinic, Bella Skin Studio, and its prices are made up. Check
  the name and domain belong to no real clinic before publishing.

## Before it runs

Owner-only: check the clinic name is free; and booking into the calendar and
the deposit link in chat must be live in production, since the ad shows both
(`LAUNCH_PROMISES` in `apps/web/src/lib/admin/seo/launch.ts`).
