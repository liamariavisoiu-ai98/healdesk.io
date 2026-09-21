# Handover

Where the build stands, what is blocked, and what to do next.

Everything that could be built without an external account or a lawyer has
been. What remains is genuinely waiting on something.

## Which document, when

**Follow this one.** It is the only list that is kept current. Everything else is
reference you open when this file sends you to it.

| Document | What it is | When you open it |
|---|---|---|
| **handover.md** (this file) | The live list: what's blocked, what's left, what's deliberately undone | **Always start here.** If it isn't in this file, it isn't on the list |
| [blockers-runbook.md](./blockers-runbook.md) | Click-by-click instructions and the verbatim text to send each vendor | When this file says "ask X" or "set up Y" and you're about to do it |
| [research-conclusions.md](./research-conclusions.md) | Plain-English: what the rules are, why, and what they cost commercially | When you want to understand or challenge *why* something is on the list |
| [state-of-play.md](./state-of-play.md) | A dated audit (2 Sep 2026) — BAA against 45 CFR 164.504(e)(2)(ii), codebase pass, niche argument | Before touching the BAA or the recovery classification. **Not a task list** — its Part 5 is partly done, and its open findings are in § 3 below |

Rule of thumb: **one list, four references.** If you find yourself tracking two
lists, one of them is stale — fold it in here and delete it.

> **A browsable version of all of this:** `npm run docs` serves every document at
> <http://localhost:4321> with a landing page of 94 tasks — grouped into the seven
> phases that get you from here to a running business, each with a plain-English
> explanation and steps. It is generated from these files and fails to build if it
> drifts from them, so it stays a view rather than becoming a list of its own.

---

## 1. Blocked on you — accounts and decisions

These gate real work. Roughly in the order they unblock the most.

### ⚠️ Synthflow: is HIPAA available below Enterprise?

**DECIDED: Synthflow is the voice vendor.** The seven questions below are still
worth asking when convenient but no longer block the build. Numbers are
Synthflow-issued and clinics forward to them — see the telephony section below.

**The single most consequential open question on cost.** Ask them, verbatim:

> *"Is the HIPAA Setting available on pay-as-you-go, and will you sign a BAA at
> that tier? If not, what is the lowest-cost plan that includes both?"*

Everything I can find says HIPAA is Enterprise-only — that pay-as-you-go covers
SOC 2 and GDPR but not HIPAA. Their own docs don't state tier eligibility either
way, so treat it as a strong indication, not a fact.

It decides the unit economics, not just the compliance posture:

| If HIPAA is… | Fixed cost/mo | Break-even |
|---|---|---|
| on pay-as-you-go | ~$145 (AWS only) | **~2 clinics** |
| Enterprise-only | ~$2,645 | **~24 clinics** |

At ten clinics on Enterprise, Synthflow alone costs $250 per clinic — a third
of the $797 voice-only package before a minute is served. If the answer is Enterprise-only, the honest
options are: raise prices well above the market cluster, delay HIPAA-covered
clinics until scale, or reconsider the vendor.

While you're on the call, get these in writing too:

- Does the BAA name **Twilio** as a subprocessor? Their BAA doesn't mention it.
- Does §14.4 (their no-training clause) get pulled **into the BAA**? It currently
  lives only in the Subscriber Terms, which are separately amendable.
- Their docs say 30-day retention; the AI Transparency Statement says 90. Which?
- Their privacy policy says sensitive data is stored *"exclusively on servers
  hosted in the EU"*, contradicting the US-cluster docs. Which?
- Can we disable transcript **storage** and still receive structured post-call
  data by webhook? If yes, materially better CIPA posture.
- **Does the post-call webhook carry the carrier disposition from *before* the
  call reached them** — clinic line rang out, or was engaged? This one gates a
  shipped feature rather than a cost: `lib/voice/ingest.ts` needs it to classify
  a call as recovered. There is no Twilio account to fall back on now that the
  numbers are Synthflow-issued, so if they can't supply it the fallback is the
  weaker inference from the clinic's opening hours and the forward timing, and
  the report says so. Full wording and the reason are question 7 in the runbook.
  Ask before anyone writes the ingest route.

**Then, before creating anything:** the workspace region choice is **permanent**
and defaults to **EU**. Create a **US** workspace or you rebuild.

### AWS account + BAA

Free, click-through, five minutes, and it covers RDS, KMS, SES, S3 and Fargate
in one agreement — every other vendor gives you a BAA for the database only.

Do it now even though no infrastructure is needed yet. Development runs on local
Docker Postgres; provision RDS when the first clinic signs (~$25/mo at
`db.t4g.small`).

*Note: App Runner is not HIPAA-eligible. Use ECS on Fargate.*

### Telephony — decided: Synthflow-issued numbers, clinics forward their existing number

**No Bandwidth account and no Twilio account.** The earlier plan — own the DIDs
in a carrier account under our own BAA and bring them into the voice vendor —
is closed. The research behind it stays in `docs/launch-plan.md` for the day it
is worth revisiting; the decision does not.

How it works: each clinic receives a number issued inside Synthflow, and sets
**conditional call forwarding** — busy, no answer, after hours — from its
existing carrier line to that number. The clinic's published number never
changes and the forward is reversible in one dial code, which is the
objection-killer in the sales conversation.

Consequences, all accepted:

