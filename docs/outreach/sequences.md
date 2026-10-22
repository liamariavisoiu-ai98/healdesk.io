# Cold sequences: the "preview" sequences (B and C)

The owner's two sequences of 22 October 2026, rewritten so every line is
something v1 does, and wired to the columns `npm run enrich` writes
(`packages/leadgen/src/enrich/outreach.ts`). Text outside `{{…}}` is the
Instantly template. Step 18 of [STEP-BY-STEP.md](./STEP-BY-STEP.md) still
applies to it: nothing outbound, no texting, no "revenue", no unqualified
"HIPAA compliant", no set-up time.

## Before Email 1 goes out

- **Build the preview first.** Email 1 says it exists. Build each clinic's
  personalised demo from `/admin/demos` the day Email 1 sends, and send its
  link only when they say yes. A demo link lasts **7 days**
  (`DEMO_LIFETIME_MS`, `apps/web/src/lib/demo/sessions.ts`), which is why the
  sequence ends on day 7 and Email 4's "it expires" is true.
- **Branch on `booking_mode`.** Only `live` rows may hear "books into your
  calendar". `manual` (Mindbody) and `unverified` rows get the line marked for
  them below.
- **Branch on `channels`.** Mention Instagram or Messenger only where
  `channels` contains `meta`.
- Skip any row with a non-empty `exclude_reason`.

## Merge columns

| Column | What it is | Example |
| --- | --- | --- |
| `hook` | One sentence, about 13 words, built on the clinic's own hours, closed days, sites or booking setup | Fri 5pm to Mon 9am is 64 hours your phone could still be booking Botox appointments. |
| `top_offer` | One sentence that names AYA, the channels this clinic runs and how it gets booked, plus a reason specific to the segment | AYA picks up your calls, website chat and Instagram, day and night, and books them in, even while you're with a patient. |
| `closing_question` | The ask, offering the link for the moment this clinic would test her | Want the link to call her after 5pm on a Friday? |
| `top_service` | The bare service, for subject lines | Botox |
| `website`, `company`, `first_name` | From the list | |

## What was changed from the drafts, and why

| Draft said | Now says | Why |
| --- | --- | --- |
| "secures booking deposits via Stripe" | "can send a deposit link in chat" | Deposits go through the clinic's own payment gateway, and only in web chat and Meta. Voice books and flags the deposit for staff. |
| "pushing bookings directly into {{booking_platform}}" | "books into your Google Calendar" (`live` rows only) | v1 writes only to Google Calendar. It never writes into Mindbody, Boulevard or any other system. |
| "naturally suggests thoughtful add-ons" | "can suggest an add-on if you switch that on" | Add-on suggestions are a portal switch that ships off. |
| "Mind if I text or email the link" | "Mind if I send the link" | The copy gate refuses texting in outreach. |
| "trained on your brand voice" | "trained on {{website}}" | The demo is built from the clinic's public site, its services and its prices. |
| "stays strictly within medical guardrails" | "never gives medical advice and only quotes your prices" | These are the two guardrails the product enforces in code. |
| "clearing out our staging servers" | "your preview link expires tomorrow" | It really does expire, 7 days after it is built. A made-up server clean-out is a claim the reader cannot check, and it is not true. |

---

## Strategy B: "Custom Brand Build" (aesthetics, med spas, injectables)

**Email 1 (day 1).** Subject: `your new front desk for {{company}}`

> Hi {{first_name}},
>
> I spent a few minutes on {{website}} and set up a private preview of AYA for {{company}}. {{hook}}
>
> On one page you can call her live and chat with her as your website visitors would. She's trained on your site and needs nothing set up on your end.
>
> {{closing_question}}

**Email 2 (day 3).** Subject: `Re: your new front desk for {{company}}`

> Hi {{first_name}},
>
> Quick addition. {{top_offer}}
>
> Should I send the link so you can see how it feels?

**Email 3 (day 5).** Subject: `30-second test link`

> Hi {{first_name}},
>
> I know new software is the last thing a busy clinic wants, so AYA reads your site for you. She never gives medical advice and only quotes your prices.
>
> Mind if I send the test link so you can try her on your phone?

**Email 4 (day 7).** Subject: `your preview expires tomorrow`

> Hi {{first_name}},
>
> The voice and chat preview I built for {{company}} expires tomorrow, and I didn't want it to go before you'd had a look.
>
> Want the link for a quick 30-second call first?

## Strategy C: "Interactive Preview"

**Email 1 (day 1).** Subject: `voice & chat preview for {{company}}`

> Hi {{first_name}},
>
> We put together a live preview of AYA for {{company}}, trained on {{website}} and your {{top_service}} menu. {{hook}}
>
> Call her on the left, chat with her on the right.
>
> {{closing_question}}

**Email 2 (day 3).** Subject: `Re: voice & chat preview for {{company}}`

> Hi {{first_name}},
>
> Quick thought. {{top_offer}}
>
> Should I send the preview link so you can test her?

**Email 3 (day 5).** Subject: `30-second test for {{company}}`

> Hi {{first_name}},
>
> Medical teams hate long software setups. AYA works from your existing site, never gives medical advice and only quotes your prices.
>
> Mind if I send the 30-second test link?

**Email 4 (day 7).** Subject: `your preview expires tomorrow`

> Hi {{first_name}},
>
> Your {{company}} preview expires tomorrow, in case you still wanted to see it.
>
> Shall I let it go, or would you like a quick test run first?

### Strategy C, Email 1, for `manual` and `unverified` rows

`top_offer` already carries the right clause for these rows ("alerts your desk
to confirm in Mindbody", "booking if your system reads Google or alerting your
desk"). Leave the template as it is and do not add any line about writing into
their booking system.
