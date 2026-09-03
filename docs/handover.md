# Handover

Where the build stands, what is blocked, and what to do next.

Everything that could be built without an external account or a lawyer has
been. What remains is genuinely waiting on something.

> **Two documents now cover everything in sections 1 and 2**, researched and adversarially
> fact-checked on 17 Aug 2026:
>
> - **[research-conclusions.md](./research-conclusions.md)** — plain English, end to end.
>   What the rules actually are, why they exist, which vendors trip over them, and what it
>   means commercially. Read this first.
> - **[blockers-runbook.md](./blockers-runbook.md)** — the same findings as click-by-click
>   instructions, with the verbatim text to send each vendor. Use this to do the work.
>
> This file stays as the index.

> **Follow this file, not `state-of-play.md`.**
>
> [state-of-play.md](./state-of-play.md) is a dated **audit** (2 Sep 2026): the BAA
> reviewed clause by clause against 45 CFR 164.504(e)(2)(ii), a codebase pass, and
> the niche argument. Read it when you want to know *why* something is on the list
> below, or before touching the BAA or the recovery classification — the reasoning
> there is better than any summary of it.
>
> But it is a snapshot, and parts of its "what to do, in order" have since been
> done (database-backed CI, the recovery classification, the BAA promise fixes).
> Don't work from its task list. Its open findings have been folded into section 3
> here, each marked with whether it was re-verified.
>
> One list, and it is this one.

---

## 1. Blocked on you — accounts and decisions

These gate real work. Roughly in the order they unblock the most.

### ⚠️ Synthflow: is HIPAA available below Enterprise?

**The single most consequential open question.** Ask them, verbatim:

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

At ten clinics on Enterprise, Synthflow alone costs $250 per clinic — more than
the entire $249 subscription. If the answer is Enterprise-only, the honest
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

**Then, before creating anything:** the workspace region choice is **permanent**
and defaults to **EU**. Create a **US** workspace or you rebuild.

### AWS account + BAA

Free, click-through, five minutes, and it covers RDS, KMS, SES, S3 and Fargate
in one agreement — every other vendor gives you a BAA for the database only.

Do it now even though no infrastructure is needed yet. Development runs on local
Docker Postgres; provision RDS when the first clinic signs (~$25/mo at
`db.t4g.small`).

*Note: App Runner is not HIPAA-eligible. Use ECS on Fargate.*

### Bandwidth account + BAA

For SMS and for owning the phone numbers. Bandwidth is the only provider found
with **no documented tier gate** on its BAA — Twilio requires Security or
Enterprise Edition at an unpublished price, and Plivo gates it behind $1,000/mo.
Confirm in writing that there's no hidden commitment.

Own the numbers here rather than in Synthflow: it makes switching voice vendors
a config change instead of a port, and Synthflow's own docs frame their numbers
as *"for quick testing"* with no toll-free and undocumented porting.

### Anthropic BAA — and keep it off the marketing org

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

1. **Create the products and prices.** `npm run stripe:setup -w @healdesk/web`.
   The account currently has **zero** prices, so `createCheckout` throws a
   "run the setup script" error on the first attempt. Re-run it per environment
   (test, then live) — it is idempotent and reports drift between Stripe and
   `packages/catalog/src/plans.ts`.
2. **Refresh the CLI credential.** `stripe login` mints a key that expires after
   90 days and ours lapsed in July, so `stripe listen` fails with
   `api_key_expired`. Either run `stripe login` again, or prefix commands with
   `STRIPE_API_KEY="$STRIPE_SECRET_KEY"` — the app key is valid and works.
3. **Production webhook endpoint.** Dashboard → Developers → Webhooks, pointing
   at `/api/webhooks/stripe`, subscribed to `checkout.session.completed` and
   `checkout.session.async_payment_succeeded`. Its signing secret is a
   **different value** from the local one — per-endpoint, not per-account.

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
| **Click-through BAA** | The mechanism is production-ready — versioned, hashed, append-only acceptance. The text in `packages/catalog/src/baa.ts` is a placeholder marked `approvedByCounsel: false` and must be replaced |
| **Reactivation = HIPAA marketing?** | Determines whether a separate authorisation is needed on top of written TCPA consent |
| **Missed-call callback consent** | Especially hangups where we hold only the number |

---

## 3. Engineering left

Ordered by what unblocks the most.

### Once Synthflow is answered

- **Voice integration.** Behind an interface so the vendor stays swappable. The
  compliance core it needs — consent, suppression, frequency caps, disclosure —
  is already built and vendor-independent.
- **Disclosure injection**, non-defeatable by clinic configuration. If a clinic
  can switch it off, a clinic will, and you become a co-defendant.
- **Wire `canContact()` into the outbound path.** It exists and is tested;
  nothing calls it yet because nothing places calls yet.

### Once AWS + Bandwidth land

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
- **The embedded scheduler for no-system clinics is still unchosen.** Cal.com
  and PracticeQ both clear the three axes (offers a BAA, agent can write
  bookings, exposes show/collect). Current recommendation is **PracticeQ**,
  because the PHI-light voice agent needs somewhere to push intake and PracticeQ
  is both the scheduler and that destination — one BAA'd vendor instead of two —
  and its BAA is self-serve on every plan. **Contingent on one check:** whether
  its API creates bookings programmatically, not just reads. If it doesn't,
  Cal.com is the fallback; its booking-write and `BOOKING_PAID` webhook are
  confirmed today. Settle that before building the provisioned-booking path.
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
- **`approvedByCounsel` gates nothing.** It is read in three places and every one
  of them only *reports* it (`agreements.ts:319,332`, `api/agreements/route.ts:88`).
  The real production gate is `drizzle/0004_baa_gate.sql`, which keys on
  `data_classification` + `baa_signed_at` — and a signature on the draft satisfies
  that. Comments in `packages/catalog/src/baa.ts` claim provisioning refuses to
  classify a clinic as production while it is false; nothing does. Either wire it
  or fix the comment, but do not leave a claimed safeguard that isn't there.
  **Verified still true, 3 Sep.**
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
npm test -w @healdesk/app          # 159 tests
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