1. **The number lives with the voice vendor.** A vendor switch is a
   re-forwarding exercise per clinic (a new number, a new star code), not a
   config change. Accepted for the size of the book we have.
2. **SMS from that number still needs A2P 10DLC registration.** Carrier
   registration is per brand and campaign whoever issues the number, so the
   text-back and reminder paths wait on it exactly as before.
3. **The call-forwarding handshake page must show the number and the
   carrier-specific star codes.** Conditional-forward codes differ by carrier
   and by PBX, so the page branches on the clinic's phone system and shows the
   right one, then proves the forward with a test call before the clinic is
   marked live.

### Anthropic BAA — and keep it off the marketing org

**DONE: the marketing key is already from a separate, non-PHI organisation.**
What follows is kept as reference for when the PHI organisation is created.

Via Sales. Note web search is excluded from BAA coverage — it must be disabled on
any endpoint touching patient data. Don't chase zero data retention alongside the
BAA: HIPAA-ready API access is designed as an *alternative* to ZDR, and asking
for both adds negotiation and costs features.

**The HIPAA setting is organization-wide, and enabling it is a one-way door.**
So patient traffic needs its **own Anthropic organization** — not just its own
key. A service account or an unlinked key inside the same org changes who owns
the key, not which compliance regime applies to it; enable HIPAA readiness there
and it applies to the marketing demo's key too, permanently, hard-blocking
features that demo may want.

`ANTHROPIC_API_KEY` in `apps/web/.env.local` is the **marketing** key and belongs
to the non-PHI org. Prefer a **service account** for it — a user-linked key dies
when that user is deactivated, where a service account survives personnel
changes, gets its own line in usage logs, and is revocable on its own.

### Stripe account — built, three steps from working

Checkout, the webhook, and idempotent provisioning are implemented. A test-mode
secret key and a local webhook signing secret are already in
`apps/web/.env.local`. What is left:

1. **Create the products, prices and meters.** `npm run stripe:setup -w
   @healdesk/web` (add `--dry-run` to see the plan with no key and no calls).
   The catalog now has **five packages**, each with a monthly, an annual and a
   one-time setup price — 15 package prices plus 2 metered overage prices, 17
   price objects — and **two Billing Meters** (voice minutes, chat
   conversations). The account has none of them yet, so `createCheckout` throws
   a "run the setup script" error on the first attempt. Run it against the test
   key, then the live key — it is idempotent by `lookup_key`, never edits a
   price, and reports drift between Stripe and `packages/catalog/src/plans.ts`.
2. **Production webhook endpoint.** Dashboard → Developers → Webhooks, pointing
   at `/api/webhooks/stripe`, subscribed to the full lifecycle set:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `charge.dispute.created`, and `checkout.session.expired` (no provisioning;
   it marks the lead as an abandoned checkout so the one follow-up email can
   go). Not `customer.subscription.paused` /
   `.resumed`: those fire only when a trial ends without a card, and there is
   no trial; a Dashboard or portal pause arrives as
   `customer.subscription.updated` with `pause_collection` set, which the app
   reads. Its signing secret is a **different value** from the local one —
   per-endpoint, not per-account.
3. **Dashboard settings the script cannot set.** Customer Portal configuration
   (card update, plan change, cancel at period end), Stripe Tax on, Settings →
   Billing → Emails → "send emails about failed payments" **on** (the terms
   say we email the billing contact when a renewal fails, and this is what
   sends it), and under Subscriptions → "on payment failure" choose **do not
   cancel** — the app
   owns suspension: the `billing-sweep` job moves a clinic to `suspended` once
   its 7-day grace window closes, and a subscription Stripe gives up on
   (`status: unpaid`) is suspended on the update event. **That job ships
   switched off** like every job; enable it from the ops console the same day
   you set "do not cancel", because with the job off a clinic whose card fails
   keeps full service for as long as Stripe keeps retrying.
   Suspension is a status in our database, not a switch on the phone line:
   when a clinic goes `suspended`, switch its Synthflow agent off by hand and
   send the remove-forwarding instructions the terms (§2, §6) promise. The
   `offboarding` work in the task list automates both.
4. **Collect upgrade setup-fee deltas by hand.** The portal's plan change swaps
   the recurring price only. A clinic moving from the $497-setup package to a
   $997-setup one owes the $500 difference (`setupFeeDeltaUsd` in the catalog)
   and nothing invoices it yet — `entitlements.setup_fee_paid_usd` records
   what was paid, so the ops console can show what is owed.
5. **Send the annual renewal reminder.** The terms promise an email at least
   30 days before an annual plan renews. Nothing sends it yet; see the
   `annual-renewal-reminder` task. Until it exists, turn on Stripe's own
   "upcoming renewal" email under Settings → Billing → Subscriptions and
   emails, which covers the legal minimum in our absence.

Two things about that flow worth not rediscovering:

**Provisioning fires on `checkout.session.completed`, never on the success URL.**
A customer who closes the tab after paying still gets their account; someone who
hand-crafts a success URL gets nothing. `/get-started/done` reads nothing and
verifies nothing on purpose.

**Stripe retries every non-2xx for up to three days.** There is no "4xx stops
retries" rule for webhooks — that rule belongs to custom actions, a different
product surface. So a missing signing secret returns **500** deliberately: the
events queue up and replay once it is set. A *wrong* secret is worse than a
missing one, because it passes the config gate and lands on the 400
"invalid signature" path meant for forgeries, silently failing every real sale.
Never put a placeholder in `STRIPE_WEBHOOK_SECRET`.

