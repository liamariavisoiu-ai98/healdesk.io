# The Aya ad, built in Remotion

A 44-second ad for Aya, built to the owner's Apple-style storyboard of
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
| 0:00–0:05 | `Missed` | Deep space; one phone scales in; calls stack on its lock screen | Missed calls? | A low drone; the phone's buzz on every call |
| 0:05–0:10 | `Missed` | Instagram, WhatsApp, Messenger and website chat multiply, on the screen and around it | Missed DMs? | The drone rises a tone; quicker buzzes and pops |
| 0:10–0:15 | `Interrupt` | The screen goes dark; a coin falls and lands; a flash to frosted white | Not on my watch. | The coin, then a crisp click and a high chime |
| 0:15–0:25 | `Hello` | The orb floats up and breathes; the website box fills in with bellaskinstudio.com; what Aya learned settles below | Hi, I'm Aya, your 24/7 assistant. · Built for medspas · We sign a BAA | A breathing pad; soft mechanical keys |
| 0:25–0:35 | `Dashboard` | Split screen: conversations stream in from every channel; each booking lands on the week; booked value $0 → $1,648 | Calls, DMs, chats, all at once. | 16th-note micro-clicks; a rising tink per booking |
| 0:35–0:40 | `Deposit` | Stripe's checkout slides down; $100.00 paid; coins; healdesk's notification | You do the treatments. Aya handles the rush. | A two-note confirmation chime |
| 0:40–0:44 | `Close` | The orb on a clean gradient, one text box | Try Aya free. · healdesk.io | One warm chord that lingers |

## Where things are

- `src/copy.ts`: every word the ad prints or says (`LINES`, `VO`), the clinic,
  the five conversations and their prices, the checkout's fields. Check
  claims here.
- `src/tokens.ts`: palette, Inter, the enter, exit and snap curves.
- `src/motion.tsx`: the stage (1080 × 1500 for 9:16 and 4:5, 1920 × 1080 for
  16:9), scene time, the camera (`Shell`) and the motion helpers.
- `src/scenes/`: one file per scene, each counting its own frames from 0.
- `src/parts.tsx`: the glass kit: `Glass`, the colour fields behind it
  (`Backdrop`), stars, the notification banner, the orb that stands for Aya,
  blur-in kinetic type, the minted coin and the coin burst, the subtitles.
- `scripts/soundtrack.mjs`: the drone, the pad, the rhythm and every effect,
  synthesised (no licensed audio), cued to the same timeline, then
  loudness-normalised toward -14 LUFS, -1 dBTP. Deterministic.
- `public/`: the healdesk app icon and wordmark, and the channel and Stripe
  icons, copied from `apps/web/public` (Messenger's is drawn in
  `messenger.svg`).

## Choices made in building it

- **Inter stands in for SF Pro.** Apple's licence does not allow SF Pro
  outside its own platforms; Inter is the closest open face.
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
- **Aya is the orb throughout.** Her face is not in this cut.
- **No subtitles are burned in,** because every line of the voiceover is
  already on screen as type. `VO` in `src/copy.ts` holds the lines and their
  timing for a recording session; a line that is not on screen would be
  subtitled, Netflix-style, by `Captions` in `src/parts.tsx`.
- The fictional clinic, Bella Skin Studio, and its prices are made up. Check
  the name and domain belong to no real clinic before publishing.

The script's "Before publishing" list still applies: booking into the
calendar and the deposit link in chat must be live in production before the
ad runs.
