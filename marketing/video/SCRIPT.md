# AYA — "Meet your AYA" · motion-design ad script

Master cut: **36 seconds**, motion design, built to make a clinic owner click
the link under the video and build their own free AYA from their website URL.

This file is the full production brief: what AYA says, what is on screen,
what moves, how it sounds, and how to build it. It is written so that a motion
designer, or Claude working in code (see "Building it"), can produce the video
from this file alone.

---

## 0. The one idea

> A missed call is a lost booking. AYA catches it, in your branding, from
> nothing but your website URL, and books it with the deposit taken.

Everything in the video serves three beats: **pain** (the call that gets
away), **proof** (AYA built live from a URL, working every channel at once),
**dare** ("Don't believe me? Click below").

---

## 1. Global specification

### Formats

| Deliverable | Aspect | Resolution | Use |
| --- | --- | --- | --- |
| Master | 9:16 | 1080 × 1920 | Reels, TikTok, Stories, Shorts |
| Feed | 4:5 | 1080 × 1350 | Instagram/Facebook feed |
| Wide | 16:9 | 1920 × 1080 | YouTube, website, LinkedIn |

- 30 fps. All timings below are given in seconds and in frames at 30 fps.
- Design the master at 9:16. Keep every critical element (text, AYA's face,
  the URL box, the CTA) inside a **centre safe area of 900 × 1400 px**, so the
  4:5 and 16:9 versions are reframes, not redesigns.
- Keep the bottom 280 px of 9:16 free of key text: platform UI covers it.

### Palette

| Token | Hex | Use |
| --- | --- | --- |
| `ivory` | `#FAF6F0` | Main background once AYA arrives |
| `night` | `#14101A` | Opening background (the dark, unanswered desk) |
| `plum` | `#2A1630` | Primary text, AYA's blazer |
| `plum-soft` | `#4B2E55` | Secondary text, card borders |
| `mist` | `#9A9AA2` | Everything "missed": dead calls, faded callers |
| `coral` | `#FF7A59` | The accent. Appears **only** when AYA solves something: a booking, a deposit, the CTA |
| `gold` | `#C9A45C` | The coin, AYA's earring |
| `glass` | `rgba(255,255,255,0.55)` + 24 px backdrop blur | Every card and bubble |

The rule that makes it feel designed: **coral never appears before AYA
does.** The first 5 seconds are night and mist; colour arrives with her.

### Typography

- Display and captions: **Plus Jakarta Sans** (Google Fonts), ExtraBold 800
  for headlines, SemiBold 600 for captions, Medium 500 for UI text.
- Headlines: 96–120 px in 9:16, tight tracking (-2%), max 3 lines.
- Captions: 52 px, white on a plum pill (`plum` at 85% opacity, 28 px radius),
  sitting at y = 1360 in 9:16.
- Numbers (85%, 82%, $1,500): ExtraBold, tabular figures, count up rather
  than cut in.

### Motion language

- **Enter:** ease `cubic-bezier(0.22, 1, 0.36, 1)`, 12–18 frames, from 24 px
  below plus 0 → 100% opacity, with a slight 0.96 → 1 scale.
- **Snap (the satisfying moments):** spring, damping 12, stiffness 180,
  mass 0.8, so it overshoots about 6% and settles. Use it for every booked
  tile, badge and the coin catch.
- **Exit:** 8–10 frames, ease-in `cubic-bezier(0.64, 0, 0.78, 0)`, fade plus
  a slight scale-down to 0.98.
- **Nothing static for more than 1 second:** idle elements breathe (scale
  1 → 1.01 → 1 over 60 frames) or drift (±4 px).
- **Transitions are match cuts**, never wipes or dissolves: an object in one
  scene becomes the object in the next (the coin becomes the cursor, a chat
  bubble becomes a calendar tile, the calendar becomes the window light).
- Soft shadows: `0 24px 48px rgba(42,22,48,0.12)`. Corners: 28 px for cards,
  full round for pills.
- Parallax depth: background layer moves at 0.3×, mid at 0.6×, foreground at
  1× on every camera move.

### Captions

Burned in, word by word, synced to the voice (each word fades up in 4 frames
as it is spoken, the current word in `coral` for its duration). Most viewers
watch with the sound off: AYA's jokes must land in the captions too.

---

## 2. AYA — character sheet

### Look