### Boulevard + GoHighLevel developer accounts

Only these two need them, and only for the OAuth flows. The other five platforms
already have working wizards.

Boulevard: build against API version **2026-06** (OAuth2 app install), not the
legacy 2020-01. Sandbox provisioning is manual — ask early.

### Cyber / tech E&O insurance — declined

Decided 21 September 2026 by the owner, against this file's recommendation
and with the consequences stated: healdesk carries no liability insurance.
Clinics whose procurement requires a certificate of insurance will be lost,
and any claim, defence cost or breach-notification cost is paid from the
company's own cash. What that decision can and cannot do is written up in the
"Decisions log" below, item 10; the short version is that the contracts now
limit liability to the legal minimum, and nothing further is available on
paper. Do not re-raise this unless the owner does.

---

## 2. Blocked on counsel

| Item | Why it matters |
|---|---|
| **Ad-platform attribution — removed, keep it that way** | Sending person-level conversion data to Meta/Google is the GoodRx fact pattern — $1.5M there, $7.8M at BetterHelp. `ad_interactions` and the `conversations` join to it were **dropped in `drizzle/0017`**; this is no longer deferred, it is out of scope. Reintroducing a click-id column needs counsel first. Note `src/lib/attribution/` is a different thing wearing a confusing name: it reconciles the clinic's own POS money event and reports it back to them, and nothing leaves for a third party |
| **Covered-entity determination** | Cash-pay med spas often aren't covered entities, which removes five defences at once including Washington MHMDA's — and that has a private right of action. Needs a method and a different posture for non-covered clinics |
| **CIPA positioning** | Party-extension or independent third party? Contracts, architecture and marketing copy must all say the same thing |
| **Click-through BAA — approved and enforced, not open** | The mechanism is production-ready — versioned, hashed, append-only acceptance — and the text is no longer a placeholder: `packages/catalog/src/baa.ts` `BAA_TEMPLATES[0]` is version 1.0.0, published 2026-09-05, `approvedByCounsel: true`, and `apps/app/src/lib/provisioning.ts` refuses to provision a clinic against any template that isn't (`currentBaaTemplate().approvedByCounsel`). Listed here so nobody re-opens it. What still needs counsel is the **other five rows** of this table |
| **Reactivation = HIPAA marketing?** — moot | Inbound-only since 21 September 2026 (decisions log, item 11): the product sends nothing, so no authorisation question arises. Reopens only if outbound is switched back on |
| **Missed-call callback consent** — moot | Same decision: no callbacks are placed, and `ingestCall()` refuses a call the vendor flags as outbound |

---

## 3. Engineering left

Ordered by what unblocks the most.

### Voice — Synthflow, the webhook is built

- **The post-call webhook exists.** `POST /api/webhooks/voice/[clinicId]`
  (`apps/app/src/app/api/webhooks/voice/[clinicId]/route.ts`) takes a fixed
  Bearer secret (`HEALDESK_VOICE_WEBHOOK_SECRET`), stores the raw body inside
  the tenant, maps it through `lib/voice/synthflow-payload.ts` and lets
  `ingestCall()` decide recovery, booking and the contact's timezone. A replay
  of the same call id is a duplicate, not a second conversation. The field
  names are **provisional** until Synthflow confirms them (question 7 in
  `docs/synthflow-voice-agent-context.md`); the fixture in
  `apps/app/tests/voice-webhook.test.ts` is the contract, and the reader
  accepts the aliases their docs show today. Point the agent's webhook at the
  route with the `Authorization: Bearer …` header and watch `webhook_events`.
- **Disclosure injection**, non-defeatable by clinic configuration. If a clinic
  can switch it off, a clinic will, and you become a co-defendant. The webhook
  records `disclosure_played_at` from the payload; the agent script has to
  play it.
