# E2E production run sheet: one test clinic, buy to booked

Lane E2E, 29 October 2026. The owner's walk of the same journey that
`apps/app/tests/e2e-journey.test.ts` runs locally, on his own test clinic, in the real
console, portal, Stripe, Google and (optionally) Meta. Each phase is one page: what you do,
what to look at in `/admin`, what you should see, and what blocks it.

Only synthetic details go in: your own test clinic, your own email and Google account, a
made-up patient name ("Sam Test") and a 555-01xx number. Never type a real patient's
details, and never type into a real clinic's chat.

> **Read first: what the local test found.** On `main` today **no clinic can go live**.
> Gate B in code (`apps/app/src/lib/compliance/gate-b.ts`) is fail-closed and three of its
> items are unbuilt: the practice questions cannot yet ask the booking and deposit cases,
> the routed/answered counter does not exist, and the L17, L18 and L21 emails have no
> template. So Phase 5 ends with website chat **held** and an ops alert `go_live_held`
> (`gate_b_not_built`). Phases 6 to 10 cannot run in production until that is built and
> deployed. The local test gets past it only by standing in for that commit.

## What the local test stubs, so what this walk proves that it cannot

| Vendor | Local test | Only this walk proves |
| --- | --- | --- |
| Stripe | Sealed records and a hand-built `invoice.paid` relayed to `/api/provision` and `/api/billing/events`; a fake SDK that refuses any call | Hosted Checkout, the 4242 card, Stripe's signature, its real payload, the webhook endpoint and its secret |
| SES | The real SesTransport and AWS SDK against an SES stand-in; the delivery event applied directly | SES, the SNS subscription, TLS to your mail server, the email arriving |
| Resend | A recording transport | The welcome email, sign-in links, L7 and L12 arriving |
| Model (Anthropic) | Scripted replies; a recorded pass of the practice questions, and the script approval it gives | Claude's real answers and a real practice-questions run |
| Gate B in code | Mocked built from Phase 5 on (it is not built on `main`) | Nothing until it is built: see the box above |
| Google Calendar | In-memory fake for OAuth, free/busy and insert | Google's consent screen, the real calendar, the event appearing |
| WebAuthn | A software authenticator against the real verifiers | Face ID or Touch ID in a real browser |
| Retell, Meta | Not exercised | Everything on voice and Meta |
| Slack | Not exercised | Ops alerts reaching Slack |

## Before you start

**Your pending actions, and which phases they block**

| Pending action | Blocks | Without it |
| --- | --- | --- |
| Gate B built and deployed (Claude Code work, not yours) | 5 (going live) and everything after | Website chat stays held |
| `billing-notices` job on (`/admin/system/jobs`) | 6, 7, 9 | L12 (urgent) and L7 (booking request) are queued, never sent; the urgent reply leaves out "I've told the team" |
| `RESEND_API_KEY` on the host | 2, 6, 7, 9 | No welcome email, no sign-in link by email (only the `/welcome` hand-off in the paying browser works), no L7 or L12 |
| Stripe Connect client id (`stripe_connect_client_id`) and its webhook secret | 4's deposits screen, if you answer Yes | Answer **No** to deposits; the gateway step cannot connect |
| Stripe webhook endpoint and signing secret | 1, 2 | Payment succeeds and no account is ever made (Stripe retries for three days) |
| Slack app and its five parameters | 5, 6, 9 (ops visibility only) | Read ops alerts in `/admin/inbox` instead |
| `HEALDESK_DIRECT_BOOKING_ENABLED` released, applied and deployed (DB-1) | 10 | Every booking is a request (Phase 7), which is the shipped state |

> **Spending warnings.** Use Stripe **test mode** (a Preview deployment of apps/web
> pointed at a host holding Stripe test keys). A **live-mode** purchase charges your card
> the real setup fee (non-refundable) and starts monthly billing the day AYA first answers
> (Phase 6 starts it). Each AYA chat reply is a paid Anthropic API call (cents). Starting
> the host from standby costs about $70 to $99 a month while it runs. Retell and Meta are
> not used here.

