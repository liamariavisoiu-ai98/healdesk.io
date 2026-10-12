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
| Healdesk to the database provider | AWS RDS under the agreement above, the owner's choice of 7 October 2026 over Neon; defined in `infra/aws`, not yet applied |
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

**Status, 12 October 2026.** The list is code: Terraform in `infra/aws`, applied by
`.github/workflows/infra.yml`, with `.github/workflows/deploy-app.yml` to build, migrate and
roll, a CloudFormation bootstrap stack, and [`infra/aws/README.md`](../infra/aws/README.md) as
the runbook. *Done in `infra/aws`* below means defined there and checked locally (`terraform
validate`, `terraform test` against mocked providers, tflint, checkov, cfn-lint, actionlint;
the images built and run against a local Postgres shaped like RDS). **Nothing is applied**, so
every item stays unproven until the owner's first `infra.yml` apply and first deploy.

- *Decide the database first:* **done.** RDS under this agreement, the owner's choice of
  7 October 2026 (`infra/aws/rds.tf`).
- *RDS:* **done in `infra/aws`:** storage encryption with our KMS key at creation;
  `rds.force_ssl=1`, with TLS 1.2 as the minimum; the `healdesk_app` (NOBYPASSRLS) and
  `healdesk_migrator` roles, created by the one-off db-bootstrap task with the RDS-safe
  `provision-roles.sql`, from passwords it generates inside AWS and sends to the server only as
  SCRAM verifiers; 35-day automated backups and no final snapshot; the RDS CA trusted in the
  container (the us-east-1 bundle in the image, `sslmode=verify-full` in both URLs, and production
  refuses a `DATABASE_URL` without it); the engine log terse, with no statement logged as it runs
  and no failing statement's text (`log_min_error_statement=panic`); Config rule
  `rds-storage-encrypted`. **Open:** the restore drill, by the steps in "Restoring" below and the
  runbook's "Restore drill" (a point-in-time restore to a new instance, checked by running
  db-bootstrap against it); it has not been run. **Built:** the after-restore destruction check
  (step 3 of "Restoring") as the one-off `destroy-due` task, the worker's container running
  `scripts/destroy-due.ts` (`infra/aws/scripts/run-task.sh destroy-due`). **Open:** putting a
  restored copy in production's place (the runbook's "Restoring production" gives the order and
  what is known, not a rehearsed procedure); step 2's dates go back through the CloudShell VPC
  environment as the migrator. **Built:** offboarding's return bundle on this host, as the one-off
  `patient-export` task, which puts it in the export bucket (`infra/aws/exports.tf`;
  `infra/aws/scripts/run-task.sh patient-export <clinic id>`); and the patient-rights scripts as
  `erase-person` and `amend-contact`, by contact id (see "Deletion requests" and "Amendments"). **Half built:** the alarm on any transaction open
  longer than five minutes, because one held open is the way left around the record clock's day
  and offboarding's thirty days (see "Retention and offboarding"). The alarm
  `healdesk-production-rds-idle-in-transaction` fires when a session has sat idle inside a
  transaction for more than five minutes (Performance Insights'
  `db.state.idle_in_transaction_max_time`, read by CloudWatch). It cannot see a transaction kept
  open by one statement running longer than five minutes: Performance Insights has no counter for
  an active transaction's age, so that half needs a check run inside the database
  (`pg_stat_activity.xact_start`) and is **open**. No timeout setting stands in for it, because
  one would kill the runtime role's transactions.