- **Wire `canContact()` into the outbound path.** It exists and is tested, and
  it now fails closed on an unknown timezone (a contact's timezone is set from
  the clinic's at ingest). Nothing calls it yet because nothing places calls
  yet.

### Once AWS lands

- **SES sending.** `SesTransport` throws with instructions. Needs a verified
  domain, DKIM, and a configuration set with `TlsPolicy: Require` — opportunistic
  TLS is a hope, not a safeguard. Wire bounces and complaints to suppression.
- **A2P 10DLC registration per clinic.** Each clinic is its own Brand under its
  own EIN, 1–4 weeks for campaign approval. Since **30 June 2026** registration
  requires a live Privacy Policy URL and Terms URL, so every clinic needs both
  before you can submit. **Never put real PHI in campaign sample messages** —
  humans at the registry read them.
- **Turn the monthly report job on**, from the ops console, once there are real
  tenants. It ships off.

### Once Boulevard / GoHighLevel accounts exist

- The two OAuth wizards, alongside the five that already work.
- **Confirm Boulevard's write-back mutations before relying on them.**
  `createSchemaField`, `updateAppointment` and `createClientNote` are in their
  introspection schema but **not their published docs**. Undocumented surface
  changes without notice.

### Unblocked, just not done

- **Real connection verification.** `verify.ts` currently validates the shape of
  what was pasted and reports capabilities from the catalogue. The per-platform
  HTTP calls need real credentials against real tenants.
- **Real adapters.** `packages/connectors/` has the port, the guards, the rate
  budgets and a fixture that behaves like an awkward real platform. Only the
  fixture is registered, on purpose: registering an unimplemented adapter would
  let the sync engine pick it up and fail at runtime instead of at connect time.
  Adding one is a single line in `registry.ts` plus the adapter — the engine,
  the matcher and the reports need no changes.
- **Write-back (Channel B).** Deferred deliberately. Research is done —
  GoodHighLevel and Boulevard are the best targets, PatientNow needs
  `customeruserdefined` not `customernote` because it's a real EMR, and Vagaro
  has no write-back path at all.
- **Embedded scheduler for no-system clinics — DECIDED: Cal.com.** Its
  booking-write API and `BOOKING_PAID` webhook are confirmed, which is what the
  provisioned-booking path needs; PracticeQ's programmatic booking never was.
  Build the provisioned-booking path against Cal.com.
- **`stripe:setup` has never been run against a live-mode key.** Only test mode
  is exercised. The script is idempotent and prints drift, but the live run is
  still a first run.
- **The assent label is client-supplied and never checked.** `validateSignRequest`
  (`apps/app/src/lib/agreements.ts:178`) only tests that it is non-empty and under
  200 chars, then freezes whatever arrived into the acceptance row as "what the
  button said". The whole reason that column exists is that enforceability turns
  on the wording of the assent action — so the one field that must not be
  caller-controlled currently is. Compare it to `BAA_ASSENT_LABEL` and reject a
  mismatch. **Verified still true, 3 Sep.**
- **Done: `approvedByCounsel` now gates provisioning.** It used to be
  report-only; `apps/app/src/lib/provisioning.ts` now refuses to provision a
  clinic against an unapproved template, and the current template is approved.
- **Database-layer findings from the 2 Sep audit, untouched.** `0019`'s backfill
  silently affects zero rows; the BAA gate sits on state the gated role can write;
  `baa_acceptances` has no RLS. See `docs/state-of-play.md` → Database-layer
  findings for the reasoning. *Not re-verified since 2 Sep.*
- **Two `sync.test.ts` tests fail in the first days of a month.** Not a code
  bug — a fixture one. The generator spreads walk-in sales *evenly* across the
  90-day sync window (`packages/connectors/src/fixture/generator.ts`), and the
  tests then reconcile "this month". On the 2nd of a month that sub-window holds
  no walk-in, so `unmatchedUsd` is 0 and the orphan-sale assertions fail. The
  comment there claims even spacing "makes the property hold for any sub-window";
  that is true only for sub-windows wider than the gap between walk-ins. Fix by
  anchoring the fixture to the period under test rather than to `new Date()`, or
  by emitting at least one walk-in per calendar month in the span. It goes green
  on its own mid-month, which is what makes it worth fixing rather than watching.

---

## 4. Known gaps, deliberately

Things left undone on purpose, so nobody "fixes" them by accident.

- **"Recovered" is a reason, and `null` means we claim nothing.**
  `conversations.recovery_reason` records *why* a contact would have been lost —
  `after_hours`, `line_busy`, `rang_unanswered`, `missed_call_callback` — and the
  report counts anything non-null. This replaced a single
  `is_recovered_missed_call` boolean that counted only the last of the four, so a
  9pm call the agent answered live scored zero. Null still means the clinic would
  have handled it anyway, and stays the default: the guard against overstating
  now sits at ingestion, where the facts are.
- **Revenue is `null`, never `0`, when unknown.** `$0 recovered` reads as "we
  earned you nothing" — a different and false claim from "we can't work it out".
- **The monthly email is aggregate-only, permanently.** A test enforces it. Per
  appointment detail belongs inside the clinic's own software.
- **Meta channels can never carry PHI.** Meta states in its own Cloud API terms
  that it is not a Business Associate. No tier changes that. The agent there
  shares public information and moves the person to phone or SMS.
- **Google Business Messages was discontinued in July 2024** with no successor.
  Point the Maps *Call* button at the voice agent instead.
- **No Mindbody API, ever**, unless counsel says otherwise. Their terms bar
  caching beyond 48 hours, aggregating with third-party data, and competing
  products — all three of which describe the product.
- **A "medium" confidence match is computed but not written back.** The matcher
  reports it; `persistMatches()` only writes `exact` and `high` onto the
  transaction row. A wrong link is worse than a missing one — the missing shows
  up as a caveat the clinic can check, the wrong one silently misattributes.
- **Unknown arrival maps to `scheduled`, never `no_show`.** "The platform can't
  tell us" and "they didn't turn up" are different facts, and collapsing them
  deflates attendance for every clinic on a platform without check-in.
- **Job payloads carry ids only.** pg-boss owns its own schema, which has no
  `clinic_id` and no RLS, so anything in a payload sits outside every control in
  the codebase. `assertNoPhiInPayload()` enforces an allowlist — not a
  pattern-match, because `patientName` would sail past one.
- **The webhook URL contains a clinic id and that is not a secret.**
  Authentication is the payload signature, checked in the adapter against that
  clinic's own credential. Guessing an id buys you a row with
  `signature_valid = false` and nothing else. A per-connection URL token would
  still be better; add it when the first real webhook integration lands and you
  know what that platform allows in a callback URL.

---

## 5. Running it

```bash
npm install
npm run db:up -w @healdesk/app     # Postgres in Docker, both roles, migrated
# export the four URLs it prints
npm run dev:web                    # marketing + checkout  → :3000
npm run dev:app                    # ops console           → :3001
npm run worker -w @healdesk/app    # REQUIRED: the hourly tick, the queues, every job
npm test -w @healdesk/app          # ~600 tests, needs TEST_APP_URL/TEST_MIGRATOR_URL
npm test -w @healdesk/connectors   # 15, no database needed
```

`db:reset` rebuilds from scratch. `db:down` removes the container.

### The background worker

```bash
npm run queue:install -w @healdesk/app   # ONCE per environment, as the migrator
npm run worker        -w @healdesk/app
```

`queue:install` is separate because pg-boss creates a schema, and CREATE is a
privilege the runtime role deliberately does not have — it is the same privilege
that would let application code drop `contacts`. The installer runs as the
migrator, then grants the runtime role ordinary CRUD on the `pgboss` schema and
nothing more. Re-running is safe.

The worker is a plain Node entry point, not a Next route, so it runs as an ECS
task or a Fly machine with nothing Vercel-shaped in the way.

**It is not optional.** Since Phase 6 the worker owns the clock: pg-boss
schedules one `tick-hourly` job and `runTick()` in
`apps/app/src/lib/scheduler/tick.ts` runs, every hour, the billing sweep, the
monthly report send, the weekly recap and the connection watchdog, and at fixed
UTC hours the nightly sync (02), the retention purge (03), the offboarding
destruction (04) and the annual renewal reminder (09). Every job still ships
switched off and is enabled from the ops console; the `heartbeat` row is the
liveness signal and `/api/health` reports its age. If the worker is not
running, nothing scheduled happens and the console's job list says "Never".
`docs/on-call.md` is the one-page runbook. `/admin/ops` also carries the
first-weeks list (Phase 8 below).

Mail goes to each clinic's **report recipients** (`report_recipients`, seeded
with the buyer at provisioning, managed at `/admin/ops/[clinicId]/care`), and
every send is claimed in `report_deliveries` before the transport is called, so
a job that runs twice mails once. The monthly report, the weekly recap, the
two live alerts (booked, escalated) and the renewal notice all carry counts
and never a patient, so they travel as `phiClass: "none"`.

