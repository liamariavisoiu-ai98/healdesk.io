# The Aya ad, built in Remotion

A 39.5-second ad for Aya, built to the owner's Apple-style storyboard of
1 November 2026 in [Remotion](https://www.remotion.dev) (React rendered to
video), in three formats from one timeline. `SCRIPT.md` is the original
brief; where the storyboard and the brief differ, the storyboard wins.

| Composition | Size | File |
| --- | --- | --- |
| `AyaHero` | 1080 × 1920 (9:16) | `out/aya-hero-9x16.mp4` |
| `AyaFeed` | 1080 × 1350 (4:5) | `out/aya-feed-4x5.mp4` |
| `AyaWide` | 1920 × 1080 (16:9) | `out/aya-wide-16x9.mp4` |

It sits outside the npm workspaces on purpose: Remotion and its Chromium
renderer never enter the apps' installs, builds or CI. It handles no patient
data and talks to no service.

## Running it

```sh
cd marketing/video
npm ci
npm run studio          # preview and scrub in the browser
npm run soundtrack      # rebuild public/soundtrack.wav (needs ffmpeg)
npm run render          # soundtrack, then the three MP4s into out/
```

Remotion downloads its own headless Chrome unless `REMOTION_BROWSER` names
one; in the cloud container it is
`/opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`.

## The cut

Frames and speeds come from `src/timeline.json`, which the scenes, the
subtitles and the soundtrack all read; change a scene's length or speed there.
A scene's `speed` below 1 slows its whole animation (`<Speed>` and `useFrame`
in `src/motion.tsx`) without retiming a cue.

| Time | Scene | Picture | Type | Sound |
| --- | --- | --- | --- | --- |
| 0:00–0:04 | `Missed` | A realistic iPhone, ringing on frame 0 with iOS's full-screen incoming call; it goes unanswered; a "Front desk closed" Focus on the lock screen; the missed calls group into one stack whose count climbs | Is your clinic missing calls? | The song, muffled; the phone's buzz |
| 0:04–0:09 | `Missed` | "calls?" rolls to "DMs?"; Instagram, WhatsApp, Messenger and website-chat icons pop up around the phone with red badges counting; DMs pour onto the lock screen faster and faster; the camera flies into the screen | Is your clinic missing DMs? | The filter opens, a riser and a clap build, a half-beat of silence |
| 0:09–0:10.5 | `Interrupt` | A white flash; the line lands hard and is gone in a second and a half | Not on my watch. | The drop: the full song, a hit, a crisp click and a chime |
| 0:10.4–0:19.8 | `Hello` | Aya herself, in her real footage: she smiles and points to her name; cut on the beat to the website box alone, typing bellaskinstudio.com, and what she learned | Hi, I'm Aya. · Your clinic's 24/7 assistant. · Built for medspas · We sign a BAA · Just add your website. | Soft mechanical keys, a chime |
| 0:19.8–0:29.1 | `Dashboard` | "Calls, DMs, chats. All at once." over the five channel icons; cut on the beat to the booked value alone, each channel flying into it with its price, $0 → $1,648 | Booked value · 5 appointments booked by Aya, at your own prices | A whoosh and a rising tink per booking |
| 0:29.1–0:34.8 | `Deposit` | One card: $100.00 appointment deposit, one button, paid through Stripe; healdesk's notification; cut on the beat to the line | You do the treatments. Aya handles the rush. | A two-note confirmation chime |
| 0:34.8–0:39.5 | `Close` | healdesk's lockup: Aya, still moving, points to the wordmark, its line in Fraunces, "Try Aya free" and the address | An AI front desk you can rely on. · Try Aya free · healdesk.io | One warm chord that lingers |

Every cut after the drop falls on a beat of the song: each scene in
`timeline.json` starts a whole number of beats after the drop, and each
scene's inner cut is a whole number of beats into it.

## The brand system

- **One accent:** healdesk's orange-to-red, as the logo runs (`accent` in
  `src/tokens.ts`), on pure white and near-black with Apple-like greys. The
  old plum, coral, sage and ivory now resolve to it.