**Before Phase 1:** host `active` (`/admin/host`); `/admin/compliance` shows every vendor
attestation recorded (the answer gate and go-live read them); a test page on a site you
control where you can paste the chat snippet; a Google Workspace calendar you own with
nothing real on the next three days.

---

## Phase 1: buy (Stripe test mode)

1. Open the pricing page on the Preview deployment, choose **Voice + Web Chat**, monthly.
2. Answer the agreement questions for your test clinic (a covered med spa; bookings in
   Google Calendar; Workspace account under Google's BAA), sign, press Pay.
3. On Stripe's page pay with `4242 4242 4242 4242`, any future date, any CVC.

**Look in /admin:** `/admin/crm` (the conversion); `/admin/agreements` (your signature).
Before the first invoice reaches the host, `/admin/clinics` has **no** new clinic.

**Expect:** Stripe redirects to apps/web's `/welcome`, which waits ("setting up your
account") until the invoice arrives. A completed Checkout Session alone makes nothing.

## Phase 2: first paid invoice, provisioning, sign-in

1. Wait on `/welcome` (normally under 90 seconds).
2. It hands you to `app.healdesk.io/welcome`, then a one-time sign-in link, then
   `/c/<slug>/protect`.

**Look in /admin:** `/admin/clinics` shows the clinic; its Billing tab shows the
subscription active, the setup fee paid and **no plan start yet** (billing starts at the
first answer). Stripe test dashboard: the `invoice.paid` event delivered with 200 to
`/api/webhooks/stripe`.

**Expect:** the welcome email (B1) in your inbox, with the receipt link (needs Resend).
Reloading `/welcome` now says to use your email: the link is spent once. If nothing
happens after ten minutes, `/admin/inbox` shows `paid order with no account` (ops-watch).

## Phase 3: passkey

1. On `/protect`, add this device (Face ID or Touch ID), name it "Owner test Mac".
2. Offered the authenticator-app backup at the end of setup: add it.

**Look in /admin:** the clinic's Account tab lists one device. Your inbox gets "A device
was added to your healdesk sign-in".

**Expect:** you land on Setup. Transcripts and bookings stay closed until a passkey is
live on the session.

---

## Phase 4: the wizard's four steps

1. **Your practice:** confirm name, address, a 555 phone, website, time zone; hours (open
   every day 08:00 to 20:00 for the test); two services, for example Consultation $0 for
   30 minutes and Facial $100 for 60 minutes; one most-asked question.
2. **How AYA works:** tone; coverage "Overflow and after hours"; a direct line that is not
   the main number; deposits **No** (unless Stripe Connect is done); an urgent-help number.
3. **Calendar:** press the Google button, consent with your test Workspace account; then
   "any available time" for providers.
4. **Your channels:** read where each stands. Voice stays waiting on forwarding (not part
   of this walk).

**Look in /admin:** the clinic's Setup tab: every screen ticked, the calendar connected,
the booking card's ticks. `/admin/system/changes` lists each change as the wizard's.

**Expect:** each screen saves as you leave it; closing the browser and using the
welcome email's link resumes on the first unanswered screen.

## Phase 5: website chat goes live

1. Paste the snippet from Setup into your test page; load the page once.
2. In `/admin/clinics/<id>/setup`, Channels card, press **The line is on their website**.
3. Let the practice questions run (two minutes after the last change; needs the
   `practice-questions` job on and the Anthropic key set). Their pass is what approves the
   script; there is no approve button (retired 19 October 2026).

**Look in /admin:** the Setup tab's Channels card (what website chat still needs);
`/admin/inbox` and Home for `go_live_held`.

**Expect today:** website chat **held**, `go_live_held` with `gate_b_not_built`. Stop
here until Gate B is built and deployed. **Expect once it is:** the channel live, the
channel-live email queued to the clinic address (`channel_live`), the clinic shown as
live.

---

## Phase 6: an urgent message (needs Phase 5 live, `billing-notices` on, Resend)

> This is a scripted test sentence, not an emergency. Use it only on your own test clinic.

1. On your test page open the chat. Check the first line says it is an AI assistant.
2. Type: "My lips are swelling after the filler and it's hard to breathe".
3. When asked, leave "Sam Test, 212 555 0192".

**Look in /admin:** `/admin/clinics/<id>/deliveries`: the urgent alert (L12) sent; the
transcript queued then delivered. Billing tab: the plan start recorded (the first answer).

**Expect:** the fixed urgent reply (call 911) at once, no model wording, and "I've told
the team"; an L12 email to the clinic address naming nobody; the chat ends once the
number is given and its transcript arrives by email (subject names nobody).

## Phase 7: a booking request (direct booking off, the shipped state)

1. New chat: "Kit Test, 212 555 0193, Thursday afternoon for a consultation". Say thanks.

**Look in /admin:** the clinic's Bookings in the portal shows one request; Deliveries
shows L7 queued, then sent within a minute.

**Expect:** the reply says the team will confirm; the L7 email is a pointer into Bookings
with no name, number, time or service.

## Phase 8: the transcript, delivered and deleted

**Look in /admin:** Deliveries (`transcriptDeliveries`): each transcript `delivered`, with
times and attempts only. `/admin/system` › undelivered transcripts: empty.

**Expect:** the email in your inbox; on our side the sealed copy is gone and the row stays
as a receipt without words. A copy SES never confirms is deleted at 72 hours (unconfirmed)
or 30 days (expired), and ops is told.

## Phase 9: the alert queue

**Look in /admin:** `/admin/inbox` (ops alerts, with `go_live_held` from Phase 5 if it
fired), `/admin/queues` (machine queues), the clinic's Deliveries (every clinic email and
its state). With Slack set up, the same alerts in Slack, ids and counts only.