### Onboarding — payment to the first answered call

`docs/onboarding-runbook.md` is the ordered list. In the software: the
checklist lives on `clinics.onboarding` (steps from `@healdesk/catalog`),
the agent's words in `agent_configs` (per clinic, versioned, approved by
name, screened by `findClinicalContent()` so no dosing, candidacy, safety or
recovery copy is ever spoken), the phone facts on the clinic row, and the
forwarding codes computed from carrier + line type + routing. The operator
page is `/admin/ops/<clinicId>/onboarding`; every write goes through the ops
API and is audited. Go-live is `app_mark_clinic_production()`: it refuses in
the database until the covered-entity answer, opening hours, confirmed
routing, an approved script and every required step are on the row, then
copies the bound agreement's date and stamps `went_live_at`.

`npm run qa:gate -w @healdesk/web` runs the demo prompt against twelve
patient-shaped probes and an injection attempt and fails on any clinical
affirmation or missing deflection. It costs tokens; run it nightly and before
any prompt change, not per commit.

### Marketing email and the funnel

Everything a prospect receives from us by email is on the marketing side
(`apps/web/src/lib/email/`), through Resend, with no patient information
anywhere near it. `send()` picks Resend when `RESEND_API_KEY` and
`HEALDESK_EMAIL_FROM` are set and otherwise prints and — in production —
throws. The From must be a real person at a subdomain that is not one of the
cold-outreach domains.

- **Who may be emailed** is one function, `canEmail()` in `lib/leads.ts`:
  marketing mail needs the ticked box and stops on unsubscribe, bounce or
  purchase; relationship mail (the abandoned-checkout note) needs no box but
  still stops on unsubscribe and bounce.
- **The nurture sequence** is four plain-text emails at 24h, 72h, 120h and
  192h after consent (`lib/email/nurture.ts`), keyed on elapsed time so a
  missed cron day sends one touch, not three. Nothing in them expires, counts
  down, or quotes a recovery rate. `/api/cron/nurture` runs hourly on Vercel
  Cron (daily on Hobby) behind `CRON_SECRET`.
- **Abandoned checkout** is one email an hour after a Stripe Session was
  created with no completion, or when Stripe reports `checkout.session.expired`.
  Subscribe the webhook endpoint to that event.
- **Unsubscribe** is `/api/email/unsubscribe?t=<signed token>`, in the footer
  and in the RFC 8058 `List-Unsubscribe` headers. It never asks "are you
  sure". **Bounces and complaints** arrive at `/api/webhooks/resend`
  (`RESEND_WEBHOOK_SECRET`) and flag the lead before the next send.
- **Attribution.** A cold email links with `?c=<campaign>`; the code is kept
  for the session, written on the lead at demo unlock or checkout, carried on
  the Stripe Session as metadata, and closed by the webhook as
  `payment_completed` with the plan and MRR. `scripts/funnel-report.ts`
  prints the stage-to-stage table, optionally by campaign.
- **The funnel mirror.** Every browser `track()` event also POSTs to
  `/api/track`, which appends to `lead_events` only when the demo gate cookie
  names a lead. Anonymous visitors are never recorded there.
