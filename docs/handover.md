# Handover

Engineering notes: where the code stands, facts that are expensive to rediscover, and
decisions that still hold. **This is not the task list.** The only live task list is the
[Launch plan tab](https://claude.ai/artifact/F7bKioXheMJwn5Epc65bVQ) of the v1 spec's
source doc. What the product is and does is [v1-product-spec.md](./v1-product-spec.md);
where code goes is the root [`CLAUDE.md`](../CLAUDE.md), which also lists what stops
`apps/app` deploying.

> **Rewritten 1 October 2026.** The previous version of this file (up to commit 618e210)
> was the live list and was built on Synthflow, call-backs, Cal.com writes, a monthly
> revenue report and a clinic that never logs in. All of that is reversed or fenced as
> phase two by the spec. The old text is in git history; the decisions that still hold
> are carried forward below, and the ones that do not are marked superseded. The 30
> September alignment pass is changing some of the code described here in parallel:
> read the code before relying on any line.

## Which document, when

| Document | What it is |
|---|---|
| [v1-product-spec.md](./v1-product-spec.md) | **Start here.** What v1 is, how it behaves, what it may claim. An export: never edit it, change the source doc and re-export |
| [Launch plan tab](https://claude.ai/artifact/F7bKioXheMJwn5Epc65bVQ) | The only task list, with owners, dates and status |
| [`CLAUDE.md`](../CLAUDE.md) | Where code goes (the PHI boundary), the product rules the code enforces, deploy blockers |
| [architecture.md](./architecture.md) | How the apps fit together, and what is built |
| [hipaa-compliance.md](./hipaa-compliance.md), [hipaa-risk-analysis.md](./hipaa-risk-analysis.md), [policies/](./policies/), [incident-response.md](./incident-response.md), [on-call.md](./on-call.md) | The compliance set, redrafted for v1 |
| [blockers-runbook.md](./blockers-runbook.md), [research-conclusions.md](./research-conclusions.md), [state-of-play.md](./state-of-play.md), [counsel-audit.md](./counsel-audit.md), [synthflow-voice-agent-context.md](./synthflow-voice-agent-context.md), [marketing-voice-demo-context.md](./marketing-voice-demo-context.md) | Dated research, audits and agent briefs. Each opens with a banner naming where the spec overrides it |
| [launch-plan.md](./launch-plan.md), [next-steps.md](./next-steps.md), [prd.md](./prd.md), [onboarding-runbook.md](./onboarding-runbook.md), [design/](./design/) | Superseded. Kept in place for history, under banners; [docs/README.md](./README.md) indexes them |

`npm run docs` serves these documents locally with a task view that predates the spec.
Read it as reference; where it disagrees with the Launch plan tab, the tab wins.

---

## 1. Where the code stands

State at commit 618e210 (30 September 2026).

**Built, and still right for v1.** The PHI boundary (`apps/web` has no database client;
`/admin` reaches `apps/app` only through the HMAC-signed ops API). Tenant isolation with
forced row-level security and the drift test. Checkout with the BAA accepted inline
(version, timestamp and IP stored; template 1.0.0 approved, and provisioning refuses an
unapproved one). Idempotent provisioning. Stripe billing events, with the first paid
invoice moving the clinic from `provisioning` to `active`. The audit log, the allowlisted
logger, the worker and queue, retention purge, offboarding, incidents and patient
export. The operator console. The marketing site, demo, lead register and nurture
email.

**Not built (v1 needs it).** The Retell custom-LLM WebSocket endpoint and its process.
The web chat widget and its API. The Google Calendar write path: OAuth, free/busy,
60-second holds, idempotent writes, the token watch. Meta booking and payment links inside
the 24-hour window, and the clinical-content boundary in the v1 adapter. The clinic
portal, its sign-in (magic link, second factor before transcripts, roles), the four-step
wizard and the support chat. The shared pre-model guard. The pre-launch audit, "Flag this
answer" and the monthly re-scrape diff. Pause AI and the per-channel switches. Deposit
links through the clinic's gateway (Stripe Connect is scaffolded; no money moves). The
daily summary email.

**Pre-spec code still in the tree, not v1.** Keep it switched off; the spec decides
whether each piece is reworked, fenced or removed.

- **Synthflow** voice routes: the post-call webhook (`api/webhooks/voice/[clinicId]`,
  `lib/voice/synthflow-payload.ts`, `ingestCall()`) and the mid-call tools
  (`api/voice/tools/[clinicId]`, `HEALDESK_VOICE_TOOLS_SECRET`). Pre-Retell; they must
  not carry a real patient call. The marketing demo call (`apps/web`, owner-requested)
  stays on Synthflow until a Retell demo agent exists.
- **Call-backs, direct booking into Cal.com, WhatsApp templates and the `/setup` link**
  (migration 0040, `lib/callbacks/`, `lib/booking/calendar.ts`, the direct-booking
  addendum). v1 is inbound only and writes only to Google Calendar.
  `HEALDESK_OUTBOUND_CALLBACKS_ENABLED`, `HEALDESK_DIRECT_BOOKING_ENABLED` and
  `HEALDESK_WHATSAPP_TEMPLATES_ENABLED` stay unset in every environment.
  `OUTBOUND_CONTACT_ENABLED = false` in `lib/compliance/contact-policy.ts` stays false.
- **The Meta front door** (`lib/meta/front-door.ts`) answers public facts and takes
  booking requests; it books nothing. The staff-approval booking-request path
  (`booking_requests`, `/booking/[token]`) is kept: it becomes the "Auto-confirm
  bookings" off and manual-booking-mode path, decided from the portal's Bookings screen
  rather than an emailed link.
- **Phase two**: `/connect/[token]` (pasted POS credentials), `lib/attribution`,
  `lib/sync`, `packages/connectors`, the monthly revenue report and nightly sync jobs.
  Kept and tested; out of v1 flows, screens, emails and claims.

---

## 2. Accounts and vendors

### AWS account + BAA — accepted 22 September 2026

Done by the owner in AWS Artifact, as an account agreement. It covers RDS, KMS, SES, S3
and ECS on Fargate in one agreement. The click-through form carries no account id,
region or date (the "executed" download is byte-identical to the blank form), so the
record AWS does not keep is ours: [policies/aws-hipaa-account.md](./policies/aws-hipaa-account.md),
account `865780386982` (named `healdesk.io`), region `us-east-1`, both supplied by the
owner on 23 September 2026. It still needs the Artifact "Active" screenshot filed beside
the PDF. The obligations it lists — PHI only in eligible services, the highest audit
logging, maximum log retention, encryption at rest and in transit — become
infrastructure tasks the moment the account holds anything: see "Once AWS lands" below.

Development runs on local Docker Postgres. *App Runner is not HIPAA-eligible and is
closed to new customers. Use ECS on Fargate.*

### The rest of the BAA chain

From the spec's "Where the chain is complete, and where it is not". No real patient data
reaches `apps/app` until every link is done.

| Link | State |
|---|---|
| Clinic to Healdesk | Built: accepted inline at checkout |
| Healdesk to Retell | Not done. Self-sign the BAA and DPA in Retell's click-agreements portal, confirm the executed text names the services in use, then set per-agent retention and PII controls |
| Healdesk to Anthropic | Not done. The primary owner signs and activates. Patient traffic needs its **own** organisation: the HIPAA setting is organisation-wide and one-way, so enabling it on the marketing org would bind the demo's key too. The marketing key in `apps/web/.env.local` is already from a separate, non-PHI organisation. Covered models require 30-day retention; do not also request zero data retention |
| Healdesk to the database provider | Not chosen: AWS RDS under the agreement above, or Neon on its Scale plan under its own |
| Healdesk to AWS | Done (above) |
| Clinic to Google | The calendar is the clinic's own, under its agreement with Google. Confirm per clinic |

Meta and Stripe never sign one: they are handled by scoping (nothing clinical on Meta;
only an amount, a generic descriptor and a reference on Stripe or the clinic's gateway).

The four external gates in the spec ("External gates on the launch date") are on the
Launch plan tab: Meta Business Verification of Viixi FZC, Meta App Review, WhatsApp Tech
Provider, and Google's verification of the calendar scope.

### Stripe account — built, three steps from working

Checkout, the webhook and idempotent provisioning are implemented. A test-mode secret
key and a local webhook signing secret are in `apps/web/.env.local`. What is left:

1. **Create the products, prices and meters.** `npm run stripe:setup -w @healdesk/web`
   (add `--dry-run` to see the plan with no key and no calls). The catalog
   (`packages/catalog/src/plans.ts`) has **five packages**, each with a monthly, an annual
   and a one-time setup price, plus three metered overage prices on **two Billing Meters**
   (voice minutes at $0.80; chat conversations at $0.40 or $0.30 by package). Until it runs, `createCheckout` throws a "run the
   setup script" error. Run it against the test key, then the live key: it is idempotent
   by `lookup_key`, never edits a price, and reports drift against the catalog. It has
   never been run against a live-mode key.
2. **Production webhook endpoint.** Dashboard → Developers → Webhooks, pointing at
   `/api/webhooks/stripe`, subscribed to `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`, `checkout.session.expired`,
   `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`,
   `customer.subscription.updated`, `customer.subscription.deleted` and
   `charge.dispute.created`. Not `customer.subscription.paused` / `.resumed`: there is
   no trial, and a pause arrives as `customer.subscription.updated` with
   `pause_collection` set. Its signing secret is a **different value** from the local
   one — per endpoint, not per account.
3. **Dashboard settings the script cannot set.** Customer Portal configuration (card
   update, plan change, cancel at period end only), Stripe Tax on, failed-payment emails
   on, and under Subscriptions → "on payment failure" choose **do not cancel**: the app
   owns suspension through the `billing-sweep` job, which ships switched off like every
   job, so enable it the same day. On suspension a clinic's calls must forward to its own
   line; until that is automatic, disable its voice agent by hand and send the
   remove-forwarding instructions.

Also by hand until built: upgrade setup-fee deltas (`setupFeeDeltaUsd` in the catalog;
`entitlements.setup_fee_paid_usd` records what was paid), and the annual renewal
reminder (turn on Stripe's own "upcoming renewal" email meanwhile). Confirm the Stripe
account's business details match Viixi FZC, the seller.

Two things about that flow worth not rediscovering:

**An account is recorded on `checkout.session.completed` and activated only by the first
paid invoice.** The clinic is created in `provisioning`, with nothing switched on; the
first invoice's `invoice.paid` (`billing_reason: "subscription_create"`) moves it to
`active`. Never the success URL: a customer who closes the tab after paying still gets
their account, and someone who hand-crafts a success URL gets nothing.

**Stripe retries every non-2xx for up to three days.** So a missing signing secret
returns **500** deliberately: the events queue up and replay once it is set. A *wrong*
secret is worse than a missing one, because it passes the config gate and lands on the
400 "invalid signature" path meant for forgeries, silently failing every real sale.
Never put a placeholder in `STRIPE_WEBHOOK_SECRET`.

### The marketing lead register

The marketing site keeps its data in one Google Sheet: demo leads, funnel events, the
demo-call consent record and the two daily spend counters. Four tabs, each headed with
the old Postgres column names in the old order (`apps/web/src/lib/sheets/schema.ts`),
ISO timestamps as text, TRUE/FALSE booleans, blanks for null. The site provisions the
tabs itself on first use; `npm run sheets:init -w @healdesk/web` does the same by hand,
which is the quickest way to prove the sharing and the key work before a deploy.

The Sheet must be owned by the **company** Google account (the owner wrote
`headesk.io@gmail.com`; confirm the exact address, it may be a typo for
`healdesk.io@gmail.com`), never a personal Drive: whoever owns it owns the leads.

Service account: `healdesk-sheets@healdesk-marketing-2026.iam.gserviceaccount.com`
(project `healdesk-marketing-2026`, Sheets scope only). To set it up:

1. In the company Google account, create a blank Sheet in Drive.
2. Share it as **Editor** with the service account address above.
3. Copy the id from the URL: the long token between `/d/` and `/edit`.
4. Create the key, once, and keep the file out of the repo:
   `gcloud iam service-accounts keys create healdesk-sheets-key.json --iam-account=healdesk-sheets@healdesk-marketing-2026.iam.gserviceaccount.com --project=healdesk-marketing-2026`
5. On Vercel (apps/web project, all environments), set `MARKETING_SHEET_ID` to the id
   and `GOOGLE_SERVICE_ACCOUNT_JSON` to the whole contents of the key file (base64 of it
   is accepted if the paste mangles newlines).
6. Run `npm run sheets:init -w @healdesk/web` with the same two variables in
   `apps/web/.env.local`, or let the site do it lazily on the first lead. Then open
   `/admin/crm` signed in to the company account.

With either variable missing nothing goes down: the demo runs and the lead is lost
(logged as a count, never an address), `/admin/crm` shows an empty state, and the daily
caps fall back to per-instance memory with one warning. Rotating the key is `gcloud iam
service-accounts keys create` again, paste, redeploy, then delete the old key id.

---

## 3. Engineering notes

### Once AWS lands

The HIPAA Account build list, from the AWS addendum (§4.2–4.3) and the service table in
[policies/aws-hipaa-account.md](./policies/aws-hipaa-account.md). Build it with the first
RDS instance, not after, because the first item cannot be added later.

- *Decide the database first:* RDS under this agreement, or Neon on Scale under its own.
  The list below assumes RDS.
- *RDS:* storage encryption with our KMS key at creation; `rds.force_ssl=1`; the
  `healdesk_app` (NOBYPASSRLS) and `healdesk_migrator` roles; 35-day automated backups;
  the RDS CA trusted in the container (production sets `rejectUnauthorized: true` and
  fails without it); Config rule `rds-storage-encrypted`; a restore drill.
- *KMS:* one customer-managed key; a task-role policy limited to `GenerateDataKey`,
  `Decrypt` and `Encrypt` on it; `HEALDESK_KMS_PROVIDER=aws-kms` and `HEALDESK_KMS_KEY_ID`
  in every task definition, the key ID as the key's full ARN
  (`arn:aws:kms:us-east-1:<account>:key/<key id>`), since an alias, a bare ID, a
  multi-Region key or another region is refused; `AWS_REGION` unset or `us-east-1`, since
  the KMS client falls back to us-east-1 and refuses any other region;
  `@aws-sdk/client-kms` is a dependency of apps/app and ships in the image (fixed 6 October
  2026); the worker's start-up log line ("credential key self-check passed") to confirm
  the task role reaches the key (the read-only ops operation `getCredentialKeyStatus` asks
  the web tier the same, but nothing in `/admin` calls it yet); a rotation runbook.
- *S3:* a bucket in the designated region; SSE-KMS with our key; a policy denying non-TLS
  requests; Block Public Access; versioning; lifecycle expiry matched to
  `clinics.retention_media_days`; Config rule `s3-bucket-ssl-requests-only`; no patient
  identifier in any key.
- *ECS on Fargate:* three task definitions from one image — the web tier, the worker,
  and the Retell voice endpoint once it exists (a long-lived WebSocket process); a task
  role carrying only the KMS, SES and S3 permissions; secrets from the host's secret
  store, never the image; a one-off migration task as `healdesk_migrator`; ECR; no PHI in
  names or tags; a `stopTimeout` above the worker's drain. pg-boss stops with its 30 s
  default because `lib/queue/boss.ts` passes no `timeout`; a two-minute drain needs
  `timeout: 120_000` there and a `stopTimeout` above it, and Fargate's maximum is 120 s.
- *Load balancer:* an HTTPS listener with an ACM certificate, HTTP redirected, WebSocket
  upgrades allowed through to the voice endpoint, the health check on
  `GET /api/health?probe=liveness` (200 whenever the process is up; the plain path answers
  503 while a critical email is late, which is the uptime check's alarm, not a reason to
  replace a task), rate limiting on the host.
- *CloudTrail:* on and kept, encrypted with our key, log-file validation, S3 data events
  on for the PHI bucket, Config rule `cloud-trail-encryption-enabled`.
- *CloudWatch Logs:* every log group encrypted with our key and set to "Never expire"
  (§4.2(c)), Config rule `cloudwatch-log-group-encrypted`.
- **SES sending.** `SesTransport` throws with instructions. Needs a verified domain,
  DKIM, and a configuration set with `TlsPolicy: Require`. Wire bounces and complaints to
  the clinic contact they belong to, never to patient suppression tables.
- **A2P 10DLC — dropped.** No SMS in v1. SMS is a phase-two paid add-on with per-clinic
  carrier registration of one to four weeks.
- **The monthly report job stays off.** It is the phase-two revenue report.

### Unblocked, just not done

- **Done since 3 September: the assent label is checked.** `validateSignRequest`
  (`apps/app/src/lib/agreements.ts`) now rejects a label that does not match
  `BAA_ASSENT_LABEL`.
- **Done: `approvedByCounsel` gates provisioning.** `apps/app/src/lib/provisioning.ts`
  refuses to provision a clinic against an unapproved template; 1.0.0 is approved.
- **`stripe:setup` has never been run against a live-mode key** (above).
- **Database-layer findings from the 2 September audit.** `0019`'s backfill silently
  affects zero rows; the BAA gate sits on state the gated role can write;
  `baa_acceptances` has no RLS. See `docs/state-of-play.md` → Database-layer findings.
  *Not re-verified since 2 September.*
- **Phase two, kept: real connection verification and real adapters.** `verify.ts`
  validates the shape of a pasted credential; `packages/connectors` registers only the
  fixture. Neither is v1.
- **Phase two, kept: two `sync.test.ts` tests fail in the first days of a month.** A
  fixture bug, not a code one: the generator spreads walk-in sales evenly across the
  90-day window (`packages/connectors/src/fixture/generator.ts`), and on the 2nd of a
  month the "this month" sub-window holds no walk-in. Anchor the fixture to the period
  under test. It goes green on its own mid-month, which makes it worth fixing.
- **Superseded: the Cal.com scheduler decision and Boulevard/GoHighLevel OAuth wizards.**
  Google Calendar is the only write target; POS read-back is phase two.

### Known gaps, deliberately

- **"Recovered" is a reason, and `null` means we claim nothing.**
  `conversations.recovery_reason` records why a contact would have been lost
  (`after_hours`, `line_busy`, `rang_unanswered`); see architecture.md for how the
  coverage mode decides what counts. `missed_call_callback` is in the enum; v1 places no
  call-backs, so nothing in v1 sets it.
- **Booked value, never revenue.** v1 multiplies bookings by the clinic's own configured
  prices and labels it booked value. Revenue is `null`, never `0`, when unknown.
- **Job payloads carry ids only.** pg-boss owns its own schema, which has no `clinic_id`
  and no RLS. `assertNoPhiInPayload()` enforces an allowlist, not a pattern match.
- **A webhook URL contains a clinic id, and that is not a secret.** Authentication is the
  payload signature, checked against that clinic's own credential.
- **Google Business Messages was discontinued in July 2024** with no successor.
- **No Mindbody API**: its terms bar caching beyond 48 hours, aggregating with
  third-party data, and competing products. Mindbody clinics run manual booking mode.

### Running it

```bash
npm install
npm run db:up -w @healdesk/app     # Postgres in Docker, both roles, migrated
# export the four URLs it prints
npm run dev:web                    # marketing + checkout + /admin → :3000
npm run dev:app                    # apps/app                      → :3001
npm run queue:install -w @healdesk/app   # once per environment, as the migrator
npm run worker -w @healdesk/app    # the hourly tick, the queues, every job
npm test -w @healdesk/app          # database suites skip without TEST_APP_URL
```

`queue:install` is separate because pg-boss creates a schema, and CREATE is a privilege
the runtime role deliberately does not have. The worker is a plain Node entry point, not
a Next route. Every job ships switched off and is enabled from the ops console; the
`heartbeat` row is the liveness signal and `/api/health` reports its age.
[on-call.md](./on-call.md) is the runbook.

### Retention and offboarding

Two clocks per clinic, on the `clinics` row: `retention_media_days` (90) clears
transcript references; `retention_record_days` (90, never below a day) deletes
conversation, appointment, booking request and transaction rows and then contacts nothing
refers to. A booking request goes once every date on it is past the clock (when it was
made, the slot it was confirmed for, its appointment's time), and a shortened clock
reaches booking requests a day after it is set. Every request's id and token hash stay
in `booking_request_keys` after it is deleted, and are never written again.
`retention-purge` runs both nightly and writes one audit row per clinic with counts.
`baa_acceptances` has its own six-year floor.
Vendor-side retention (Retell's per-agent setting) is a setting, not a delete we run:
set it to the minimum and screenshot it. Single-patient erasure is `eraseContact()` in
`apps/app/src/lib/retention/purge.ts`. Set the host's snapshot retention to 35 days.

When Stripe sends `customer.subscription.deleted` (or an operator starts it), the clinic
gets `offboarding_started_at` and a `destroy_after` thirty days out, both stamped by the
database (`app_start_offboarding()`); the runtime role cannot write either. In between:
switch the clinic's voice agent off at the vendor and send it the forwarding-removal
codes, so its calls fall through to its own line; produce the return bundle with
`npm run patient-export -w @healdesk/app -- --clinic <id> --all --requested-by "…"`, hand
it over, and record it on the care page. `offboarding-destroy` deletes every patient row
once `destroy_after` has passed and the export is recorded (or 90 days after the start),
revokes the connections, and writes one security event. Export first, then destroy; the
BAA obligations persist until it is done.

### Logs

Every log line on the PHI side goes through `apps/app/src/lib/log.ts`, and
`tests/no-console.test.ts` fails the suite on a bare `console.*` anywhere else in
`apps/app/src`. The logger allowlists field keys and scrubs emails, phone-shaped numbers
and URLs with query strings out of free text. Log an id, then read the row inside
`withTenant()` if you need the thing. On AWS the log groups never expire (§4.2(c)); what
bounds a breach there is the allowlisted logger. There is no error tracker, on purpose.
Never put a patient identifier in a name: not in an S3 key, an RDS identifier, an ECS
task name, a queue name or a resource tag.

### Three database rules the audit taught us

- **A migration that writes to a FORCEd table must declare a tenant.** The migrator is
  `NOBYPASSRLS`, so `UPDATE conversations ...` with no `app.clinic_id` set matches zero
  rows and reports success. Loop over clinics with `set_config('app.clinic_id', id,
  true)`, or write the backfill as a `SECURITY DEFINER` function, and count the rows.
- **A new column on `clinics` needs its own `GRANT UPDATE`.** 0031 scoped the runtime
  role's UPDATE to a column list; column grants do not extend to columns added later.
  `tests/database-audit.test.ts` fails until the grant is added.
- **Nothing writes the two gate columns except `app_mark_clinic_production()`**, and
  nothing binds an agreement except `app_bind_agreement()`. Both are `SECURITY DEFINER`.
  Likewise only `app_start_offboarding()` and `app_mark_clinic_destroyed()` write
  `offboarding_started_at`, `destroy_after` and `destroyed_at`, from the database's clock,
  because `app_destroy_booking_requests()` reads them as its floor. A guard in a
  `SECURITY DEFINER` function binds nothing if it reads a column the runtime role can write,
  and that includes a column on another table and one it can set on INSERT: a new clinic
  is refused the three dates (`clinics_insert_guard`), and `app_purge_booking_requests()`
  reads a request's own frozen dates and the record clock in force, not an appointment's
  time or the setting alone. Where the runtime role can make a delete happen at all, make
  sure it cannot put the row back: `booking_request_keys` refuses a deleted request's id
  or token hash, and it is written at insert, so a re-insert racing the delete is refused
  too.

`apps/app/tests/rls-drift.test.ts` asks the catalog which tables carry a `clinic_id` and
demands each one have row-level security enabled **and forced**. If it goes red, someone
added a PHI table and forgot the policy.

### Operator sign-in

`/admin` on `apps/web` has one operator account: `HEALDESK_ADMIN_EMAIL`, a scrypt hash in
`HEALDESK_ADMIN_PASSWORD_HASH`, and a TOTP second factor whose secret lives in `apps/app`
(`lib/ops/admin-totp.ts`). There is no public sign-up. Clinic users sign in to the
portal in `apps/app`, which is not built
([policies/access-control.md](./policies/access-control.md) has its rules).

---

## Decisions log (21 September 2026)

The owner's decisions from 21 September onwards and what each became in code, reconciled
with the spec on 1 October 2026. Each says whether it still holds. Reopen one by changing
the code, not by re-asking.

1. **Overage rates — re-set on 5 October 2026: $0.80 a voice minute; $0.40 a chat
   conversation on the single-channel chat package, $0.30 on the rest** (replacing $0.35
   and $0.25), with the chat allowances cut to 1,000 / 2,000 / 1,000 / 2,000 and the top
   tier's voice to 1,000 minutes. Still provisional until measured (launch step 3.5).
   The billing mechanics stand: a monthly subscription carries the metered prices; an
   annual one carries none and its overage is invoiced by hand, monthly in arrears,
   until `annual-overage-invoicing` is built. Nothing bills against the meters until
   `usage-meter-events` is built. The spec: both rates are placeholders until measured
   cost times target margin sets them, and copy must say so.
2. **Refund window — 14 days, full refund of the first month's fee; the setup fee is
   never refundable.** `POLICY.refundWindowDays`. In code; the spec sends the refund
   window, and the first-month guarantee's wording, to counsel.
3. **Annual cancelled mid-term — no refund**, access to term end, auto-renew off.
   `POLICY.annualProRataRefund = false`. Holds.
4. **Cohort setup credit — keep.** One Stripe coupon per package, `amount_off` = that
   package's setup fee, `duration: once`, honoured only inside fourteen days of the
   Day 7 email, never from a URL parameter alone. Holds.
5. **Demo expiry — 7 days** (`DEMO_ACCESS_DAYS` in `apps/web/src/lib/consent.ts`).
   Holds.
6. **Reviews of healdesk — capture every rating, route internal follow-up by score,
   never gate what is published.** Holds. (Not patient review requests: v1 sends
   patients nothing.)
7. **Meta — a front door only, plus the booking hand-off. Superseded.** The Meta bot
   books and can send a payment link inside the 24-hour window; no clinical content or
   treatment names in any Meta message; the adapter drops sends outside the window.
8. **The revenue gate — awaiting the owner's call. Still open.** Whether to take money
   before counsel settles the covered-entity and CIPA posture (task
   `revenue-gate-decision`). Whatever is decided, no real patient data flows until the
   BAA chain in section 2 is complete.
9. **Home state — the Stripe facts. Holds.** The seller is Viixi FZC, a UAE free zone
   company trading as healdesk; governing law is Delaware. `ENTITY` in
   `apps/web/src/lib/legal.ts` and the constants in `packages/catalog/src/baa.ts`. The
   liability floor is none (item 10).
10. **Insurance — declined; "healdesk does not assume any responsibility". Holds.**
    Decided 21 September, revised 22 September. The terms and the BAA put every claim,
    defence cost and breach-notification cost on the practice to the fullest extent the
    law allows, with a twelve-months'-fees cap as the fallback, and say plainly that
    healdesk carries no liability insurance. What no paperwork can do: HIPAA makes a
    business associate responsible by statute, a penalty OCR assesses against healdesk is
    owed by healdesk, and patients signed nothing. Counsel must answer whether the
    one-way indemnity and exclusion survive before the 1.1.0 BAA is offered. Clinics that
    require a certificate of insurance are lost. Do not re-raise unless the owner does.
11. **Inbound only, and transcripts without audio. Holds in full again.** On 23 September
    the "no callbacks" half was reversed by item 17; the spec restores it. No outbound
    contact of any kind, no texts, no call audio kept (`recording_uri` dropped in 0038;
    the disclosure says the call is transcribed). The vendor still processes audio live
    to transcribe it, which is why transcription consent still matters.
12. **Why data is stored at all. Holds, amended for v1.** Transcripts and conversation
    rows are what the portal's Conversations screen shows and the v1 counts are built
    from; booking rows back the Bookings screen and booked value; the audit log is
    required by HIPAA §164.312(b) and is the accounting of disclosures; billing and
    agreement records are tax and contract evidence. The transaction rows (POS) are
    phase two. Consent records, suppressions and contact attempts were the outbound
    defence; v1 writes none. Not stored: audio, ad-platform identifiers, patient data in
    logs, and clinical content from a Meta channel.
13. **Every agent semi-confirms; the desk has the final say. Superseded.** "Auto-confirm
    bookings" is on by default, so the assistant books directly on every channel. The
    staff-approval path survives as the auto-confirm-off and manual-booking-mode path.
14. **The entity on the legal pages. Superseded in part.** The spec puts "healdesk is a
    service of Viixi FZC, a company registered under the Sharjah Publishing City Free
    Zone, United Arab Emirates" in the site footer and on the Terms and Privacy pages,
    because Meta Business Verification checks that the legal entity is visible on the
    website. The registered street address is not known: it is never guessed and renders
    only once filled in. The 23 September "name the entity once, never in the footer"
    rule no longer holds.
15. **The marketing store is a Google Sheet, not a database. Holds.** `apps/web` has no
    database client. Only the two site-wide daily spend caps are shared through the
    Sheet's `counters` tab; every other rate limit is per-instance memory
    (`apps/web/src/lib/rate-limit.ts` says why).
16. **PostHog on the US cloud. Holds.** Consent-gated, page views and named funnel steps
    only, no ad integration; `NEXT_PUBLIC_POSTHOG_KEY` is declared in `turbo.json`'s
    `build.env`.
17. **Booking hand-off, direct booking into Cal.com, AI callbacks, WhatsApp templates and
    the `/setup` link (23–29 September). Superseded.** Google Calendar is the only write
    target; v1 contacts no patient first, so there are no callbacks and no templates; the
    wizard and portal replace the setup link. The code is in the tree behind switches
    that stay unset (section 1). The minimum-information rule survives in the spec's
    form: name, callback number, requested service, preferred time. The counsel
    questions it raised are withdrawn except whether a direct-booking addendum is still
    needed (see [counsel-audit.md](./counsel-audit.md)).
18. **The v1 product spec (30 September 2026).** [v1-product-spec.md](./v1-product-spec.md)
    is the source of truth for what the product is, and the spec doc's Launch plan tab is
    the only task list. Voice on Retell; web chat; Meta (Instagram, Messenger,
    WhatsApp); inbound only; Google Calendar only; clinics sign in to a portal;
    attribution is phase two.