- **healdesk's faces:** Instrument Sans everywhere, Fraunces only for the end
  card's line, as on the website.
- **Aya is the real person** from healdesk's site, in her own footage
  (`src/aya.tsx`); her name is written Aya in the ad.
- **Calm motion:** springs settle without overshoot; lines rise into place;
  shots change on hard cuts on the beat.
- **The healdesk wordmark closes the ad**, with the site's line.

## Where things are

- `src/copy.ts`: every word the ad prints or says (`LINES`, `VO`), the clinic,
  the five conversations and their prices, the checkout's fields. Check
  claims here.
- `src/tokens.ts`: the brand system: one accent, greys, Instrument Sans and Fraunces, the curves.
- `src/motion.tsx`: the stage (1080 × 1500 for 9:16 and 4:5, 1920 × 1080 for
  16:9), scene time, the camera (`Shell`) and the motion helpers.
- `src/scenes/`: one file per scene, each counting its own frames from 0.
- `src/aya.tsx`: Aya's footage set into the white, and her round avatar.
- `src/parts.tsx`: the glass kit: `Glass`, the colour fields behind it
  (`Backdrop`), stars, the notification banner, the orb (no longer in the cut),
  blur-in kinetic type, the minted coin and the coin burst, the subtitles.
- `scripts/soundtrack.mjs`: the song and every effect, synthesised (no
  licensed audio), cued to the same timeline, then loudness-normalised to
  -14 LUFS, -1 dBTP. Deterministic. The song is punchy pop-house in D major at 128 BPM
  (I–V–vi–IV), the kind Apple's product films ride on: four-on-the-floor
  kick, stomp-claps, offbeat house piano, an offbeat bass, a vowel-chop hook
  and a pad, side-chained to the kick, with a hit on every cut. It plays
  muffled behind a filter for the first nine seconds, stops for half a beat,
  and drops in full on "Not on my watch."; `bpm` in `timeline.json` sets it.
- `src/iphone.tsx`: the iPhone (titanium band, side buttons, Dynamic Island,
  status bar, lit wallpaper, glare).
- `public/`: Aya's footage and portrait (`aya-clip.mp4`, `aya-clip-end.webp`,
  `aya.webp`, from `apps/web/public/brand`), the healdesk app icon and
  wordmark, and the channel and Stripe icons, copied from `apps/web/public`
  (Messenger's is drawn in `messenger.svg`).

## Choices made in building it

- **healdesk's own type, not SF Pro.** Apple's licence does not allow SF Pro
  outside its own platforms, and the brand's faces tie the ad to the site.
- **Booked value reaches $1,648** because the made-up HydraFacial price is
  $200: Botox $299 twice, lip filler $650, HydraFacial $200 twice. It is
  "booked value", bookings times the clinic's own prices, the figure v1 may
  claim; never "revenue".
- **The deposit page shows no treatment.** Stripe's checkout carries only the
  clinic, "Appointment deposit", the amount and a reference, as CLAUDE.md
  requires. The card is Stripe's well-known test number, masked.
- **No treatment is named in a Meta message.** The Instagram, Messenger and
  WhatsApp lines are non-clinical; only website chat names one.
- **healdesk's notifications point into the portal.** About a single patient
  they carry an amount and a channel, never a time or a treatment, as the
  spec's alerts must. v1 has no mobile app: these stand for healdesk's emails.
- **"Try Aya free"** offers the free Aya built from a clinic's website.
  healdesk has no free trial: the setup fee is paid at checkout.
- **The website still writes AYA**; the ad writes Aya, on the owner's word. Renaming it across the site is its own change (copy, tests, legal pages).
- **No subtitles are burned in,** because every line of the voiceover is
  already on screen as type. `VO` in `src/copy.ts` holds the lines and their
  timing for a recording session; a line that is not on screen would be
  subtitled, Netflix-style, by `Captions` in `src/parts.tsx`.
- The fictional clinic, Bella Skin Studio, and its prices are made up. Check
  the name and domain belong to no real clinic before publishing.

The script's "Before publishing" list still applies: booking into the
calendar and the deposit link in chat must be live in production before the
ad runs.
