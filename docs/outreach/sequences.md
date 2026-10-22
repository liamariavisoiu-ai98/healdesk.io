# Cold sequence: the preview sequence

One four-touch sequence for clinics whose site we could read, built from the
owner's drafts B and C of 22 October 2026 and rewritten after an audit for
conversion, deliverability, mobile and fit with the clinics we write to.
Text outside `{{…}}` is the Instantly template; the merged columns come from
`npm run enrich` (`packages/leadgen/src/enrich/outreach.ts`). Step 18 of
[STEP-BY-STEP.md](./STEP-BY-STEP.md) still applies to the template text.

The unreadable-site list (`unreadable.csv`) does not get this sequence: the
preview is built from the clinic's site, and theirs would not load. It keeps
its one touch.

## The sequence

Every touch is plain text with **no links and no images**. The preview link
goes out only in a reply to someone who asked for it. Touches 2 to 4 reply in
the same thread, with the subject left blank so Instantly threads them. End
each touch with the footer from [footers.md](./footers.md): "A cold sales
note" on touch 1, "Still a sales note" after.

**Touch 1, day 1.** Subject, A/B: `preview for {{company_short}}` / `built this for {{company_short}}`

> Hi {{first_name|there}},
>
> {{hook}}
>
> So I set up a private preview of AYA, our AI assistant, trained on {{site_host}}. You can call her and chat with her from your phone, with nothing to set up.
>
> {{closing_question}} A "yes" is enough.

**Touch 2, day 3.** Same thread.

> Hi {{first_name|there}},
>
> {{top_offer}}
>
> The preview runs on what's on {{site_host}}, so you'd hear her talk about your own services.
>
> Want me to send it over?

**Touch 3, day 5.** Same thread.

> Hi {{first_name|there}},
>
> {{RANDOM | Two things worth knowing | Two quick things}} before you try her. She never gives medical advice and only quotes the prices you set. And we sign a business associate agreement and handle {{client_term}}' data under it.
>
> Want the preview link?

**Touch 4, day 7.** Same thread.

