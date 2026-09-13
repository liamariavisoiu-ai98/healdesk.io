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
   `charge.dispute.created`. Not `customer.subscription.paused` /
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

### Cyber / tech E&O insurance

With **explicit TCPA and statutory-privacy endorsements**. Standard policies
exclude exactly these, which is the point. Earlier than feels necessary.

---

## 2. Blocked on counsel

| Item | Why it matters |
|---|---|
| **Ad-platform attribution — removed, keep it that way** | Sending person-level conversion data to Meta/Google is the GoodRx fact pattern — $1.5M there, $7.8M at BetterHelp. `ad_interactions` and the `conversations` join to it were **dropped in `drizzle/0017`**; this is no longer deferred, it is out of scope. Reintroducing a click-id column needs counsel first. Note `src/lib/attribution/` is a different thing wearing a confusing name: it reconciles the clinic's own POS money event and reports it back to them, and nothing leaves for a third party |
| **Covered-entity determination** | Cash-pay med spas often aren't covered entities, which removes five defences at once including Washington MHMDA's — and that has a private right of action. Needs a method and a different posture for non-covered clinics |
| **CIPA positioning** | Party-extension or independent third party? Contracts, architecture and marketing copy must all say the same thing |
| **Click-through BAA — approved and enforced, not open** | The mechanism is production-ready — versioned, hashed, append-only acceptance — and the text is no longer a placeholder: `packages/catalog/src/baa.ts` `BAA_TEMPLATES[0]` is version 1.0.0, published 2026-09-05, `approvedByCounsel: true`, and `apps/app/src/lib/provisioning.ts` refuses to provision a clinic against any template that isn't (`currentBaaTemplate().approvedByCounsel`). Listed here so nobody re-opens it. What still needs counsel is the **other five rows** of this table |
| **Reactivation = HIPAA marketing?** | Determines whether a separate authorisation is needed on top of written TCPA consent |
| **Missed-call callback consent** | Especially hangups where we hold only the number |

---

## 3. Engineering left

Ordered by what unblocks the most.

### Voice — Synthflow, now unblocked

- **Voice integration.** Behind an interface so the vendor stays swappable. The
  compliance core it needs — consent, suppression, frequency caps, disclosure —
  is already built and vendor-independent.
- **Disclosure injection**, non-defeatable by clinic configuration. If a clinic
  can switch it off, a clinic will, and you become a co-defendant.
- **Wire `canContact()` into the outbound path.** It exists and is tested;
  nothing calls it yet because nothing places calls yet.

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

- **Annual renewal reminder.** The terms say we email 30 days before an
  annual renewal. No job sends it; `annual-renewal-reminder` in the task list
  has the design. Stripe's built-in renewal email is the stopgap.
- **Real connection verification.** `verify.ts` currently validates the shape of
  what was pasted and reports capabilities from the catalogue. The per-platform
  HTTP calls need real credentials against real tenants.
- **Real adapters.** `packages/connectors/` has the port, the guards, the rate
  budgets and a fixture that behaves like an awkward real platform. Only the
  fixture is registered, on purpose: registering an unimplemented adapter would
  let the sync engine pick it up and fail at runtime instead of at connect time.
  Adding one is a single line in `registry.ts` plus the adapter — the engine,
  the matcher and the reports need no changes.
- **Nothing schedules the queue yet.** `install-queue.ts` creates the queues and
  the worker drains them, but no cron enqueues a nightly sync. That is one
  `boss.schedule()` call, deliberately left off until there are tenants — the
  same reason the monthly report job ships switched off.
- **Write-back (Channel B).** Deferred deliberately. Research is done —
  GoodHighLevel and Boulevard are the best targets, PatientNow needs
  `customeruserdefined` not `customernote` because it's a real EMR, and Vagaro
  has no write-back path at all.
- **Ingestion must set `recovery_reason`, and `after_hours` needs the hours.**
  The column and the report read it, but nothing writes it — voice ingestion
  isn't built. Set it at the moment the call arrives; it cannot be reconstructed
  afterwards. For `after_hours`, call
  `isAfterHours(hours, at, clinic.timezone)` from `lib/clinic/opening-hours.ts`
  and record the reason **only when it returns `true`**. It returns `null` when
  the clinic's hours were never collected, and that null must not be coerced —
  a clinic wrongly assumed to shut at 5 would have its 6pm calls claimed as
  recovered while its own staff answered them. Hours are collected at
  `/c/[slug]/hours`; while they are empty the report understates, on purpose.
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
npm test -w @healdesk/app          # 483 tests
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