**Expect:** nothing anywhere names Sam, Kit, a number or a symptom.

---

## Phase 10: direct booking, DB-1 (only after the switch is released, applied and deployed)

> Writes a real event into your test Google Calendar. No money moves.

1. `/admin/clinics/<id>/setup` booking card: all three ticks (switch, addendum released,
   version matches) and the location's mode "direct".
2. Chat: "Can I book a facial?", pick a time offered, give "Kit Test, 212 555 0193".

**Look in /admin:** Setup › calendar writes: one write, `written`.

**Expect:** times offered from your calendar; the details asked before anything is held;
then "You're booked" in the tool's words; one event in Google; the time blocked for anyone
else meanwhile (held 60 seconds before the confirmation). Pressing send twice, or a
refresh, books nothing more.

## Phase 11 (optional): Meta

Blocked until Meta App Review, the WhatsApp Tech Provider step and the login configuration
id. When open: connect Instagram or Messenger from the portal, send "hi" from a personal
test account, check the AI line, check a clinical question is moved to a call. Nothing
clinical is stored.

---

## Clean up the test clinic

1. **Stripe (test mode):** cancel the subscription **immediately**. Its
   `customer.subscription.deleted` starts offboarding by itself (`/admin/clinics/<id>/care`
   › Offboarding shows "Service ended" and the dates). In live mode this is where you would
   refund the first period if wanted; the setup fee is never refunded.
2. **Google:** disconnect the calendar in the portal's Settings (revokes the grant) and
   delete any test events it wrote.
3. **Your site:** remove the snippet from the test page.
4. **Patient data:** the `offboarding-destroy` job removes the test clinic's conversations,
   requests and bookings on its agreement's schedule (day 29 with an export delivered, day
   89 without); nothing to do by hand. Delete the transcript and alert emails from your own
   inbox.
5. **Keep:** the signed agreement and billing records (the law requires them), and the
   marketing Sheet rows, which are legal records: no hand edits, sorting or deletions.
6. If the host was started only for this, put it back in standby from `/admin/host` once
   the cancellation event has landed.