- *KMS:* **done in `infra/aws`:** one customer-managed key, `alias/healdesk-production`; a
  task-role policy limited to `GenerateDataKey`, `Decrypt` and `Encrypt` on it, in the two
  statements written out in `docs/design/google-calendar-2026-10-05.md` §5: the application's
  own calls, each only with both lock-label keys and no other in the encryption context and with
  no `kms:ViaService` (`kms_require_lock_labels`, true, Terraform-only: no app setting reads it);
  and S3's calls, `GenerateDataKey` and `Decrypt` only, through S3 (`kms:ViaService`
  `s3.us-east-1.amazonaws.com`) and for the transcript bucket alone
  (`kms:EncryptionContext:aws:s3:arn`, the bucket's ARN, since the bucket uses S3 Bucket Keys),
  present only while the bucket is switched on; a key policy that names the task role in no
  statement of its own, only the account statement that lets IAM decide;
  `HEALDESK_KMS_PROVIDER=aws-kms` and `HEALDESK_KMS_KEY_ID`, the key's full ARN
  (`arn:aws:kms:us-east-1:<account>:key/<key id>`), on the web and worker task definitions (the
  migrate task needs neither; db-bootstrap gets the ARN only to write its parameters), since an
  alias, a bare ID, a multi-Region key or another region is refused; `AWS_REGION=us-east-1`,
  since the KMS client refuses any other region; `@aws-sdk/client-kms` ships in the image (fixed
  6 October 2026). **Open:** reading the worker's start-up line ("credential key self-check
  passed") after the first deploy, to confirm the task role reaches the key with the lock labels
  required (the read-only ops operation `getCredentialKeyStatus` asks the web tier the same, but
  nothing in `/admin` calls it yet); the rotation runbook, drafted in the runbook's "Rotating
  secrets" (the key and `HEALDESK_IDENTIFIER_REF_KEY` never rotate) and not yet adopted or
  exercised.
- *S3:* **built in `infra/aws`, switched off** (`enable_transcript_bucket = false`), because no
  code uses S3 yet: a bucket in the designated region; SSE-KMS with our key and bucket keys; a
  policy denying non-TLS requests and uploads under any other encryption; Block Public Access;
  versioning, with superseded versions gone within 7 days, inside the 35 the agreement allows;
  current objects expiring at `transcript_retention_days` (90, the longest a clinic can keep
  them; the app deletes shorter ones itself from `clinics.retention_media_days`); CloudTrail data
  events on every object; no patient identifier in any key. Config rule
  `s3-bucket-ssl-requests-only` is on already and checks every bucket in the account. **Open:**
  the code that writes transcripts there, and switching the bucket on with it.
- *ECS on Fargate:* **done in `infra/aws`:** the web tier and the worker as services from one
  image, plus one-off task definitions for the migrations (as `healdesk_migrator`, before every
  rollout) and the role creation; a task role carrying only the KMS permissions (SES and S3 join
  when switched on); secrets from SSM Parameter Store, never the image, and none in Terraform's
  state (every parameter is created holding `__unset__`, which the image's entrypoint treats as
  unset; db-bootstrap generates the internal values, the owner pastes the vendor keys with
  `infra/aws/scripts/put-external-secrets.sh`); ECR; no PHI in names or tags; the worker run as
  one node process with `stopTimeout` at 60 s, above pg-boss's 30 s graceful stop. **Open:** the
  Retell voice endpoint (a long-lived WebSocket process; `infra/aws/ecs.tf` ends with a disabled
  placeholder listing what it needs). pg-boss stops with its 30 s default because
  `lib/queue/boss.ts` passes no `timeout`; a two-minute drain still needs `timeout: 120_000`
  there and a `stopTimeout` above it, and Fargate's maximum is 120 s.
- *Load balancer:* **done in `infra/aws`:** an HTTPS listener with one ACM certificate for
  `app.healdesk.io` and `app-internal.healdesk.io`, HTTP redirected, the health check on
  `GET /api/health?probe=liveness` (200 whenever the process is up; the plain path answers 503
  while a critical email is late, which is the uptime check's alarm, not a reason to replace a
  task), rate limiting on the host (a WAF rate rule that answers 429, never 403, because the
  Stripe relay drops any other 4xx), and the hop to the task re-encrypted by a TLS sidecar. The
  signed server-to-server routes are served only on the internal name, which is
  `HEALDESK_APP_URL` on Vercel and on the tasks, and refused on the public one. **Open:**
  WebSocket upgrades already pass through the load balancer and the sidecar, but the voice
  endpoint's own target group and listener rule wait for the voice process; the external uptime
  check (`docs/on-call.md`) is not set up.
- *CloudTrail:* **done in `infra/aws`:** on and kept (one multi-region trail, management reads
  and writes, KMS events included), encrypted with our key, log-file validation, Config rule
  `cloud-trail-encryption-enabled`; S3 data events on the transcript bucket whenever it is
  switched on.
- *CloudWatch Logs:* **done in `infra/aws`:** every log group created before anything writes to
  it, encrypted with our key and set to "Never expire" (§4.2(c)), the RDS engine log included;
  Config rule `cloudwatch-log-group-encrypted`.
- **SES sending. Built in `infra/aws`, switched off** (`enable_ses = false`): no v1 message is
  classed `may-carry-phi`. When switched on it creates the configuration set
  `healdesk-production-phi` with `TlsPolicy: Require`, the verified domain with its DKIM records
  at Cloudflare, `HEALDESK_SES_CONFIGURATION_SET` on the tasks and the task role's
  `ses:SendEmail` and `ses:GetConfigurationSet`. **Open:** `SesTransport` still throws with
  instructions; production access out of the SES sandbox; bounces and complaints wired to the
  clinic contact they belong to, never to patient suppression tables.
- **Not on the addendum's list, but needed before the first apply:** the owner's part of the
  first run in the runbook (the bootstrap stack, the Cloudflare token in Parameter Store, the
  GitHub variables, `infra.yml`, the vendor keys, the first deploy with `bootstrap_db`, Vercel's
  `HEALDESK_APP_URL` and `HEALDESK_PROVISION_SECRET`).
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
a Next route. Jobs are enabled from the ops console, and most ship switched off, with
these exceptions. `heartbeat` and `incident-deadlines` ship on (0066 seeds the latter
on). `retention-purge` and `offboarding-destroy` run for every clinic whose agreement
states what they do, whatever their switch, which only adds the other clinics: BAA
1.3.0 and the DPA today, read from each version's own text (`purgeIsPromised`,
`exportRuleIsPromised`; switched off, each run's note says so). And four sweeps have no
switch at all: `erasure-expiry`, `booking-request-expiry`, `welcome-email` and
`booking-requirements-defaults`. The `heartbeat` row is the liveness signal and
`/api/health` reports its age.
[on-call.md](./on-call.md) is the runbook.

### Retention and offboarding

Two clocks per clinic, on the `clinics` row: `retention_media_days` (90) clears
transcript references; `retention_record_days` (90, never below a day) deletes
conversation, appointment, booking request and transaction rows and then contacts nothing
refers to. A booking request goes once every date on it is past the clock (when it was
made, the slot it was confirmed for, its appointment's time), and a shortened clock
reaches booking requests a day after it is set. Every request's id and token hash stay
in `booking_request_keys` after it is deleted, and are never written again. The day, and
offboarding's thirty, run from when the change is written (`clock_timestamp()`, not the
start of its transaction), and saving the clock's current value again restarts nothing.
What SQL cannot see is when a transaction commits: one that shortens the clock or starts
offboarding and then stays open for the day (or the thirty) commits a change whose wait
has already run, holding the clinic's row locked all that time. The long-transaction
alarm in the AWS list is what catches it, and only half of it is built (see there).
`retention-purge` runs both nightly and writes one audit row per clinic with counts.
The same purge deletes a messaging thread (`chat_threads`) thirty days after its last
message (sooner if the record clock or the portal's transcript period is shorter), a
vendor payload (`webhook_events`) thirty days after it arrived once processed (or at the
record clock, if shorter) and at the record clock if it was never processed, and either
kind of payload no later than the transcript period, since a call's payload carries its
transcript, and an amendment with the record it amends. `lib/retention/purge.ts` lists
each period as BAA 1.3.0's clause 11 states it.

Which clinics: a clinic whose agreement states the purge's periods is purged every night
whether the job's switch is on or not (`purgeIsPromised`, which reads each version's own
retention clause: BAA 1.3.0 and the DPA today, and any later version only if its text
says so); the switch adds every other clinic, those on 1.2.2 or earlier and any with no
agreement. **At the release of 1.3.0, switch `retention-purge` on** in the
ops console (Jobs), so the clinics still on 1.2.2 or 1.2.1, whose agreement promises ninety days
too, are purged as well, and check that the next 03 UTC run's note no longer begins
"Switched off". A sync run (phase two) holds a clinic's purge only while it is younger
than six hours, so a crashed one cannot hold it for good, and the purge runs again at
09 UTC, so a clinic whose 02 UTC sync held it at 03 is purged the same day. `baa_acceptances` has its own six-year floor.
Vendor-side retention (Retell's per-agent setting) is a setting, not a delete we run:
set it to the minimum and screenshot it. Deleting one person on request is
`npm run ops:erase-person -w @healdesk/app`, in the app's own shell ("Deletion
requests", below). Set the host's snapshot
retention to 35 days.

When Stripe sends `customer.subscription.deleted` (or an operator starts it), the clinic
gets `offboarding_started_at`, the end of its service, and a `destroy_after` thirty days
on, both stamped by the database (`app_start_offboarding()`); the runtime role cannot
write either. For a Stripe deletion the end is the subscription's own (`ended_at`), which
the database accepts up to a week back, so a deletion processed late still starts the
clock when the practice left; one processed more than a week late starts it a week back
and raises the `offboarding_started_late` ops alert. When the data goes is the rule of
the agreement the service ended under, terminated since or not (`destructionPlan` in
`apps/app/src/lib/offboarding/offboarding.ts`; `app_destruction_due()` in drizzle/0058 is
the same rule as the database's floor):

- BAA 1.2.2 and earlier, or no agreement on file: day 29, whatever the export, so the data
  is gone before the thirty days the agreement gives. Every leaving practice is owed its
  export whether or not it asks (Terms §7; the canceled email tells it one is coming,
  though these agreements give it only "on request"), so deliver it and record the
  handover before then; ops is alerted at day 21 when none is recorded
  (`export_undelivered_before_destruction`).
- BAA 1.3.0 and the DPA: day 29 once the export is recorded as delivered, its delivery
  when that is later, and day 89 whatever happens, each a day inside the thirty days and
  the ninety that BAA 1.3.0 states. Record the delivery by day 29: one recorded later is
  destroyed at the next hourly run, which in the thirtieth day's last hour can fall after
  the thirty days.

The destruction steps, in order:

1. Switch the clinic's voice agent off at the vendor and send it the forwarding-removal
   codes, so its calls fall through to its own line.
2. Produce the return bundle with `npm run patient-export -w @healdesk/app -- --clinic
   <id> --all --requested-by "…"` (on the AWS host: `bash run-task.sh patient-export
   <clinic id>` in CloudShell, which stores it in the export bucket), hand it over, and record the handover on the care
   page. Producing it records nothing: the care page refuses the record until a bundle
   has been produced since offboarding started, and the stamp is the database's, at the
   moment of the record (`app_mark_export_delivered()`).
3. Delete the clinic's calls and agent in Retell's console by the time its data is
   destroyed here, and record it on the care page ("Record Retell deletion"). Nothing in
   apps/app reaches Retell; the care page shows the step outstanding, with its deadline,
   until it is recorded, after destruction too.
4. `offboarding-destroy` runs every hour and, on the day the rule gives, deletes every
   patient row, suppressions, consent records and contact attempts included, revokes the
   connections, and writes one security event and one `clinic data destroyed` log line.

Export first, then destroy; the agreement's obligations persist until it is done.

### Deletion requests

BAA 1.3.0's clause 4(c) and the DPA's state-law clause (item c): when the practice tells
us to delete a person's information, we delete it from our own records within ten
business days, raw copies from other services included, have each subcontractor that
holds it delete it in time, let our backups age it out within 35 days, and keep only a
record of the request, no longer than we need it.

1. **Who may ask.** The practice, and only the practice. A request the person makes to
   us directly is passed to the practice within five business days, and our reply to
   the person says we cannot act on it and have passed it on (the patient-rights
   clause); we never contact the person afterwards.
2. **Verify it.** Act on a request that comes from the practice's notice address (the
   one email address on its account, which is the agreement's notice address), or one
   confirmed from it: reply there, or call the practice's published number, before
   acting on a request from anywhere else. The request names the person by the
   telephone number and/or email address they gave the practice's assistant. Never ask
   for, or write down, their name.
3. **Run it for each location, never on the care page.** A deletion reaches one
   location: each of a practice's locations is its own clinic here, with its own
   contacts, calls and requests, so run it once for every location the person may have
   used, with that location's clinic id (and, on the AWS host, that location's contact
   id). The person's number and address must not cross
   apps/web, which runs on a host with no business associate agreement, so the deletion
   is a script in apps/app (`npm run ops:erase-person -w @healdesk/app`;
   `erasePersonFromShell` in `apps/app/src/lib/ops/patient-entry.ts`):
   - **on the AWS host: by contact id, through run-task.sh only.** It runs as a one-off
     task of the app's image with only ids and closed choices in its environment:
     `HEALDESK_ERASURE_CLINIC_ID`, `HEALDESK_ERASURE_CONTACT_ID`,
     `HEALDESK_ERASURE_REQUESTED_BY` (`practice`, `person_via_practice` or
     `representative_via_practice`), optionally `HEALDESK_ERASURE_RECEIVED_AT` (ISO),
     and `HEALDESK_OPS_OPERATOR` (your healdesk address), set by `bash run-task.sh
     erase-person <clinic id> <contact id> <who asked> <you@healdesk.io> [received at]` in
     CloudShell. The person is whoever that
     contact's number and address lead to, read inside the transaction. Nothing about
     the person is typed or passed: there is no interactive shell there, and run-task's
     overrides are recorded by CloudTrail ("Reaching the app's shell", below). **Nothing
     on AWS turns a number into a contact id yet**: the ops console does not show one,
     and the route, a deletion request the practice files in its portal behind step-up,
     waits for M5. Until then a deletion on the AWS host needs a contact id from the
     practice's own records;
   - **on a development machine, against a development database:** the same as
     arguments (`--clinic`, `--contact`, `--requested-by`, `--received-at`,
     `--operator`), or, without `--contact`, the number and the address typed at the
     prompt, one per line, never on the command line (the script refuses a number or an
     address in any argument, and refuses the prompt where `NODE_ENV` is production).

   Who asked is one of three, chosen, never typed; the deadline runs from the received
   time, or now. One transaction, with the same log line and security event the
   console's form wrote, and it prints the request's id, the deadline and counts. Who the person is:
   the number and address the practice gave, plus every number and address on a
   contact either one matches (one step, never a chain); every contact carrying any of
   those is theirs, and goes whole, so a second contact that shares their number goes
   with its calls even when the practice gave only the address. The reply says how
   many numbers and addresses that came to. What goes: the person's contacts, calls,
   appointments, payments matched to them, the deposits of their appointments (our
   copies, with the Connect event that last touched each; the charge stays the
   practice's record in its own Stripe account), every booking request that names
   them, their half-collected Meta drafts, their own messaging threads, the raw
   payloads the voice vendor or another service sent about them, the conversation of a
   call with no caller ID whose payload named them, and their suppressions, consent
   records and contact attempts. A booking request that names someone else stays, even
   one the person sent: a messaging thread is theirs only when everything it sent
   named them, and a thread that also booked for others (a parent booking for a child
   and for themselves) keeps what it sent for them, with its draft and its thread.
   Unless the thread is on the person's own number, as every WhatsApp thread is: then
   its requests for the others stay without the thread (no sender id, no message id;
   the desk calls the number on the request), and its draft and its row go. The reply
   counts what was kept that way, and how many lost their thread, never who; tell the
   practice those requests stay as the other people's records. The care page then
   lists the request, its deadline and its subcontractor steps, and nothing that
   names the person.
4. **The subcontractor steps.** The care page lists each one outstanding, with the
   deadline, until it is recorded. Retell: in Retell's console, find and delete the
   person's calls and transcripts by their number, then record how it went on the care
   page, one of two choices ("Deleted in the vendor's console", "The vendor held
   nothing for the person"), never typed. Retell is the only voice vendor with a step:
   **no real patient call may go through Synthflow**, which still carries the owners'
   demo calls and has no deletion step here, so a deletion could not reach its copy. Anthropic is not
   a step: what it keeps it keeps under the exception clause 4(c) names, for the period
   the Subcontractors clause states. AWS is our database and its backups, which the
   deletion and the 35-day backup window reach. Meta and Google Calendar are the
   practice's own services: tell the practice it may delete the person's messages in its
   own inboxes and their events in its own calendar.
5. **The deadline.** Ten business days (Monday to Friday, counted in UTC) after the
   request reached us, for the deletion here and every subcontractor step; the care page
   shows it and marks it overdue.
6. **The reply.** On the practice's own thread, so it names no one: the date we deleted
   the information, the date each subcontractor deleted its copy, and that copies in
   our encrypted backups expire within 35 days of the deletion. Keep the thread (it holds
   the number) until the record's restore references expire, 35 days after the
   deletion, as the fallback a restore after a total loss needs (below), and for nothing
   else, then delete it from the mailbox and its trash. The DPA's Clients' requests
   clause says exactly this: the practice's own message, for those 35 days, used only to
   delete the information again after a restore. Copy nothing from it anywhere else:
   "who asked" on the care page is chosen from three (the practice; the person, through
   the practice; a legal representative, through the practice), never typed.

What it cannot find. A call with no caller ID creates no contact, so nothing ties it to
the person by number: the deletion finds such a call only if the practice names its
number and the vendor's payload carries it. Then its conversation goes with the
payload, unless someone's contact is on it or someone else's booking refers to it. Raw payloads are searched string by string (a
JSON body is decoded first; any other body is read as text) for the number and the
address matched whole: the address with no address character before it or domain
character after it, the number in its international form and, for a North American
number, its ten digits without the country code but never right after another
country's "+" code, with spaces, dots, dashes or brackets between the digits; another
country's number is found only in its international form.
Tell the practice when it asks about a call it believes had no caller ID.

Known limits, as specified (second review, 12 October 2026):

- **One step, not a chain.** The person's numbers and addresses are the ones given and
  those on the contacts they match, and no further. Contacts C1 {number P, address E1},
  C2 {P, E2} and C3 {E2}: erasing E1 takes C1 and C2 (through P) whole, but not C3, and
  not the raw payloads that carry only E2. Run a second deletion for E2 if the practice
  says it is the same person.
- **A Meta request reuses a contact by number.** A parent who books for a child with
  the parent's own number makes one contact for both (`lib/meta/booking-requests.ts`),
  so erasing either takes the other's requests with that contact.
- **Amendment words** are refused when they carry ten digits or more with up to two
  separators between them, or an address. A number written with wider separators ("555
  - 013 - 0001"), with slashes or in words gets through, and a run of figures such as
  "1200 1300 1400" is refused. Never write a number into an amendment; correct the
  contact instead.

What is kept: one `erasure_requests` row, with who asked (one of three), the dates, the
counts and the subcontractor stamps, and no number, address or name; and, for 35 days,
the practice's message in the mailbox (step 6). Its `restore_refs` are keyed
references to what the deletion found, used only by `npm run reapply-erasures` after a
restore. The hourly `erasure-expiry` sweep in the worker empties them 35 days
(`BACKUP_RETENTION_DAYS`) after the deletion, when no backup that held the person is
left, and deletes the row then too, or as soon as its last subcontractor step is
recorded. It is not a switched job. Nothing reads the record to decide whether to
contact anyone: v1 contacts no one first, and an erasure no longer writes the number
into `suppressions`, which was the do-not-contact list. Destruction at offboarding
deletes the clinic's records with the rest. The `person data erased` log line (clinic,
request id, count) is the record outside the database.

### Amendments

BAA 1.3.0's clause 14(b) and the DPA's Clients' requests clause: healdesk incorporates any
amendment the practice directs. Where the record can be changed, we correct our own
copy; where a record must stay as it was made, a booking request or the record of a
conversation, we append the amendment to it and link the two, and every later use and
export of that record carries it. An appointment takes an appended amendment too: it is
the booking as the practice's calendar holds it, which a sync or a reschedule moves, so
a correction of its service, practitioner or time is appended beside it, never written
over the calendar's.

1. **Who may direct one.** The practice, from its notice address, verified as for a
   deletion request. A patient who asks us directly is passed to the practice within
   five business days (docs/incident-response.md, "Patient rights requests").
2. **Find the record.** Produce the patient's export (`npm run patient-export`) and read
   the id of the contact, booking request, appointment or conversation the practice
   means. Ask the
   practice, never the patient, when it is not clear which.
3. **Record it, never on the care page.** The practice's words and a contact's details
   must not cross apps/web. Two scripts in apps/app (`lib/ops/patient-entry.ts`):
   - `npm run ops:amend-record -w @healdesk/app` appends an amendment to a booking
     request, a conversation or an appointment: `--clinic`, `--operator`, `--kind`
     (`booking_request`, `conversation` or `appointment`), `--record` (its id),
     `--requested-by` and optionally `--requested-at`, then the practice's words, one
     line, at the prompt. It is written to `record_amendments`
     (`apps/app/src/lib/patient-rights/amendments.ts`) and never changed afterwards; a
     later correction is another amendment beside it. The words never carry a telephone
     number or an email address (the script and the database refuse them): an amendment
     can sit on someone else's record, where deleting that person would never find it;
   - `npm run ops:amend-contact -w @healdesk/app` corrects a contact's name, number or
     address in place, or clears one: `--clinic`, `--operator`, `--contact`,
     `--requested-by` and optionally `--clear fullName,phone,email`, then the corrected
     name, number and address at the prompt, one per line (a blank line leaves that
     field as it is; a field is cleared only when `--clear` names it). The audit row says
     which fields changed and who asked, not what they said.

   Who asked is one of three, chosen, never typed. Each script refuses a number or an
   address on its command line, prints ids only, and writes the same audit row, log
   line and security event the console's forms did. **On the AWS host:** an amendment's
   words and a contact's corrected details are themselves patient data, so they can be
   neither typed there nor passed in a run-task override; they wait for the M5 portal,
   which takes them from the practice behind step-up. The one correction that runs
   there is clearing fields, by contact id, through run-task.sh only, with
   `HEALDESK_AMEND_CLINIC_ID`, `HEALDESK_AMEND_CONTACT_ID`, `HEALDESK_AMEND_CLEAR`,
   `HEALDESK_AMEND_REQUESTED_BY` and `HEALDESK_OPS_OPERATOR` in the task's environment, set by
   `bash run-task.sh amend-contact <clinic id> <contact id> <fields to clear> <who asked>
   <you@healdesk.io>` in CloudShell.
   Typed entry is for a development machine and its database only. The care page shows
   how many amendments and corrections the clinic has, and nothing they say.
4. **The deadline.** Ten business days from the practice's request.
5. **The reply.** On the practice's own thread: the date it was done, and that every
   export of the record now carries the amendment. A fresh export shows it under
   `amendments` beside the request or conversation.

An amendment lives exactly as long as the record it amends: the erasure, the purge and
destruction delete it with that record, in the same function, and nothing deletes it
on its own (drizzle/0064). The portal (M5) must show amendments beside every record it
shows or exports.

### Reaching the app's shell

There is no interactive shell on the AWS host, by design: ECS Exec is off
(`enable_execute_command` is false; infra/aws/README.md lists it as deliberately not
built, since "it would put a root shell on a container holding PHI"), a Fargate one-off
task started by `infra/aws/scripts/run-task.sh` has no stdin, and RDS is private with no
bastion, so no laptop reaches it. And run-task's command and environment overrides are
recorded by CloudTrail. So on the AWS host: by contact id, through run-task.sh only.

- `ops:erase-person` runs as a one-off task with `HEALDESK_ERASURE_CLINIC_ID`,
  `HEALDESK_ERASURE_CONTACT_ID`, `HEALDESK_ERASURE_REQUESTED_BY`, optionally
  `HEALDESK_ERASURE_RECEIVED_AT`, and `HEALDESK_OPS_OPERATOR`.
- `ops:amend-contact` runs as one only to clear fields, with `HEALDESK_AMEND_CLINIC_ID`,
  `HEALDESK_AMEND_CONTACT_ID`, `HEALDESK_AMEND_CLEAR`, `HEALDESK_AMEND_REQUESTED_BY` and
  `HEALDESK_OPS_OPERATOR`.
- `ops:amend-record`, and a correction with new values, do not run on AWS: the words
  and the details are patient data. They wait for the M5 portal, which takes them from
  the practice behind step-up.

**Open items.** run-task.sh runs `erase-person` and `amend-contact` as one-off tasks.
The operator needs a contact's id without the person's details crossing any channel,
and nothing shows one: the ops console does not, and the clean route is a
deletion request the practice files in its portal behind step-up (M5), which yields the
request's or the contact's id for the task's environment. Until M5 there is no such
route on AWS: finding a contact's id from a number would mean typing the number there.
No real patient data exists before BAA coverage, so this blocks nothing yet, but it
must close before the first live clinic. On a development machine the scripts run as
above, with the prompt, against a development database.

### Restoring

Restore from the host's physical snapshot or point-in-time recovery, or from a full
`pg_dump` of schema and data, in which the triggers are created after the data. A
data-only load into a migrated schema (`pg_restore --data-only`, or a `\copy` of one
table) fires two BEFORE INSERT triggers from 0054 that refuse it: `clinics_insert_guard`
refuses every offboarded or destroyed clinic, and `booking_requests_keys_once` refuses
every booking request whose key is already there, which is all of them, since
`booking_request_keys` sorts ahead of `booking_requests` in a dump. A third, 0063's
`erasure_requests_guard`, does not refuse but restamps every deletion request's
`erased_at` with the moment of the load, which would keep its restore references longer
than the backup window and move the line `reapply-erasures` draws between what the
person gave before the deletion and after it; 0064's `record_amendments_guard` likewise
restamps every amendment's `recorded_at`. For such a load the owner disables all four
by name, loads every table, `booking_request_keys` included, and enables them again, in
one transaction:

```sql
BEGIN;
ALTER TABLE clinics DISABLE TRIGGER clinics_insert_guard;
ALTER TABLE booking_requests DISABLE TRIGGER booking_requests_keys_once;
ALTER TABLE erasure_requests DISABLE TRIGGER erasure_requests_guard;
ALTER TABLE record_amendments DISABLE TRIGGER record_amendments_guard;
-- the data-only load
ALTER TABLE clinics ENABLE TRIGGER clinics_insert_guard;
ALTER TABLE booking_requests ENABLE TRIGGER booking_requests_keys_once;
ALTER TABLE erasure_requests ENABLE TRIGGER erasure_requests_guard;
ALTER TABLE record_amendments ENABLE TRIGGER record_amendments_guard;
COMMIT;
```

(`pg_restore --data-only --disable-triggers` does the same for every table, foreign keys
included, but only as a superuser, which RDS does not give.) Then check that both
triggers and `clinics_record_clock` read `tgenabled = 'O'` in `pg_trigger`, the check
0054 ends with, and that every booking request has its key, counting clinic by clinic
inside each clinic's tenant as 0054's backfill does (`booking_requests` is FORCEd): a
request loaded without its key could be deleted and written again with another decision.
`tests/booking-request-destruction.test.ts` runs these steps.

A restore brings back every clinic as it was at the point restored to, so a clinic
destroyed since comes back with its patients, and a person deleted since comes back
with their records. After any restore, of any kind, destruction and every deletion
request run again before the service reopens:

1. Keep the web tier, the worker and the voice process stopped. The worker runs the
   hourly expiry of deletion records, so stopping it keeps every record's restore
   references while the restore is in progress.
2. Read the `clinic data destroyed` log lines written after the point restored to (the
   log groups never expire). Each names a clinic and the dates it was destroyed on:
   `serviceEndedAt`, and `exportDeliveredAt` when its export had been delivered. For each
   clinic named that comes back without `destroyed_at`, the owner, as the migrator, puts
   back any of those dates the restore lost: `offboarding_started_at` to `serviceEndedAt`
   and `destroy_after` thirty days later, and `export_delivered_at` to
   `exportDeliveredAt`. With its dates back it is due again by the rule it was destroyed
   under; without them it would not be offboarding at all, or, on BAA 1.3.0 or the DPA
   without its delivery, not due again until day 89.
3. Run `npm run destroy-due -w @healdesk/app` against the restored database with the
   runtime role's `DATABASE_URL`. It destroys every clinic that is due, on every rule at
   once, whether or not the `offboarding-destroy` job is switched on, and exits non-zero
   while any clinic is still due.
4. Put back the deletion requests the restore lost. A restore to a point before a
   deletion loses that deletion's `erasure_requests` row with it, and the row is what
   finds the person again. RDS restores into a new instance, so while the old one still
   exists, copy its `erasure_requests` rows into the restored one as the owner, clinic by
   clinic inside each clinic's tenant (the table is FORCEd), with
   `erasure_requests_guard` disabled as above so each keeps its `erased_at`. If the old
   instance is gone, the `person data erased` log lines written after the point restored
   to name each request lost (clinic and request id): run each deletion again from the
   practice's request, which the mailbox keeps for those 35 days ("Deletion requests").
5. Run `npm run reapply-erasures -w @healdesk/app` with the runtime role's
   `DATABASE_URL`. For every deletion whose record still holds its references, it finds
   the person in the restored data and deletes what was recorded no later than the
   deletion ran, so anything they gave afterwards stays, and writes no new record. It
   exits non-zero if any clinic could not be done.
6. **Amendments and corrections.** A restore to a point before an amendment or a
   contact correction loses it, and its security event, which sits in the same
   database. Read the `record amended` and `contact corrected` log lines written after
   the point restored to: each names the clinic and the amendment or contact, and when,
   never the words. For each, ask the practice, on its own notice address, to send the
   amendment or correction again, and record it as on the first day ("Amendments"),
   within ten business days of its reply. While the old instance still exists, its
   `record_amendments` rows can be copied over instead, as the owner inside each
   clinic's tenant, with `record_amendments_guard` disabled as in step 4 so each keeps
   its `recorded_at`; a contact correction cannot be copied, because the restored row
   is the old one, so it is always asked for again.
7. Only then reopen the service.

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
  Likewise only `app_start_offboarding()`, `app_mark_export_delivered()` and
  `app_mark_clinic_destroyed()` write `offboarding_started_at`, `destroy_after`,
  `export_delivered_at` and `destroyed_at`, from the database's clock, because
  `app_destruction_due()` reads them as the floor under the deletes. A guard in a
  `SECURITY DEFINER` function binds nothing if it reads a column the runtime role can write,
  and that includes a column on another table and one it can set on INSERT: a new clinic
  is refused the four dates (`clinics_insert_guard`), and `app_purge_booking_requests()`
  reads a request's own frozen dates and the record clock in force, not an appointment's
  time or the setting alone. Where the runtime role can make a delete happen at all, make
  sure it cannot put the row back: `booking_request_keys` refuses a deleted request's id
  or token hash, and it is written at insert, so a re-insert racing the delete is refused
  too. Nor may a guard's days depend on its caller: any role may set its own session's
  `TimeZone`, and Postgres counts `interval 'N days'` and `make_interval(days => n)` in
  that zone, so one with offsets 334 hours apart once turned the destruction clock's seven
  days into twenty-one. The functions that count days for the destruction clock, its floor
  and the record clock carry `SET TimeZone = 'UTC'` (drizzle/0058), and the tests call each
  under such a zone; a new guard that counts days needs the same.

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