- **No AI voice ever dials a prospect.** The one call the site places is the
  demo call the visitor asked for, through `canContactProspect()`, with the
  consent row written to `call_consents` before dialling and kept four years.
  `no-outbound-voice.test.ts` fails if `placeCall()` gains a second caller.
- **Spend ceilings.** `DEMO_DAILY_CHAT_CAP` (2,000 turns) and
  `DEMO_DAILY_CALL_CAP` (40 calls) per UTC day, site-wide, on top of the
  per-visitor limits. Zero switches a demo off.

### Retention

Two clocks per clinic, on the `clinics` row: `retention_media_days` (90)
clears transcript and recording references; `retention_record_days` (730)
deletes conversation, appointment and transaction rows and then contacts
nothing refers to. `retention-purge` runs both nightly, ships switched off
like every job, skips a clinic mid-sync, and writes one audit row per clinic
with counts. Consent records, suppressions and contact attempts are never
purged — they are the evidence a call was lawful — and `baa_acceptances` has
its own six-year floor. Vendor-side audio (Synthflow) is a retention setting
in their console, not a delete we run: set it at or below the media window
and screenshot it. Single-patient erasure is `eraseContact()` in
`apps/app/src/lib/retention/purge.ts`; it leaves a suppression row behind on
purpose. Backups: set the host's snapshot retention to 35 days so "deleted
within 30 days, including backups" is a statement about the calendar, not a
hope.

### Offboarding

When Stripe sends `customer.subscription.deleted` (or an operator starts it
from the care page) the clinic gets `offboarding_started_at` and a
`destroy_after` thirty days out. In between, by a person: switch the agent off
at Synthflow, send the clinic the forwarding-removal codes, and produce the
return bundle on the app host —
`npm run patient-export -w @healdesk/app -- --clinic <id> --all --requested-by "…"`
— hand it over, and record it on the care page. `offboarding-destroy` runs
daily and deletes every patient row once `destroy_after` has passed and the
export is recorded (or 90 days after the start if it never is), revokes the
connections, and writes one security event. It keeps the clinic row, the
audit log, the signed agreement, the billing history, and the TCPA evidence
(consent records, suppressions, contact attempts). Vendor-side recordings are
deleted in the Synthflow console by hand and noted on the event.

### Phase 8 — the forwarding test, the first-weeks list, deposits, Meta

**Forwarding test.** The onboarding page opens a five-minute window
(`startForwardingTest`); the first call to arrive inside it is the test, and
`lib/onboarding/forwarding-test.ts` records whether the caller ID survived
and which forward condition fired, stamping `test_call_passed` only when it
did. It needs the clinic's own published number (`clinics.published_phone_e164`)
to compare against — a call that arrives carrying that number has lost its
caller, and one arriving that way at any later date reopens the step on its
own.

**First weeks.** `/admin/ops` opens with the clinics live under sixty days:
calls handled, calls the desk would have missed, first recovered booking, and
every human touch (`clinic_touches`, append-only, PHI-scanned like an incident
summary). Two flags name the calls a person must make — past day seven with no
calls (the phone was never forwarded), and the first recovered booking nobody
has phoned about. `lib/ops/health.ts`.

**Deposits.** The agent script carries a deposit rule (`agent_configs.deposit_policy`);
a booking under a required deposit is flagged `pending_front_desk` and the
booked alert tells the desk it owes the call. That is the whole path until a
text channel exists to send a payment link on. Stripe Connect (Standard) is
scaffolded: with `STRIPE_CONNECT_CLIENT_ID` set, the onboarding page shows a
signed OAuth link, `/api/connect/stripe` stores the clinic's account id. No
money moves yet, by design.

