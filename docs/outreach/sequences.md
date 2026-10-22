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

## Uploading to Instantly

The spreadsheet keeps every column the enrichment wrote (the scrape, the hours,
the best service, the booking platform) and gains the columns the templates
use. It has two tabs, and each is its own campaign:

| Tab | Who | Campaign |
| --- | --- | --- |
| Main campaign | Contacts whose hook stands on measured hours, closed days or sites, and whose service we found | Sent first, strongest rows at the top |
| Low enrichment | Contacts with no opening hours or no service found, then, in one block at the end, the clinics whose site would not load (`enrichment_note` says which) | Second, judged on its own reply rate |

A second contact (another person at a clinic already in the list) sits in the
same tab as the primary contact at that clinic, because the enrichment belongs
to the clinic. The `list` column says `primary` or `second-contact`, and
`primary_contact` names the other person, so either kind can be held back.
Sending both at once means one clinic has two threads in flight.

**The block at the end of Low enrichment is not for the four-touch sequence.**
Its rows have `list = unreadable`: the site would not load, so there is no
preview, no scene and no chat surface, and touches 1 and 2 would print blanks
and promise a preview that cannot be built. Cut that block off (they are
contiguous, last in the tab) and send it as its own campaign with the single
*Unreadable sites* email below.

`npm run enrich -w @healdesk/leadgen` writes the same two tabs as
`leads-main.csv` and `leads-low-enrichment.csv` next to `all-leads.csv`. A list
enriched before this
copy existed is refreshed without crawling anything, with
`npx tsx src/ops/instantly-from-leads.mts <all-leads.csv> <out-dir>` from
`packages/leadgen`. The outputs hold real contacts: keep them out of Git.

In Instantly:

1. Upload each tab's CSV as its own campaign (and cut the unreadable block off the end of Low enrichment, as above). `email`, `first_name`,
   `last_name`, `company` and `phone` map to Instantly's own fields; every other
   column imports as a custom variable you can use as `{{column_name}}`.
2. Build four steps from the templates below, on days 1, 3, 6 and 10. Only step
   1 has a subject; leave it blank on steps 2 to 4 so they thread.
3. Put the footer from [footers.md](./footers.md) in each mailbox's signature,
   not in the bodies.
4. Send a test to yourself from two mailboxes. Check that `{{...}}` variables
   fill, that `{a|b|c}` picks one choice, and that the paragraph breaks hold.

## Who gets it

| Campaign | Rows | Why |
| --- | --- | --- |
| **Main** | no `exclude_reason`; `gap_hours` or `closed_days` set; owner, founder or director title; highest `score` first | Their hook is a measured fact, and they decide |
| **Second** | no `exclude_reason`, nothing measured (the hook is about the booking page) | A weaker hook. Send later and judge it on its own reply rate |

## The four touches

Plain text, **no links, no images**, open and click tracking off. Each touch
ends with the footer from [footers.md](./footers.md).

**Syntax.** `{{name}}` is a column of the spreadsheet. `{a|b|c}` is Instantly's
spintax and picks one choice per send. Variables never sit inside a choice, and
`greeting_name` is already "there" where no usable first name exists, so no
fallback syntax is needed.

### Touch 1, day 1

Subject: `{{subject_line}}`

```
{{greeting}} {{greeting_name}},

{{hook}}

{So I built|So I put together|So I set up} a private preview of AYA, our AI assistant, trained on {{site_host}} and dressed in your branding. {One link: call her, then chat with her as she'd appear on|It's one link. Call her, then chat with her as she'd look on|One link lets you call her, then chat with her as she'd appear on} {{chat_surface}}.

{{closing_question}} {Reply "yes" and you'll have it in two minutes.|A "yes" gets it to you in two minutes.|Just reply "yes" and it's yours in two minutes.}
```

### Touch 2, day 3

Subject: Blank, so it threads under touch 1.

```
{{greeting}} {{greeting_name}},

{{scenario}} {So your team starts the day with every inquiry handled, not a stack of voicemails.|So you can stay with the person in front of you while she handles it.|So the morning starts with inquiries handled, not voicemails to return.}

{In website chat she can also send your deposit link.|On your website chat she can send your deposit link too.|She can also send your deposit link in website chat.} {That's what your preview does, with your own services.|Your preview does exactly that, with your own services.|That's your preview, running on your own services.} {Want it?|Should I send it?|Want me to send it over?}
```

### Touch 3, day 6

Subject: Blank, so it threads under touch 1.

```
{{greeting}} {{greeting_name}},

{Two quick things before you try her.|Two things worth knowing before you try her.|Before you try her, two quick things.} She never gives medical advice and only quotes the prices you set. And we sign a business associate agreement and handle {{client_term}}' data under it.

{Don't take my word for how natural she sounds. Call her yourself.|The best test is to call her and hear how natural she sounds.|Call her yourself and judge how natural she sounds.}

{If someone else at|If another person at|In case someone else at} {{company_short}} {looks after the phones, who should I send the preview to?|handles the phones, who's best to send the preview to?}
```

### Touch 4, day 10

Subject: Blank, so it threads under touch 1.

```
{{greeting}} {{greeting_name}},

{I'm tidying up previews this week.|I'm clearing out old previews this week.|I'm closing out this week's previews.} {Should I archive the one for|Want me to archive the one for} {{company_short}}, {or send it over first?|or would you like it first?}
```

### Unreadable sites, one email

Subject: `{{subject_line}}`. The rows with `list = unreadable`, at the end of the Low enrichment tab, as their own campaign with this single step.

```
{{greeting}} {{greeting_name}},

{{hook}}

{{top_offer}}

{{closing_question}}
```

## The reply to a "yes" (within two minutes)

Sent by hand, from the same mailbox, in the same thread. This is the only email
with a link.

```
{Here you go|Here it is|All yours}: <preview link>

{Talk to her as if you were a new client looking to book.|Try her the way one of your new clients would, and ask to book.|Pretend you're a new client and try to book with her.} {Call her first, then try the chat.|Give her a call, then try the chat.|Start with a call, then open the chat.} {It works best on your phone.|Your phone is the best place to try it.}

{What's the best number to reach you if you have questions?|If questions come up, what's the best number for you?}
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
| `scenario` | Picture someone messaging your Instagram about lip filler on a Saturday night. AYA answers, takes the time they want and passes it to your desk to confirm. |
| `company_short` | Glow Aesthetics (from "Glow Aesthetics, LLC") |
| `site_host` | glowaesthetics.com |
| `client_term` | clients (med spa, laser, body contouring, IV, massage, vets) or patients |
| `greeting` | Hi or Hey for clients, Hi or Hello for patients, fixed per address so a thread keeps one |
| `greeting_name` | Sophie · Dr. Smith · there (from "Dr. Jacob", "Jill M.", "AJ" or a credential in the last-name field) |
| `top_offer` | AYA answers your calls and website chat, then books straight into your calendar, since IV clients often want a same-day visit. Not used in the four touches; the Unreadable email uses it. |
| `enrichment_note` | Empty on the Main tab. On Low enrichment: no opening hours found, no service found on the site, or both. |
| `primary_contact` | On a second contact: the primary contact at the same clinic. Empty on a primary contact. |

The scene and the offer follow `booking_mode`. Only `live` rows hear "books it
straight into your calendar". Every other row hears "passes it to your desk to
confirm in" and then the clinic's own system by name when we found one
("Boulevard", "Zenoti", "Mindbody"), or "your booking system" when we did not. The template itself makes no booking claim, so it needs no
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
