# Cold sequence: the preview sequence

The owner's preview strategy (22 October 2026). It has one goal: getting a
clinic to reply "yes" so we can send them its AYA preview. After a yes:

1. The link goes out within two minutes. It opens AYA's voice on the left
   (call her, or have her call you) and AYA's chat on the right, dressed as
   the clinic's website, Instagram, Messenger or WhatsApp.
2. The preview's 48-hour setup offer starts when the preview is ready, which
   is the same moment. The offer is not mentioned before that: it is the
   surprise for a qualified buyer.
3. The owner phones on the spot or an hour later.
4. Two emails go out, at 24 and 40 hours, plus one last call.

Text outside `{{…}}` is the Instantly template; the merged columns come from
`npm run enrich` (`packages/leadgen/src/enrich/outreach.ts`). Step 18 of
[STEP-BY-STEP.md](./STEP-BY-STEP.md) applies to the template text, and every
spintax variant below passes the same copy guard as the merged columns.

The unreadable-site list (`unreadable.csv`) does not get this sequence. The
preview is built from the clinic's site, and theirs would not load.

## Who gets it

| Campaign | Rows | Why |
| --- | --- | --- |
| **Main** | no `exclude_reason`; `gap_hours` or `closed_days` set; owner, founder or director title; highest `score` first | Their hook is a measured fact, and they decide |
| **Second** | no `exclude_reason`, nothing measured (the hook is about the booking page) | A weaker hook. Send later and judge it on its own reply rate |

## The four touches

Plain text, **no links, no images**, open and click tracking off. Touches 2 to
4 reply in the same thread with the subject left blank. Each touch ends with
the footer from [footers.md](./footers.md).

**Spintax:** Instantly's `{{RANDOM | a | b | c}}`. Every fixed sentence has two
or three variants, so no two clinics get the same body. Merge tags stay
**outside** the `RANDOM` blocks: send a test from two mailboxes before the
first batch to check both render.

### Touch 1, day 1

Subject: `{{subject_line}}` (e.g. "Weekend calls at Glow Aesthetics")

```
{{greeting}} {{first_name|there}},

{{hook}}

{{RANDOM | So I built | So I put together | So I set up}} a private preview of AYA, our AI assistant, trained on {{site_host}} and dressed in your branding. {{RANDOM | One link: call her, then chat with her as she'd appear on | It's one link. Call her, then chat with her as she'd look on | One link lets you call her, then chat with her as she'd appear on}} {{chat_surface}}.

{{closing_question}} {{RANDOM | Reply "yes" and you'll have it in two minutes. | A "yes" gets it to you in two minutes. | Just reply "yes" and it's yours in two minutes.}}
```

### Touch 2, day 3

```
{{greeting}} {{first_name|there}},

{{scenario}} {{RANDOM | So your team starts the day with every inquiry handled, not a stack of voicemails. | So you can stay with the person in front of you while she handles it. | So the morning starts with inquiries handled, not voicemails to return.}}

{{RANDOM | In website chat she can also send your deposit link. | On your website chat she can send your deposit link too. | She can also send your deposit link in website chat.}} {{RANDOM | That's what your preview does, with your own services. | Your preview does exactly that, with your own services. | That's your preview, running on your own services.}} {{RANDOM | Want it? | Should I send it? | Want me to send it over?}}
```

### Touch 3, day 6

```
{{greeting}} {{first_name|there}},

{{RANDOM | Two quick things before you try her. | Two things worth knowing before you try her. | Before you try her, two quick things.}} She never gives medical advice and only quotes the prices you set. And we sign a business associate agreement and handle {{client_term}}' data under it.

{{RANDOM | Don't take my word for how natural she sounds. Call her yourself. | The best test is to call her and hear how natural she sounds. | Call her yourself and judge how natural she sounds.}}

{{RANDOM | If someone else at | If another person at | In case someone else at}} {{company_short}} {{RANDOM | looks after the phones, who should I send the preview to? | handles the phones, who's best to send the preview to?}}
```

### Touch 4, day 10

```
{{greeting}} {{first_name|there}},

{{RANDOM | I'm tidying up previews this week. | I'm clearing out old previews this week. | I'm closing out this week's previews.}} {{RANDOM | Should I archive the one for | Want me to archive the one for}} {{company_short}}, {{RANDOM | or send it over first? | or would you like it first?}}
```

## The reply to a "yes" (within two minutes)