> Hi {{first_name|there}},
>
> {{RANDOM | Your {{company_short}} preview expires tomorrow, so this is my last note about it. | The preview I built for {{company_short}} expires tomorrow, and this is the last you'll hear from me about it.}}
>
> Want the link before it goes?

## Running it

- **Build each preview the morning touch 1 sends**, from `/admin/demos`.
  Touch 1 says it exists. A preview lasts 7 days (`DEMO_LIFETIME_MS`,
  `apps/web/src/lib/demo/sessions.ts`), so it expires on day 8 and touch 4's
  "expires tomorrow" is true on day 7. A preview the audit holds is not sent
  until released, so leave that clinic out of the batch until it is.
- **Answer a "yes" within the hour**, with the link and one line. The reply is
  the conversion, and it cools fast.
- **Skip** any row with an `exclude_reason`.
- **Tracking off.** Turn off open tracking (a pixel) and link tracking in
  Instantly. Both are spam signals and neither is needed: the metric is replies.
- Send Tuesday to Thursday, 8 to 11am in the clinic's own time zone (`state`).

## Merge columns

| Column | Example |
| --- | --- |
| `hook` | From Saturday 4pm to Monday 6am, that's 38 hours your phone could still be booking lip filler. |
| `top_offer` | AYA answers your calls and website chat, then books straight into your calendar, since IV clients often want a same-day visit. |
| `closing_question` | Want the link to call her after 4pm on a Saturday? |
| `company_short` | Glow Aesthetics (from "Glow Aesthetics, LLC") |
| `site_host` | glowaesthetics.com (from "https://www.glowaesthetics.com/home") |
| `client_term` | clients for med spas, laser, body contouring, IV, massage and vets; patients for the rest |

The template uses `{{first_name|there}}`, Instantly's fallback, because role
addresses (info@, frontdesk@) have no first name and "Hi ," is the first thing
the reader sees.

## What the audit found, and what changed

### Conversion: getting them to ask for the preview

| Shortcoming | Change |
| --- | --- |
| The email opened on us ("I spent a few minutes on…"), and the clinic-specific fact came second. | The hook is the first line. It states something about their clinic they can check: "You close at 5pm". |
| AYA was never explained. A stranger's email naming "AYA" reads as a person they are meant to know. | Touch 1 says "AYA, our AI assistant" once. |
| All four emails made the same pitch and the same ask. | Each touch has its own job: the fact (1), what she does (2), the two objections (3), the expiry (4). |
| The ask needed composing a reply. | "A 'yes' is enough." Replying takes one word. |
| The closing question and the stock "Mind if I send the link?" were two questions in one email. | The closing question is the ask, and it names the moment this clinic would test her. |
| Compliance and medical-advice worries, the main objections for a medical team, came up only as "medical guardrails". | Touch 3 gives the two things the product actually does, and the approved business-associate-agreement line. |

### Deliverability

| Shortcoming | Change |
| --- | --- |
| "Re:" typed into a fresh subject fakes a reply. Filters and readers both notice, and CAN-SPAM forbids misleading subject lines. | Touches 2 to 4 thread under touch 1, subject blank. |
| Touches 3 and 4 had no merged text, so every recipient got the same body. Filters cluster identical bodies. | `{{RANDOM}}` variants, plus `company_short` and `client_term`. |
| Spam-weighted words: "test link", "Stripe", "deposits", "delete". | Gone from the template. |
| "Mind if I text…" | Gone. The copy gate refuses texting. |
| Nothing said whether links, pixels or images were allowed. | No links, no images, tracking off. The link only goes in a reply. |
| No footer or opt-out was mentioned. | The CAN-SPAM footer from footers.md on every touch. |

### Mobile

| Shortcoming | Change |
| --- | --- |
| A phone's preview line showed "Hi Jenna, I spent a few minutes on…", which tells the reader nothing. | The hook comes right after the greeting, so the preview line shows their own hours. |
| "Call her on the left, chat on the right." On a phone the preview stacks voice above chat (`lg:grid-cols-2`). | "Call her and chat with her from your phone." |
| Subjects like "custom voice & chat preview for Glow Aesthetics & Wellness, LLC" get cut off. | Subjects of three or four words, and `company_short`. |
| The merged sentences ran to three lines on a phone (offers averaged 36 words). | Hooks about 15 words, offers under 30, questions under 12. |
| "https://www.glowaesthetics.com/" in the body. | `site_host`: glowaesthetics.com. |

### Fit with the clinics we write to

| Shortcoming | Change |
| --- | --- |
| British phrasing ("ringing round", "get round to", "Shall I", "had a look") to US clinics. | US English, and a test fails the build on the old words. |
| "Patients" to med spas, which say clients. | `client_term`, and the merged lines use the segment's word. |
| "Your new front desk" lands on a receptionist (role addresses go to whoever staffs the desk) as "you're being replaced", and the email goes nowhere. | Subjects about the preview, not the desk. |
| "Lip filler appointments", "Instagram" as something AYA "picks up". | "Booking lip filler", "Instagram DMs", "Facebook messages". |
| "Glow Aesthetics, LLC" in a greeting reads as a database. | `company_short`. |
| For Mindbody, Boulevard and unknown systems, the line "if your system reads Google" made an owner stop and decode it. | "Passes each booking request to your desk to confirm" (in Mindbody, where it is Mindbody). It is true for all of them, and onboarding can upgrade it. |

### Claims, corrected to what v1 does

| Draft said | Now | Why |
| --- | --- | --- |
| "secures booking deposits via Stripe" | "can send a deposit link in chat" (offer, where it fits) | Deposits go through the clinic's own gateway, in chat only. |
| "pushing bookings directly into {{booking_platform}}" | Google Calendar for `live` rows, the desk for the rest | v1 writes to nothing but Google Calendar. |
| "naturally suggests add-ons" | not claimed | Add-on suggestions are a switch that ships off. |
| "trained on your brand voice" | "trained on {{site_host}}" | The preview is built from the public site. |
| "clearing out our staging servers" | "expires tomorrow" | It does expire, after 7 days. |

## Still open, for the owner

- **The 50% setup discount on an operator-built preview runs 48 hours from the
  moment the preview is ready** (`CLAUDE.md`, "Setup discounts"). Built on day
  1, it has lapsed before most clinics reply. Starting that clock when the
  clinic first opens the link would make the discount land when they are
  looking. That is a pricing decision, not a copy change.
- **No social proof.** There are no live clinics to quote yet, and the
  sequence invents none. Add one line to touch 2 once a real clinic agrees to
  be named.
- **The A/B subject.** Run both for the first 200 sends, then keep the one with
  more replies, not more opens (opens are not tracked).