- Stylised 2.5D character, not photoreal: warm, expressive, never uncanny.
  Think premium app mascot crossed with an editorial illustration.
- Late twenties, confident posture, chin slightly raised, an easy smile that
  goes lopsided when she is joking.
- Hair: a sleek low bun with one loose strand that moves when she turns.
- Outfit: structured plum blazer (`plum`) over an ivory top, small gold
  earring shaped like a three-bar sound wave (her logo mark, in `gold`).
- Eyes: large, bright, with a highlight; the eyes carry most of the acting.
- Always framed from the waist up, except the entrance.

### Acting vocabulary (use each at least once)

| Move | Where | Notes |
| --- | --- | --- |
| **The catch** (signature) | 0:05 | Catches the coin one-handed without looking. Repeat it in every future ad. |
| Eyebrow raise | 0:19, 0:31 | Single brow, 6 frames up, holds, 8 frames down |
| Finger snap | 0:15 | Triggers the channel burst; a small coral spark at her fingers |
| Counting on fingers | 0:16–0:19 | One finger per channel as each opens |
| Soft, sincere look | 0:24–0:30 | The only moment she is not joking: slower blinks, head tilt 4° |
| Wink | 0:34 | Right eye, 5 frames closed, with a tiny head nod |

### Voice

- Warm, quick, amused, low-mid register. The best receptionist you have ever
  had, who is also the smartest person in the building.
- She speeds up when listing and slows down for the dream outcome.
- Smiling is audible in the jokes ("Obviously.") and absent in the sincere
  beat.
- Pace: about 165 words per minute overall; the dream-outcome lines at about
  140.
- Voice options: a professional voice actor (preferred for the hero cut), or
  the same Retell/ElevenLabs voice that AYA uses on real calls, so the ad
  sounds like the product. If the product voice is used, the 0:20 call
  snippet must be the identical voice.

---

## 3. Sound design

- **Music:** minimal, warm, rhythmic bed at about 100 BPM: soft plucked synth,
  felt piano, light brushed percussion. It **enters at 0:05 with AYA**; the
  hook runs on sound effects alone. It ducks under every VO line by 8 dB, and
  drops to silence for the 12 frames before "Don't believe me?".
- **The tink:** one glassy, bright chime (a struck wine glass, high-passed).
  It is AYA's sound: every booking, the deposit, the coin catch and the end
  card. Pitch it up a semitone each time in a sequence so that a run of
  bookings plays as a rising melody.
- **Hook effects:** a muffled phone ring (twice), a flat voicemail beep, soft
  tape-stop, one low "thunk" per faded caller (quiet, not comic), a door
  closing.
- **UI:** soft keyboard clicks for the URL, a "shimmer" whoosh for the build,
  a paper-soft swoosh for flying tiles.
- Mix: VO at -14 LUFS integrated for social, peaks at -1 dBTP.

---

## 4. The script, scene by scene

Total: 36 s = 1080 frames.

### Scene 1 — "The call that got away" · 0:00–0:05 · frames 0–150

**Purpose:** stop the scroll with a felt loss, then the number.

- **Background:** `night`. A minimal, dark clinic reception desk in 2.5D
  (desk, a small plant, a desk phone), lit only by the phone's screen.
- **0–8 (0:00–0:00.27):** frame 1 is not empty. The giant number **85%**
  slams in at centre (snap spring, overshoot) in `mist`, over the dark desk.
  This is the scroll-stopper; it must read on the very first frame.
- **8–45:** the number slides up to the top third and shrinks to 64 px; the
  phone rings (screen pulses white, two rings, each with a 6 px shake).
- **45–60:** no one answers. The phone screen greys out. A pill pops above
  it: `Missed call · 6:42 PM`. Voicemail beep.
- **60–100:** a row of 20 small caller silhouettes (simple rounded figures,
  `mist`) stands along the bottom. 17 of them fade out left to right, a soft
  thunk each, 2 frames apart. Headline types on, word by word:

  > **85% of callers who reach voicemail hang up without leaving a message.**

- **100–135:** the faded silhouettes slide across to the right edge, toward
  a second, warmly lit door labelled `Clinic down the street`. The counter
  flips to **82%**. Second line:

  > **…and most of them call your competitor next.**

- **135–150:** the door closes with a soft thud. A gold coin rolls out from
  under it, wobbling, toward the centre of the frame. Third line, larger:

  > **That's a $1,500 consult. Gone.**