Sent by hand, from the same mailbox, in the same thread. This is the only email
with a link.

```
{{RANDOM | Here you go | Here it is | All yours}}: <preview link>

{{RANDOM | Talk to her as if you were a new client looking to book. | Try her the way one of your new clients would, and ask to book. | Pretend you're a new client and try to book with her.}} {{RANDOM | Call her first, then try the chat. | Give her a call, then try the chat. | Start with a call, then open the chat.}} {{RANDOM | It works best on your phone. | Your phone is the best place to try it.}}

{{RANDOM | What's the best number to reach you if you have questions? | If questions come up, what's the best number for you?}}
```

The last line gets the owner's own number for the call an hour later. The
number on the list is usually the front desk's.

## What it claims, and how far each claim goes

| Claim | Where | How far it goes |
| --- | --- | --- |
| Booking | `scenario`, `top_offer` | Only `live` rows hear that AYA books into their calendar; the rest hear that the desk confirms. Direct booking is still `building` in `LAUNCH_PROMISES` (`apps/web/src/lib/admin/seo/launch.ts`) and blocks go-live, so a clinic that buys cannot go live until it is on. |
| Deposit link | Touch 2 | Website chat only, through the clinic's own payment gateway. Never on a call: voice books and flags the deposit for staff. Also `building` and blocking go-live. |
| Saves the desk's time | Touch 2 | Inquiries handled, which is true in every booking mode, rather than "bookings", which is not. |
| Sounds natural | Touch 3 | "Call her and judge for yourself." Never "the most human-like AI": a superlative we cannot prove is a claim the FTC can ask us to back up, and she opens every call by saying she is an AI assistant. |
| Branding | Touch 1 | The preview page dresses the chat in the color read from the clinic's site, and its logo when the site has one, so the copy says "your branding", not "your logo". |

## Merge columns

| Column | Example |
| --- | --- |
| `subject_line` | Weekend calls at Glow Aesthetics · Sunday calls · After-5pm calls at Revive · 3 phones at Smile Dental · AYA for Glow |
| `hook` | You close at 5pm, right when most people get off work and call about IV therapy. |
| `chat_surface` | your Instagram · your WhatsApp · your Facebook page · your website |
| `closing_question` | Want the link to message her like a new client would? · call her like a new patient would? · try booking with her like a new client would? · test her like a new client at any of your three locations? |
| `scenario` | Picture someone messaging your Instagram on a Saturday night about lip filler. AYA answers, takes the time they want and passes it to your desk to confirm. |
| `company_short` | Glow Aesthetics (from "Glow Aesthetics, LLC") |
| `site_host` | glowaesthetics.com |
| `client_term` | clients (med spa, laser, body contouring, IV, massage, vets) or patients |
| `greeting` | Hi or Hey for clients, Hi or Hello for patients, fixed per address so a thread keeps one |

The scene and the offer follow `booking_mode`. Only `live` rows hear "books it
straight into your calendar". Mindbody rows hear "passes it to your desk to
confirm in Mindbody", and every other booking system hears "passes it to your
desk to confirm". The template itself makes no booking claim, so it needs no
branch.

## Why it is built this way

- **Conversion.**
  - The subject and the first line are about the clinic's own week.
  - Touch 1 shows what the preview is before they ask for it.
  - Saying yes costs one word, and "two minutes" says nothing is being set
    in motion.
  - Touch 2 is a scene, not a feature list.
  - Touch 3 answers the two objections a medical team has, and turns an
    info@ or front-desk address into a referral.
  - Touch 4 is your loss-aversion close, with no date to check.
- **Deliverability.**
  - No links or images before a yes, and no tracking.
  - Follow-ups threaded, never a fake "Re:".
  - Spintax on every fixed sentence, plus five merged columns, so bodies do
    not cluster.
  - The days are spaced 1, 3, 6 and 10.
  - The CAN-SPAM footer on every touch.
- **Mobile.**
  - Subjects of 40 characters or fewer, with the company dropped before the fact.
  - The hook is the preview line.
  - Paragraphs of one or two lines, and no "left and right" (the preview
    stacks on a phone).
- **Fit with the clinics.** US English, clients or patients by segment, no
  "LLC" in the subject or greeting, and no "your new front desk" to a
  receptionist.
- **Truth.**
  - Deposits are never said to go through Stripe, and nothing is said to
    write into the clinic's booking platform.
  - Add-ons are not promised, and nothing is texted.
  - The 50% is not mentioned before the preview.