**The Meta front door.** Built as option A from the launch guide (a front
door, not a hallway) unless the owner says B. `POST /api/webhooks/meta` takes
Messenger, Instagram and WhatsApp events, verifies `X-Hub-Signature-256` with
`META_APP_SECRET`, resolves the clinic by page / account / number id
(`app_meta_channel`, a tenant walk like the enumerators), and answers with a
narrow agent (`lib/meta/front-door.ts`: public facts only, hands off to the
phone) whose every reply passes a deterministic guard before it is sent — an
acknowledgement, a time, a provider, insurance or guidance becomes the fixed
hand-off line. Nothing the person wrote is stored; the audit row says a
message was answered and whether the guard fired. Off per clinic until an
operator switches it on (`clinics.meta_front_door_enabled`, production only,
published number required). Tokens are sealed on `provider_connections` as
`meta-<platform>`. `npm run qa:meta -w @healdesk/app` runs the ten probes
against the real model with `ANTHROPIC_API_KEY` (the patient org's key).

**The booking hand-off (21 September 2026).** Option A stays, with one
addition the owner asked for: the front door takes a booking *request* that
a human at the practice accepts or declines. The model answers in JSON
(`{reply, booking:{wants, first_name, phone, window}}`); the three fields are
cleaned deterministically (letters, E.164, a window with no condition or
treatment in it) and merged into `meta_booking_drafts`, keyed by the thread,
so nothing about the conversation is remembered. When all three are present
one `booking_requests` row is written against a contact upserted by phone,
the draft is deleted, every report recipient is emailed a single-use link
(`/booking/[token]`, SHA-256 stored, seven days, `phiClass: "none"` because
the email names nobody), and the person gets fixed text: the practice has
your request and will call. The desk page shows the three things and two
buttons; the decision is one conditional UPDATE, the trigger in 0037 makes
it final, and the person is told the practice will call — accepted or
declined, never a time or a provider. The care view shows counts only. A
practice with no report recipient still gets the row; it waits.

### Decisions log (21 September 2026)

The owner's answers to the six placeholders and three follow-ups, and what
each became in code. Reopen any of these by changing the code, not by
re-asking.

1. **Overage rates — keep both figures.** $0.35 per voice minute, $0.25 per
   chat conversation; `OVERAGE_RATES_PROVISIONAL` is `false`. A monthly
   subscription carries the metered prices; an annual one carries none and
   its overage is **invoiced separately, monthly in arrears, by hand** until
   `annual-overage-invoicing` is built. Nothing bills against the meters
   until `usage-meter-events` is built either way. The terms say so.
2. **Refund window — 14 days**, full refund of the first month's fee; the
   setup fee is never refundable. `POLICY.refundWindowDays`, terms § fees.
3. **Annual cancelled mid-term — no refund**, access to term end, auto-renew
   off. `POLICY.annualProRataRefund = false`.
4. **Cohort setup credit — keep.** One Stripe coupon per package, created by
   `stripe:setup`, `amount_off` = that package's setup fee, `duration: once`.
   Stamped on the lead when the Day 7 email goes out
   (`leads.cohort_credit_offered_at`), honoured at checkout only inside the
   fourteen days, never from a URL parameter alone. The copy quotes the fee
   range rather than "$500".
5. **Demo expiry — 7 days.** Already what the code did.
6. **Reviews — capture every rating, route internal follow-up by score,
   never gate what is published.** Nothing gated exists in code; the
   customer-success plan text is the only thing that said otherwise.
7. **Meta — keep A everywhere, plus the booking hand-off** above.
8. **The revenue gate** — explained to the owner in plain English; awaiting
   their call. The `revenue-gate-decision` task is the record.
10. **Insurance — declined; "healdesk does not assume any responsibility".**
   Recorded as the owner's decision, with what it means in practice. What the
   paperwork can do, and now does: the terms and the BAA cap liability at
   twelve months' fees with **no floor** (`POLICY.liabilityFloorUsd = 0`; the
   BAA's `[$X]` is gone), exclude consequential damages, and say plainly that
   healdesk carries no liability insurance so a practice can size its own
   cover. The earlier draft line "backed by healdesk and by its insurance" was
   removed because it would have been false. What no paperwork can do: HIPAA
   makes a business associate responsible by statute, TCPA and CIPA claims
   come from patients who signed nothing, and no US court enforces "we accept
   no responsibility" against those. The code keeps doing the things that
   reduce the odds (no outbound AI calls, recording disclosure, no
   voiceprints, no clinical advice). Consequences accepted in writing:
   clinics that require a certificate of insurance are lost; every claim is
   paid from company cash; there is no retroactive date, so nothing that
   happens before a policy is ever bound can be covered later.
11. **Inbound-only, and transcripts without audio.** The two design changes
   that remove the exposures a contract cannot touch. Inbound-only:
   `OUTBOUND_CONTACT_ENABLED = false` in `lib/compliance/contact-policy.ts`
   refuses every contact before reading a row (nothing called the gate
   anyway); `ingestCall()` refuses a call the vendor flags as outbound and
   writes a security event; the BAA omits the outbound clause and the
   clinic's consent warranty (`outboundMessaging: false`); the terms say
   "inbound only" and the pricing page no longer lists reactivation. The two
   counsel questions about reactivation and callbacks are moot. No audio:
   `conversations.recording_uri` is dropped (0038), the payload parser
   ignores `recording_url`, the disclosure says "transcribed; no audio
   recording is kept", and the owner switches recording storage off in the
   Synthflow console (launch guide, Synthflow card, Part 5). The vendor
   still processes audio live to transcribe it, which is why the disclosure
   still says "transcribed" and the recording-consent states still matter.
12. **Why data is stored at all.** Asked by the owner on 21 September 2026.
   Six things, each with a reason that is a law or a contract, not a habit:
   the contact and conversation rows are what the monthly revenue report and
   attribution are built from (the product's promise); the appointment and
   transaction rows are read back from the clinic's own system to reconcile
   it; the transcript reference (90 days) is the only way to answer "what
   did the agent say" in a dispute or a patient-rights request; the audit
   log is required by HIPAA §164.312(b) and is the accounting of disclosures;
   consent records, suppressions and contact attempts are the TCPA defence
   (four-year clock, kept even though nothing outbound runs, because "stop"
   is honoured forever); billing and agreement records are tax and contract
   evidence. Everything else is already not stored: no audio, nothing a
   person wrote on a Meta channel, no ad-platform identifiers, no logs with
   patient data, and the retention clocks purge the rest.
9. **Home state — the Stripe facts.** The seller is Viixi FZC, a UAE free
   zone company trading as healdesk. Governing law is Delaware by counsel's
   (this agent's) recommendation: a UAE entity has no US home state, US
   clinics will not accept UAE law or venue, and Delaware is the neutral
   default clinic counsel expects. `ENTITY` in `apps/web/src/lib/legal.ts`
   and the constants in `packages/catalog/src/baa.ts`. Still missing: the
   registered address from the Stripe account, which keeps the legal pages'
   draft banner up. The liability floor is decided: none (item 10).

### Incidents and patient rights

`docs/incident-response.md` is the procedure. Incidents are rows with
deadlines (`incidents`, opened from the care page; the summary is PHI-scanned
on the way in and refuses a phone number or an address), and the daily tick
does not close them — a person does. Patient access, amendment and accounting
requests are answered with `npm run patient-export` (one person by phone or
email) and `amendContact()`; the bundle is a file on the app host, never a
page in the console, because `apps/web` holds no PHI.

### Logs

Every log line on the PHI side goes through `apps/app/src/lib/log.ts`, and
`tests/no-console.test.ts` fails the suite on a bare `console.*` anywhere
else in `apps/app/src`. The logger allowlists field keys (ids, counters,
statuses, a short `reason`/`error`) and scrubs emails, phone-shaped numbers
and URLs with query strings out of free text. Log an id, then read the row
inside `withTenant()` if you need the thing.

Three rules that live outside the code:

- **Retention on the host, not "never expire".** Whatever collects stdout
  (CloudWatch on ECS, the Fly log shipper, journald on a box) gets an explicit
  retention — 30 days is enough for debugging and short enough to bound a
  breach — and, on AWS, a customer-managed KMS key on every log group plus
  the `cloudwatch-log-group-encrypted` Config rule.
- **No error tracker.** There is none on purpose. Sentry, Datadog and the
  like capture request bodies and local variables by default, and the only
  ones that sign a BAA cost more than the product earns this year. The
  structured log line plus the `security_events` and `audit_log` tables are
  the trace. Revisit when there is a second engineer and a budget.
- **Never put a patient identifier in a name.** Not in an S3 key, a bucket,
  an RDS identifier, an ECS task name, a queue name or a resource tag. Names
  land in CloudTrail, console listings and the billing export, none of which
  are encrypted with our key. Clinic ids and opaque uuids only.

### Three database rules the audit taught us

- **A migration that writes to a FORCEd table must declare a tenant.** The
  migrator is `NOBYPASSRLS`, so `UPDATE conversations ...` with no
  `app.clinic_id` set matches zero rows and reports success. 0019 did exactly
  that. Loop over clinics with `set_config('app.clinic_id', id, true)`, or
  write the backfill as a `SECURITY DEFINER` function, and count the rows.
- **A new column on `clinics` needs its own `GRANT UPDATE`.** 0031 scoped the
  runtime role's UPDATE to a column list so it cannot touch
  `data_classification` or `baa_signed_at`; column grants do not extend to
  columns added later. `tests/database-audit.test.ts` fails until the grant
  is added.
- **Nothing writes the two gate columns except `app_mark_clinic_production()`**
  and nothing binds an agreement except `app_bind_agreement()`. Both are
  `SECURITY DEFINER`, both refuse the unsafe case, and the runtime role has no
  other route. Going live is a call to the first; the go-live step in the
  console is the only place it should be called from.

### The one thing not to break

`apps/app/tests/rls-drift.test.ts` asks the catalog which tables carry a
`clinic_id` and demands each one have row-level security enabled **and forced**.
It keeps working on tables that don't exist yet, so it fails the day someone adds
a PHI table and forgets the policy. If it goes red, that is the reason.

The isolation tests assume the application forgets its clinic filter and check
the database refuses anyway. They must pass before any connector code merges.

### Sign-in

There is no public sign-up — deliberate, since this console holds patient data.

**The first operator** still has to be bootstrapped by hand: insert an
`invitation` row for your email against `org_healdesk_internal`, then open
`/accept-invite?id=<that id>`. After that, everyone else is invited from the
**Team** page in the console.

Invitations are the only route to an account. Ops invitations last 7 days;
clinic-owner invitations 14.

---

## 6. Where things are

| Path | What |
|---|---|
| `docs/launch-plan.md` | Plan of record — vendor decisions, pricing, compliance |
| `docs/hipaa-compliance.md` | PHI boundary and the rules that keep `apps/app` portable |
| `apps/app/README.md` | The security model, in detail |
| `apps/app/src/lib/tenant.ts` | The only door into patient data |
| `apps/app/src/lib/compliance/` | Consent, suppression, disclosure |
| `apps/app/src/lib/sync/reconcile.ts` | The money rules, pure and testable. Read this one before disputing a figure |
| `apps/app/src/lib/sync/run.ts` | One sync run: cursors, paging, per-page transactions |
| `apps/web/src/lib/billing.ts` | Checkout session creation; why the payload rides in metadata per-field |
| `apps/web/src/app/api/webhooks/stripe/route.ts` | Where accounts are actually created. Read the status-code reasoning before changing one |
| `apps/app/drizzle/0021_provisioning_idempotency.sql` | Why a Stripe retry can't create a second account |
| `apps/app/src/lib/clinic/opening-hours.ts` | After-hours recovery. Returns `null` for "not collected" — never coerce it |
| `apps/app/src/lib/queue/boss.ts` | Queue names, payload allowlist, why the queue can't self-migrate |
| `apps/app/src/workers/index.ts` | The background worker entry point |
| `apps/app/drizzle/` | Migrations. Order is load-bearing: roles → tables → functions → policies → grants |
| `packages/catalog/` | Shared between the site and the product — platforms, plans, BAA, wizard steps |
| `packages/connectors/` | The anti-corruption layer: one canonical model, declared capabilities, the fixture clinic |
| `packages/leadgen/` | Prospecting: signals, scoring, outreach angles |