- **Small print**, bottom-left from frame 60 to 150, 22 px, `mist`:
  *Source: [name the study — see "Before publishing"]*
- **VO (AYA, off screen, wry, from frame 75):**
  > "Busy line? After six? They're not waiting."

### Scene 2 — "Not on my watch" · 0:05–0:09 · frames 150–270

**Purpose:** AYA arrives as the hero, with her signature move, and the three
trust signals.

- **150–160:** the coin is mid-roll at the centre. A hand enters frame and
  **catches it without looking**. Hard stop, *tink*, music in.
- **150–175:** match cut on the catch: the background floods from `night` to
  `ivory` in a circular reveal from the coin (18 frames, ease-out). The desk
  is now bright, morning-lit.
- **160–185:** pull back to reveal AYA, waist up, coin in hand. She flips it
  into her blazer pocket.
- **VO (AYA, to camera, grinning, from frame 170):**
  > "Not on my watch. Hi, I'm AYA — your 24/7 assistant."
- **210–260:** three glass badges float in around her shoulders, staggered
  6 frames, each snapping into place:
  - `Built for medspas & aesthetic clinics`
  - `We sign a BAA`
  - `Never gives medical advice`

### Scene 3 — "Built from your URL" · 0:09–0:15 · frames 270–450

**Purpose:** the proof no competitor can show. The core of the ad.

- **270–285:** AYA steps aside. The coin in her pocket glints; match cut, the
  glint becomes a blinking text cursor inside a single large glass input box
  at centre, placeholder `yourwebsite.com`.
- **285–320:** `bellaskinstudio.com` types in, a soft click per character
  (use a believable, fictional clinic; never a real clinic's name or logo).
  A coral `Build my AYA →` button presses itself, 3 px down and back.
- **320–350:** a coral shimmer sweeps left to right across the box. The box
  dissolves into particles that fly outward and reassemble as:
  - the clinic's logo (fictional, elegant wordmark),
  - its colour swatches (sage green and cream) washing over the frame,
  - three treatment cards dealing in like playing cards: `Botox`,
    `Lip filler`, `HydraFacial`, each with a price.
- **350–420:** a chat window assembles piece by piece in the clinic's sage
  colours: header with the logo, then AYA's first bubble types itself:

  > "Hi! I'm AYA, Bella Skin Studio's AI assistant. Looking for Botox pricing,
  > or would you like to book a consult?"

- **420–450:** a patient bubble: *"How much is lip filler?"* AYA answers with
  the exact price from the treatment card; that card pulses coral once as
  it is used.
- **VO (AYA, from frame 280):**
  > "Give me your website. Seconds later, I know your treatments, I sound
  > like your clinic, and I'm ready for your patients."

### Scene 4 — "Every channel, at once, deposit taken" · 0:15–0:23 · frames 450–690

**Purpose:** volume and competence: AYA as a whole team, with money landing.

- **450–465:** AYA, beside the chat, **snaps her fingers**; a coral spark.
- **465–520:** the chat window splits into a fan of four cards bursting out,
  one per beat, as she counts on her fingers:
  1. **Phone call** — a live waveform in `coral` with a caption of the call:
     *"Hi, I'm AYA, Bella Skin Studio's AI assistant. This call is
     transcribed. How can I help?"* (play 2 seconds of the actual voice, low
     under the VO, if the product voice is used)
  2. **WhatsApp** — *"Can I come Thursday after work?"*
  3. **Instagram DM** — timestamp `11:48 PM` — *"do u have anything
     saturday?"*
  4. **Website chat** — *"First time, what's a consult like?"*
- **520–600:** each conversation resolves in turn, 20 frames apart. The last
  bubble of each lifts off, flies out and becomes a calendar tile that snaps
  into a week view assembling behind them: `Thu 5:30 PM`, `Sat 11:00 AM`,
  `Fri 2:00 PM`, `Mon 10:30 AM`. Four tinks, rising in pitch.
- **600–660:** the deposit moment. The website-chat card comes forward. AYA
  sends a bubble: a payment card with a lock icon,
  `Secure deposit · $100 · Pay now`. A finger-tap ripple; the card flips to
  `Deposit received ✓` in `coral`. Biggest tink of the video. The matching
  calendar tile gets a small coral `Deposit ✓` badge.
- **660–690:** AYA looks at the full week, eyebrow up.
- **VO (AYA, fast, playful, from frame 460):**
  > "Calls, DMs, chats — all at once. I book them straight in, and I send
  > the deposit link right in the chat. *(beat)* Honestly? It's kind of my
  > thing."
- **Caption tag, top right, 0:21–0:23:** small pill `↓ Link below` (the early
  CTA for viewers already sold).

### Scene 5 — "The dream outcome" · 0:23–0:30 · frames 690–900

**Purpose:** the one slow, sincere beat. Make the owner feel the life, not
the feature.

- **Music:** drops to the felt piano alone.
- **690–720:** match cut: the full week view softens and widens into the
  warm window light of the same reception desk, now at golden hour. The
  camera drifts back slowly (parallax).
- **720–780:** the desk is calm and empty. The phone sits quietly by the
  plant. A small stack of `Booked ✓` tiles settles beside it, one gentle tink.
- **780–840:** an owner's hand (no face; a gold ring, a clinic-white sleeve)
  switches off the desk lamp. The room goes to dusk blue.
- **840–900:** in the dark, the owner's phone on the desk lights up once with
  a notification card: **`AYA · 3 new bookings overnight · deposits in`**.
- **VO (AYA, slower, warm, sincere, from frame 700):**
  > "Now you close at six and still wake up to new bookings, deposits
  > already in. Your team stops chasing the phone. And you get your evenings
  > back."
- **Headline, appearing with "evenings back", 900 ms hold:**

  > **You do the treatments. AYA handles the rush.**

### Scene 6 — "The dare" · 0:30–0:36 · frames 900–1080

**Purpose:** convert. A dare, not a pitch.

- **900–912:** silence (music cut). Hard snap: close-up on AYA, `ivory`
  background, eyebrow raised.
- **VO (AYA, playful again, from frame 912):**
  > "Don't believe me? Click below, grab your free trial, and see for
  > yourself."
- **960–1020:** AYA gestures down. A coral arrow below her pulses three times
  toward the bottom edge (where the platform's link button sits), with the
  pill `Build your free AYA from your URL ↓`.
- **1020–1040:** AYA, softly:
  > "I'll be here. *(wink)* Obviously."
- **1040–1080 — end card:** AYA's sound-wave mark in `gold` draws itself on,
  tink, then:

  > **Click below. Meet your AYA.**
  > healdesk.io

  Hold still for the final 15 frames (the one static moment, so the URL
  reads).

### Full VO, for the voice session (≈ 100 words)

```
[0:02] Busy line? After six? They're not waiting.
[0:05] Not on my watch. Hi, I'm AYA — your 24/7 assistant.
[0:09] Give me your website. Seconds later, I know your treatments, I sound
       like your clinic, and I'm ready for your patients.
[0:15] Calls, DMs, chats — all at once. I book them straight in, and I send
       the deposit link right in the chat. (beat) Honestly? It's kind of my thing.
[0:23] (slower) Now you close at six and still wake up to new bookings,
       deposits already in. Your team stops chasing the phone. And you get
       your evenings back.
[0:30] (playful) Don't believe me? Click below, grab your free trial, and see
       for yourself. I'll be here. (wink) Obviously.
```

Record three takes of each line: straight, warmer, more playful. Record the
final "Obviously." five ways; it is the line people will remember.

---

## 5. Cutdowns and variants

Build every scene as its own block so that each variant is a re-edit.

| Cut | Length | Structure |
| --- | --- | --- |
| Hero | 36 s | Scenes 1–6 |
| Short | 15 s | Scene 1 (trimmed to 3 s: 85% + coin) → Scene 2 catch only (2 s) → Scene 3 (6 s) → Scene 6 (4 s) |
| Mid | 25 s | Scenes 1–4, a 3 s Scene 5 (notification only), Scene 6 |

**Hook tests** (swap only the first 3–4 seconds, keep the rest identical):

- A. 85% stat first (as written).
- B. Felt moment first: the phone ringing out, no number until 0:03.
- C. "Your receptionist can take one call at a time." Four phones ring at
  once, and one desk is lit.
- D. Cold open on AYA catching the coin, then the stat.

**Specialty variants** (swap the URL, the logo and the three treatment
cards): medspa (as written), hair restoration (`PRP`, `FUE consult`,
`Scalp analysis`), aesthetic dentistry (`Whitening`, `Veneers consult`,
`Invisalign consult`).

**What to measure:** hook rate (3-second views ÷ impressions), CTR on the
link, and, the real conversion, **cost per URL submitted** on the landing
page.

**The landing page must continue the video:** same palette, AYA visible, the
URL box above the fold, the button reading `Build my free AYA`. The link
under the video goes straight to that box, never the general homepage.

---

## 6. Building it

### Recommended: Remotion (React video, code Claude can write)

- `npx create-video@latest`, TypeScript, blank template.
- One `<Composition id="AyaHero" durationInFrames={1080} fps={30}
  width={1080} height={1920} />`, plus `AyaFeed` (1080 × 1350) and
  `AyaWide` (1920 × 1080) sharing the same scenes with a `format` prop.
- One component per scene, placed with `<Sequence from={…}
  durationInFrames={…}>` using the frame ranges above:
  `S1Hook` 0–150, `S2Arrival` 150–270, `S3UrlBuild` 270–450,
  `S4Channels` 450–690, `S5Dream` 690–900, `S6Dare` 900–1080.
- Motion: `spring({ frame, fps, config: { damping: 12, stiffness: 180,
  mass: 0.8 } })` for snaps; `interpolate` with `Easing.bezier(0.22, 1, 0.36,
  1)` for enters.
- Design tokens (palette, type sizes, shadow, radii) in one `tokens.ts`.
- Captions from a `vo.json` of word timings (export them from the recorded
  VO with Whisper word timestamps), rendered by one `<Captions />` component.
- AYA: illustrated layered artwork (SVG or PNG layers: body, head, eyes, brows,
  mouth shapes, hands), animated by layer. Mouth shapes driven by the VO's
  phoneme timing (Rhubarb Lip Sync output). Alternatively, render AYA in a
  dedicated character tool (Rive, Spline, or a 3D render) and composite her as
  transparent video (`<OffthreadVideo>` with ProRes 4444 or WebM alpha).
- Audio: `<Audio>` layers for music, VO and each SFX at the frames above.
- Render: `npx remotion render AyaHero out/aya-hero-9x16.mp4 --codec h264
  --crf 18`.

### Alternative: After Effects

The same scene breakdown, frame ranges, palette and easing values apply.
Use the spring values as an overshoot expression; keep each scene as a
precomp so variants are re-edits.

### Asset list

- AYA character rig (layers, 6 mouth shapes, brows, two hand poses: catch,
  snap; point down).
- Desk scene (night and day lighting states), plant, desk phone, lamp.
- Caller silhouette, competitor door, gold coin.
- Glass card, chat bubble, payment card, calendar tile and week grid, badge,
  notification card components.
- Fictional clinic: `Bella Skin Studio` wordmark, sage/cream palette.
- Channel icons (phone, WhatsApp, Instagram, website chat), used within each
  platform's brand guidelines.
- Music bed, tink, ring, beep, thunk, door, keyboard, shimmer, swoosh.

---

## 7. Before publishing

These are what keep the ad from being pulled or from promising something the
product does not do.

1. **Source both statistics.** Find the primary study behind "85% of callers
   who reach voicemail hang up without leaving a message" and "82% call a
   competitor next", and name it in the Scene 1 small print. If no primary
   source holds up, change the line to "Most callers who hit voicemail never
   call back" and drop the numbers.
2. **Check the features are switched on in production.** Booking straight
   into the calendar and the deposit link in chat are on the launch tracker
   (`/admin/compliance#launch`). The ad shows both; run it only once they
   work for a live clinic.
3. **Deposits are shown in chat on purpose.** On a phone call AYA books and
   flags the deposit for staff; the payment link is sent in web chat and the
   Meta channels, through the clinic's own payment gateway. Never show a card
   number being read out, and never an SMS: healdesk does not text patients.
4. **AYA says she is an AI in her opening line, on every channel.** The
   on-screen chat and call snippets in Scenes 3 and 4 show it; keep them that
   way.
5. **"Free trial" means the free AYA built from the visitor's URL.** The
   landing page has to deliver exactly that, with no card asked for. No
   discount is mentioned in the video.
6. **No unqualified "HIPAA compliant"** anywhere, in the video, captions or ad
   text: "We sign a BAA" is the line.
7. **No real clinic's name, logo, or a real patient's words** in any frame.
8. **Social proof only once it is real.** When live clinics have numbers,
   replace the Scene 5 notification with a real one ("Clinics using AYA
   booked X appointments after hours last month").
