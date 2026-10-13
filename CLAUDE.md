# healdesk.io

One AI assistant for cash-pay elective clinics, sold as three inbound-only
products that launch together: an AI voice agent (on Retell), a web chat widget
on the clinic's own site, and a Meta bot covering Instagram, Facebook Messenger
and WhatsApp.

npm workspaces monorepo, Turborepo. `apps/web` (marketing + operator console),
`apps/app` (the product), `packages/{catalog,connectors,leadgen}`.

**What v1 is lives in [`docs/v1-product-spec.md`](./docs/v1-product-spec.md).**
It is the source of truth for what the product does, how it behaves, what it
cannot do and what it may claim. It is exported verbatim from the doc at
https://claude.ai/artifact/F7bKioXheMJwn5Epc65bVQ: never edit the export; change
the doc and re-export. The live task list is that doc's "Launch plan" tab, not a
file in `docs/`. If a repo doc, a comment or a plan disagrees with the spec about
what the product is or does, the spec wins. This file still decides **where code
goes**.

The spec's "admin portal" is the **clinic portal** in `apps/app`. The repo's
`/admin` is **our operator console** in `apps/web`. They are different surfaces
for different people; never conflate them.

---

# THE PHI BOUNDARY — read this before adding any surface

Every placement decision in this repo follows from one split. Getting it wrong
is not a style mistake: it is the difference between a compliant architecture
and an uncovered hop through a vendor who signed no business associate
agreement.

`docs/hipaa-compliance.md` is authoritative for **what PHI is**. This file is
authoritative for **where code goes**. The spec's "What data actually moves"
table is the inventory of what v1 handles.

## The test

> Does this handle **a patient's identity attached to health information**?

The line is the individual, not the industry. A clinic owner's own name, work
email and title are **business contact data**, not PHI — that is why checkout,
the contact form and the reviews all sit on the no-PHI side. A caller's phone
number *plus the treatment they asked about* **is** PHI.

## Where things go

| `apps/web` — NO PHI (Vercel) | `apps/app` — PHI (BAA-covered host) |
| --- | --- |
| Marketing, pricing, specialty/SEO content | Every patient conversation: the Retell custom-LLM WebSocket endpoint, the web chat widget's API, the Meta webhooks and send adapters |
| Chat + voice demos (they talk to *owners*) | Call and chat transcripts, which are emailed to the clinic through SES when the conversation ends; the only copy is the sealed outbox row, deleted seven days after it first goes (owner, 13 October 2026; no call audio is kept) |
| The demo's scraped clinic profile (business data) | Bookings: Google Calendar availability and writes, slot holds, the manual-booking queue |
| Checkout, Stripe, BAA signing UI, download | Deposit links through the clinic's own payment gateway |
| Contact form, reviews (business contacts) | The clinic portal, the onboarding wizard and the portal support chat |
| The `/admin` operator console | The BAA register itself + retention clock |
| Anything public, cached, indexed | Clinic credentials: Google Calendar tokens, Meta Page and WhatsApp tokens, the gateway connection |
| | The background worker; anything writing an audit row |
| | Phase two, fenced out of v1: **the attribution engine**, POS/EMR read-back, sync and reconciliation, the connectors |

The widget's script file is static and can be served from anywhere; every
request that carries a visitor's words goes to `apps/app`.

## The shortcut that is always right

**If it needs the database, it goes in `apps/app`.**

`apps/web` has no database client at all — no Drizzle, no `pg`, no connection
string, and it must stay that way. That single fact is what makes the boundary
enforceable rather than aspirational.

## The three cases that catch people out

1. **The attribution engine is inside the boundary.** It is also phase two: the
   code is kept, but fenced out of v1 flows and claims (see "Product rules the
   code enforces"). It feels like analytics, so it feels like it belongs next
   to a dashboard. But reconciling *who showed and what they spent* means named
   patients and their procedures. Anything read back out of a clinic's EMR/POS
   is inside too.

2. **The demos are on the no-PHI side only because of who they talk to.** They
   serve clinic owners from a generic knowledge tree or, for a personalised
   demo, from the clinic's public website, and the demo calls run on Retell
   demo agents (Synthflow was replaced on 5 October 2026). The product's voice
   agent answers real patients, so it belongs in `apps/app`, built on Retell:
   Retell opens a WebSocket per call to a Healdesk-hosted Claude endpoint
   (`src/voice/server.ts`, `lib/voice/retell.ts`, built 13 October 2026), and
   everything the agent says and every request it takes runs there. `/api/callback` only *places* a demo call an owner asked for; it
   is not a patient call-back, and v1 never contacts a patient first. If AYA,
   the demo persona, ever answers a real patient, that path is PHI and moves to
   `apps/app`.

3. **`/admin` on `apps/web` is deliberate, not a shortcut.** It is our tool,
   not a clinic's — and note how it gets its data. Clinics use a different
   surface, the clinic portal in `apps/app`. `/admin` must never be exposed to
   a clinic.

## The pattern to copy when `apps/web` needs PHI-side data

It does not get a connection string. It asks `apps/app` over an HMAC-signed
request, and `apps/app` decides what to return:

- `apps/web/src/lib/admin/ops-client.ts` → `POST /api/ops` on `apps/app`
- The reply is a hand-written projection — clinic configuration, scheduler
  state, contract metadata. Never a patient row.
- Every clinic-facing link is composed upstream in `apps/app` from
  `BETTER_AUTH_URL`: today the one-time `/connect/` and `/booking/` links
  (`lib/ops/api.ts`, `lib/meta/booking-requests.ts`), and in v1 the magic
  sign-in link and the wizard-resume link in the welcome email. That is because
  `HEALDESK_APP_URL` is an internal origin that must never appear in a browser
  (the comment on the connect URL in `ops-client.ts` explains it).

Add a new operation to the ops envelope rather than widening what crosses. The
same holds in the other direction: when the demo's scraped clinic profile has to
reach the wizard (the spec's "never ask twice"), send it to `apps/app` as
business data inside a signed request, such as the provision request, rather
than giving `apps/web` anywhere new to keep it.

## Rules that keep `apps/app` portable

Vercel signs BAAs **only on Enterprise**. Two projects give the correct
architecture split, not coverage — so `apps/app` must be able to leave.

- ❌ No `@vercel/*` runtime packages
- ❌ No `export const runtime = 'edge'` on anything touching PHI
- ❌ No Vercel-only headers, geolocation, or cron as load-bearing logic
- ✅ Plain Node, `pg` + Drizzle over `DATABASE_URL`, `output: "standalone"`
- ✅ Config from environment variables only

If it would not run under `node server.js` in a container, it does not belong
in `apps/app`.

**Until BAA coverage is in place, `apps/app` must not receive real patient
data.** Synthetic and seed data only. Coverage means every link in the spec's
chain: the clinic's BAA (accepted inline at checkout), Retell, Anthropic, the
database provider and AWS. Meta and Stripe never sign one; they are handled by
scoping, not paperwork (see "Product rules the code enforces").

### `apps/app` is portable but NOT currently deployable

Audited 2026-09-12; re-checked against the code 2026-09-30; the AWS host was
written on 2026-10-07 and reworked after its review on 2026-10-12. The rules
above all pass — no `@vercel/*`, no edge, plain Node. The host is code in
`infra/aws`, for account `865780386982` in `us-east-1`: Terraform for ECS on
Fargate behind one load balancer, RDS for PostgreSQL 17, one KMS key, SSM
Parameter Store, CloudTrail, Config, GuardDuty, SES and alarms; a
CloudFormation bootstrap stack; and two workflows, `infra.yml` (plan, apply)
and `deploy-app.yml` (build, migrate, roll, restart, roll back). Since 13
October 2026 it builds the owner's lean profile by default, about $70 a month
running: one ARM64 web task of a quarter vCPU carrying the worker too
(`worker_placement`), a `db.t4g.micro`, a NAT instance instead of a NAT
gateway (`nat_mode`), and the WAF off (`enable_waf`); each is one variable
from the shape first built (README, "Costs").
`infra/aws/README.md` is the runbook. **Whether it is applied is unsettled.**
The owner reported on 13 October 2026 that the bootstrap stack is launched, the
external secrets pasted, the alarm email confirmed and the Vercel variables
set; but GitHub's record that day shows one `infra.yml` run, a plan with its
apply skipped (on 719b584, before the lean profile), and no `deploy-app.yml`
run at all, and `put-external-secrets.sh` refuses a parameter an apply has not
created. Check the account (the ECS cluster `healdesk-production`, the SSM
parameters) before assuming anything exists, and assume the image has never
run on AWS. What has been checked here is local:
`terraform validate`, `terraform test` against mocked providers, tflint,
checkov, cfn-lint, actionlint, and the app image built for arm64 and booted
under emulation (13 October 2026).

- **`next build` still needs a `DATABASE_URL`; the image supplies a
  placeholder.** `src/db/index.ts:33` calls `env.databaseUrl()` at module
  scope, `required()` throws when `NODE_ENV === "production"`, which is what
  `next build` sets, and Next imports every route module while collecting page
  data. `apps/app/Dockerfile` (build stage, L58-61) sets build-only
  placeholders for `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` and
  `HEALDESK_PROVISION_SECRET`, so the image no longer needs a real database URL
  at build time. A bare `next build` outside Docker still fails without one;
  CI passes only because `DATABASE_URL` sits in the job-level env. The build
  stage sets `NODE_ENV=production` itself (L67): it inherits `development`
  from the deps stage, under which `next build` fails prerendering
  `/_global-error`, so until 6 October 2026 the image did not build at all.
  Production's database TLS check stands aside while `NEXT_PHASE` says the
  process is `next build`, so the placeholder needs no `sslmode`.
- **The AWS SDKs load in a production build; fixed 6 October 2026.** They
  used to be optional, installed nowhere, and imported through a `const`
  specifier; Turbopack folded the constant and inlined
  `throw MODULE_NOT_FOUND` into the server chunks, so production had no KMS
  (and `getKeyWrapper()` refuses `LocalKeyWrapper`) and SES could never send.
  `@aws-sdk/client-kms` and `@aws-sdk/client-sesv2` are now `dependencies` of
  `apps/app`, imported lazily by a literal specifier in `crypto/kms.ts` and
  `reporting/deliver.ts`, and listed in `serverExternalPackages` beside `pg`.
  Production builds on 6 October settled what had not been tested: listing
  them without installing them changes nothing; installing them removes the
  throw but bundles the SDK into the chunks; with both, each chunk `require`s
  the package and the standalone output traces it in, symlinked the way `pg`
  already is. An isolated copy of `.next/standalone`, run with
  `NODE_ENV=production` and `HEALDESK_KMS_PROVIDER=aws-kms` against a fake
  local AWS endpoint, sealed and opened a secret and sent through SES; the old
  build, with both SDKs added to its runtime tree, failed both. The SDKs needed
  no Dockerfile change: `npm ci` runs before `next build`, and the runtime stage
  copies the workspace `node_modules`. `tests/aws-sdk-clients.test.ts` pins
  all three; re-check the chunks after a Next upgrade.
- **Static assets are in the image, and so is everything the AWS host needs
  from it; the host is defined but not applied.** `.next/static` is still not
  part of Next's standalone output, but the Dockerfile (L117) copies it beside
  `server.js`. The image carries the Amazon RDS us-east-1 CA bundle at
  `/etc/ssl/rds/us-east-1-bundle.pem`, fetched against a pinned checksum, with
  `NODE_EXTRA_CA_CERTS` pointing at it (L105-107); both database URLs carry
  `sslmode=verify-full&sslrootcert=<that file>`, and production refuses a
  `DATABASE_URL` without `verify-full` (`tests/database-url-tls.test.ts`). Its
  entrypoint, `apps/app/docker-entrypoint.sh` (L112), unsets every variable
  whose value is exactly `__unset__`: ECS refuses to start a task whose
  parameter is missing and a parameter cannot be empty, so Terraform creates
  every SSM parameter holding that placeholder, and a feature still waiting
  for its secret stays off. No secret value is in Terraform's state: the
  db-bootstrap task generates the six internal ones inside AWS and never
  replaces one that is set, and the owner pastes the external ones in AWS
  CloudShell with `infra/aws/scripts/put-external-secrets.sh`.
  `scripts/provision-roles.sql` runs as RDS's master user, which is not a
  superuser, from the `infra/aws/images/db-admin` image, which sends the server
  SCRAM verifiers rather than passwords.
- **The worker, migrations and queue install ship in the image as separate
  commands, each its own task definition, none at boot.** The Dockerfile
  (L120-132) copies the whole workspace `node_modules` (`tsx` is a runtime
  dependency; `drizzle-kit` is there only because the deps stage installs dev
  dependencies), `src/`, `drizzle/`, `drizzle.config.ts`, `scripts/` and
  `tsconfig.base.json`, without which tsx loses the `@/` paths. The default
  command, `node apps/app/server.js`, is the web service, behind the
  `tls-proxy` sidecar that re-encrypts the load balancer's traffic to the task.
  The worker runs `node --import tsx src/workers/index.ts` in
  `/repo/apps/app`, so node gets ECS's SIGTERM itself, as an essential third
  container of each web task by default, or as its own service with
  `worker_placement = "separate"`; `npm run worker` is still the local command. Migrations and `queue:install` run as the migrator
  in a one-off task before every rollout, and the two roles are created by
  another; `deploy-app.yml` starts both, and `infra/aws/scripts/run-task.sh`
  runs either from a terminal. Two more are registered by every deploy and run
  only by hand: `destroy-due` (the worker's container running
  `scripts/destroy-due.ts`), after a restore (`docs/handover.md`,
  "Restoring"); `patient-export`, a leaving clinic's return bundle, put in
  the export bucket (`infra/aws/exports.tf`) by its own task role; and the
  patient-rights scripts `erase-person` and `amend-contact`, by contact id
  only, since the host has no shell and no stdin.
- **CI checks the Terraform, not the image.** The `infra` job in `ci.yml` runs
  `terraform fmt`, `init -lockfile=readonly`, `validate` and `test`. No CI job
  builds or runs the image; `deploy-app.yml` is the first thing that does, at
  deploy time.
- **The voice agent is its own process, behind a switch that is off.** Next
  route handlers cannot accept WebSocket upgrades, and Retell holds a WebSocket
  open for the whole call, so the Retell custom-LLM endpoint is its own
  long-lived Node process from the same image: `node --import tsx
  src/voice/server.ts` in `/repo/apps/app` (built 13 October 2026), on port
  3001 behind the same `tls-proxy` sidecar. `enable_voice` (off by default, so
  the lean profile pays nothing for it) adds its task, service
  `healdesk-production-voice`, target group (deregistration delay an hour, so
  a deploy never cuts a call), the listener rule `/llm-websocket/*` on the
  public host, an alarm, and `deploy-app.yml` rolls it with web. Each clinic's
  Retell agent uses `wss://app.healdesk.io/llm-websocket/<HEALDESK_RETELL_LLM_SECRET>/<clinic id>`.
  Never tested against Retell itself: check its protocol fields on a synthetic
  clinic first (`docs/design/web-chat-and-voice-2026-10-13.md`).

What stands between this and real patients is the BAA chain above, and for
voice, `enable_voice` with its secret and a test call.

---

# Product rules the code enforces

Every rule below comes from `docs/v1-product-spec.md`. They are enforced in code
around the model, never left to a prompt. Several of the surfaces they govern are
not built yet, and some existing code predates them (`lib/meta/front-door.ts`
books nothing and takes booking requests instead). Read the code before assuming
a rule already holds, and treat a gap as a bug, not a precedent.

**Channels and contact**

- **Inbound only.** No code path contacts a patient first, or after a
  conversation ends: no SMS or texting of any kind, no reminders, follow-ups,
  win-backs or reactivation, no missed-call text-back, no call-backs, no
  post-treatment check-ins or review requests.
- **The assistant says it is an AI assistant in its opening line, on every
  channel.** On calls the same line says the call is transcribed; no call audio
  is kept. The clinic cannot switch this off or edit it out through the
  greeting field.
- **The Meta 24-hour window is enforced in the adapter, not the prompt.** A
  send attempted outside the window is dropped by the adapter, whatever the
  model asked for.
- **Clinical content is caught at the Meta boundary, before it is stored.** It
  is never persisted, echoed back or carried into a summary; the assistant
  moves the person to a call or the clinic's own secure route and says why in
  one sentence. Meta will never sign a BAA, so these channels are scoped to
  carry nothing clinical.
- **Voice coverage is conditional call forwarding on the clinic's own line**,
  so the clinic keeps its published number. Three modes: all calls, overflow
  and after hours (the default), after hours only.

**Booking and payment**

- **Bookings and payments are written only by the fixed tool layer**, never by
  the model directly. One brain, four adapters.
- **Google Calendar is the only write target**, on every channel. Every write
  is idempotent (a retried request, a duplicate webhook or a repeated tool call
  returns the original booking), and the slot is held for 60 seconds before
  anything confirming is said. No writes into Mindbody, Boulevard or Cal.com in
  v1.
- **"Auto-confirm bookings" is on by default**; off turns every booking into a
  request staff approve. Clinics whose system does not read Google for
  conflicts — Mindbody (one-way), Boulevard (unverified) — run manual booking
  mode: the assistant takes the preferred time and alerts staff. A broken or
  expired calendar connection flips a clinic into manual booking mode in the
  same turn.
- **Card numbers are never taken.** Web chat and the Meta channels may send a
  hosted payment link through the clinic's own gateway during the
  conversation. Voice cannot collect: it books and flags the deposit for staff.
- **No treatment name in a payment description, a Meta message or the support
  chat.** Stripe sees an amount, a generic descriptor and an opaque reference,
  and nothing clinical — not in metadata or the statement descriptor either.
- **Provisioning is gated on the first paid invoice**, never on the checkout
  session alone.

**Guardrails**

- No diagnosis, prescribing, treatment plans or outcome guarantees.
- No price outside the clinic's configured list: an off-menu price becomes an
  offer to book a consultation.
- Complication and urgent-symptom messages are matched before the model sees
  them, and short-circuit to a fixed response and immediate escalation to the
  clinic's named contact.
- The clinic's never-say list is injected into every conversation on every
  channel. The clinic cannot edit the prompt, so it cannot remove a guardrail by
  accident.

**Failure**

- **Every degradation path ends with calls forwarding to a direct clinic line**
  — one that does not forward back to us. That covers Pause AI, the allowance
  cap's "Stop and fall back", suspension, cancellation, and a failure of our
  endpoint or a vendor. Website chat becomes a contact form. A patient calling a
  clinic must always reach someone.

**Claims and copy**

- v1 may claim: conversations handled, appointments booked by the assistant,
  calls answered that would previously have rung out, deposits collected, and
  "booked value" (bookings times the clinic's own configured prices). Never
  "revenue", never "collected", never "which call became revenue".
- **Attribution is fenced out of v1.** The attribution engine, POS read-back,
  the monthly revenue report and "recovered revenue" are phase two: keep the
  code, keep it out of v1 flows, screens, emails and copy.
- Say "we sign a business associate agreement and handle patient data under
  it". Never an unqualified "HIPAA compliant".
- The set-up promise is per channel, never global: about fifteen minutes of the
  clinic's attention; website chat live once the snippet is pasted; Instagram
  and Messenger once the clinic connects them; WhatsApp once its WhatsApp
  account has a payment method; phone once call forwarding is set. It describes
  the step, never the time. Never "live in two minutes".
- **No opening dates.** A channel is sold only once it is ready; one that isn't
  comes off the product list and out of the copy (owner, 6 October 2026).
- **Pricing is per product, in usage steps of 100** (owner's pricing sheet,
  13 October 2026; `packages/catalog/src/plans.ts` holds it). Five packages:
  AYA Voice, AYA Web Chat, AYA Meta Chat (which includes website chat), Voice +
  Web Chat, Voice + Meta Chat. The clinic picks 100 to 1,500 voice minutes and
  chat conversations a month in steps of 100: $80, $40 and $60 per 100; setup
  $697, $259 and $697, summed for a combined package. Prices are per location;
  annual billing is 20% off. Meta is never sold without website chat.
- **Setup discounts last 48 hours and only one applies:** a personalised
  demo's share from the moment the demo is ready, 50% from one an operator
  built and sent, 30% from one the visitor asked for on the homepage ("Send me
  my own free AI assistant"); else 30% to anyone buying through the website,
  from the moment the offer is first shown (a signed cookie,
  `apps/web/src/lib/site-offer.ts`). The Day 7 cohort credit (the fee in full)
  beats them all. The server decides which, never the browser. Never print the
  50% on a public page.
- Overage is billed per started block of 100 at the product's extra-100 price
  (owner, 13 October 2026): $104 for voice minutes, $52 for Web Chat and $78
  for Meta Chat conversations. At 90% of the included amount the clinic is
  emailed and may move up a step; an extra block always costs more than the
  next step. The rates are provisional until measured. Copy says so and
  quotes the block and its price, never a per-unit rate; being provisional
  does not change what is billed.
- "healdesk is a service of Viixi FZC, a company registered under the Sharjah
  Publishing City Free Zone, United Arab Emirates" appears on the Terms and
  Privacy pages. It is not in the site footer (owner, 9 October 2026): the
  spec asked for it there for the Meta Business Verification submission,
  which cleared on 4 October. The registered street address is
  `ENTITY.registeredAddress` in `apps/web/src/lib/legal.ts`, off the trade
  licence, and prints only on those two pages.

---

# The clinic portal (v1)

Clinics sign in. v1 has a clinic portal and an onboarding wizard, served by
`apps/app` because they show transcripts and bookings. They are being built to
the plan the owner approved on 6 October 2026,
`docs/design/funnel-onboarding-portal-2026-10-06.md`, from the spec's "Account
access and credentials", "Portal map", "Every switch in the portal" and "What
the portal does not have". Where the plan and the spec differ, the plan records
the spec edits the owner approved.

- **Six screens, nothing nested more than one level deep:** Home, Settings,
  Knowledge, Conversations, Bookings, Billing. Settings holds every switch on one
  page, in cards. Invoices and the payment method deep-link into Stripe's own
  portal.
- **One email address per clinic** (a shared inbox such as info@ is fine). It is
  the clinic's only sign-in, the Stripe billing email, the agreement's notice
  address and where every notification goes, dunning included. That address
  overrides the spec's "never the public inbox", by the owner's decision of
  6 October 2026.
- **One shared sign-in in v1.** The spec's three roles (owner, manager, billing
  contact) are deferred: `requirePortal(slug)` checks membership only.
- **Getting in.** Payment creates the account against the clinic's address and
  lands the buyer on `/welcome`, signed in through a one-time link. There are no
  passwords anywhere. Every later sign-in is an expiring email link.
- **A passkey per device, with an authenticator-app backup, before any
  transcript or booking opens.** Every open writes an access-log row naming the
  device's passkey. Toggles, billing and knowledge edits need no step-up, except
  where calls and money go: the direct line, the transfer number, the clinic's
  address, the payment account and exports.
- **The wizard is four steps:** confirm the pre-filled basics; set behaviour
  (tone, greeting, voice coverage mode, the direct line, deposits and the
  gateway, the urgent-help number); connect Google Calendar; connect the
  channels bought. Every step saves as it completes, and a clinic resumes from
  the link in its welcome email.
- **Email** (the plan's Annex X):
  - patient-related mail is a pointer into the portal: never a name, number,
    time, service or any text from a conversation. One exception, by the
    owner's decision of 13 October 2026: a conversation's transcript is
    emailed to the clinic when it ends, instead of being stored
    (`lib/conversations/transcript-email.ts`). It is classed `may-carry-phi`,
    so it goes only through SES with TLS required, never Resend; its subject
    names nobody and it asks not to be replied to. Until SES has taken it,
    and seven days after, it waits sealed in the outbox, retried and sent
    again after a bounce (`lib/conversations/transcript-outbox.ts`); the
    spec says so since 13 October 2026
    (`docs/design/transcript-email-2026-10-13.md`);
  - one Resend account sends all of it, product and marketing mail alike, from
    hello@healdesk.io, the only address (owner, 9 October 2026), and every
    email can be replied to; the sender is the `HEALDESK_EMAIL_FROM`
    environment variable;
  - F0's `billing_notices` is the one outbox and `report_deliveries` the ledger.
- **Billing starts the day AYA first answers a patient, with no Stripe trial**:
  a $0 monthly line until then, swapped for the package price on the plain
  subscription at the first answer. There is no subscription schedule and no
  backstop date (`docs/design/funnel-portal-contracts-2026-10-06.md` §2). Never
  reintroduce `trial_end`.
- **The setup fee is never refunded, and a clinic has 30 days to finish
  setup** (owner, 6 October 2026). While no channel is live it gets a reminder
  every five days, six in all; at the end of the 30th day with nothing live,
  the subscription is cancelled and the account closed, keeping only the signed
  agreement and the billing records the law requires.
- **Every connection is a login button:** Google Calendar OAuth, Facebook
  login, WhatsApp embedded signup, the gateway's own connect flow. A clinic never
  pastes a key or a credential. The single-use `/connect/[token]` credential
  handover in `apps/app` today belongs to the phase-two read-back.
- **The support chat** carries a permanent line telling staff not to paste
  patient information, and stores nothing: the browser holds the conversation,
  and an escalation emails hello@ structured fields, never chat text.
- **It must never grow** prompt or script editing, a flow builder, per-channel
  behaviour differences, a live staff inbox, outbound campaigns, raw analytics
  dashboards, immediate in-app cancellation, or direct calendar or EMR
  configuration.

`/admin` on `apps/web` stays the operator console, and it is ours. The clinic
console deleted on 2026-09-12 is not the portal: build the portal from the spec,
not by restoring that code.

---

# Deployment

| Workspace | Target | Root directory | PHI |
| --- | --- | --- | --- |
| `apps/web` | Vercel project #1 | `apps/web` | No |
| `apps/app` | BAA host (AWS, `us-east-1`): ECS on Fargate service `healdesk-production-web` behind one load balancer, at `app.healdesk.io` and, for apps/web's signed calls only, `app-internal.healdesk.io`; defined in `infra/aws`; reported applied by the owner on 13 October 2026, but GitHub records only a plan (see above) | `apps/app` | **Yes** |
| `apps/app` worker | Same cluster: by default a container in each web task; its own service `healdesk-production-worker` with `worker_placement = "separate"` | `apps/app` | **Yes** |
| `apps/app` migrations and role creation | One-off tasks `healdesk-production-migrate` and `healdesk-production-db-bootstrap`, run by `deploy-app.yml` | `apps/app` | **Yes** |
| `apps/app` voice endpoint (Retell custom-LLM WebSocket) | Same cluster, its own long-lived service `healdesk-production-voice`, created only with `enable_voice` (off by default) | `apps/app` | **Yes** |
| `packages/leadgen` | Not deployed | — | No |

The BAA host is the AWS account designated under the AWS BAA, in `us-east-1`
(`docs/policies/aws-hipaa-account.md`). The database is Amazon RDS for
PostgreSQL 17 under that agreement, the owner's choice of 7 October 2026 over
Neon, defined in `infra/aws/rds.tf`; whether it is provisioned is unsettled (see above). Vercel is a BAA
host only on Enterprise.

The voice endpoint cannot be a route handler or a serverless function. Retell
opens a WebSocket to it at the start of every call and keeps it open until the
call ends; Next route handlers cannot accept a WebSocket upgrade, and serverless
functions cannot hold one open. Run it as its own Node process from the same
image as the web tier and the worker, so all three ship the same schema and the
same tool layer.

Two environment variables decide origins and are easy to confuse:

- `HEALDESK_APP_URL` (set on `apps/web`) — the **internal** address used to
  reach `apps/app`. Never browser-visible. A wrong-but-present value is worse
  than unset: the guards pass and honest 503s become 502s. On AWS it is
  `https://app-internal.healdesk.io` (Terraform's `internal_url` output), on
  Vercel's Production, and on Preview only while the host holds Stripe test
  keys. The load balancer serves only the signed routes on that host and
  answers 404 to them on the public one, so a value naming `app.healdesk.io`
  gets 404s, which the Stripe relay treats as final and drops the event.
  Terraform sets the same value on `apps/app`'s own tasks, where
  `lib/email/lint.ts` refuses any mailed link to it.
- `BETTER_AUTH_URL` (set on `apps/app`) — the **public** origin used to build
  every clinic-facing link: today's connect and booking links, and in v1 the
  magic sign-in links, the wizard-resume link in the welcome email and portal
  URLs. It falls back to `http://localhost:3001` rather than throwing, so
  leaving it unset silently mails dead links. On AWS Terraform sets it to
  `https://app.healdesk.io`; it is also the passkey relying party and the host
  every vendor redirect is registered on, so it is effectively permanent.

`NEXT_PUBLIC_SITE_URL` is inlined at build time and must be present in
Vercel's **Build** environment. `lib/billing.ts` falls back to
`http://localhost:3000` and feeds Stripe's `success_url`, so an unset value
charges the customer and then redirects them to their own machine.

Environment variables consumed by a build must also be declared in
`turbo.json`'s `build.env` — Turborepo 2.x defaults to strict env mode, so an
undeclared variable is invisible to the task.

---

# Working in this repo

- **Verify before claiming something is built.** Read it out of the code, not
  out of a README, a directory listing, or a plan document. The spec says what
  v1 must do, not what exists.
- `docs/v1-product-spec.md` is an export. Never edit it; change the source doc
  and re-export.
- Commit messages here explain *why*, in prose, and are expected to name the
  failure the change prevents. Match the surrounding style.
- Tests: `npm test -w @healdesk/web`, `npm test -w @healdesk/app`. The
  database-backed security suites **skip silently** without `TEST_APP_URL` —
  CI provisions the two-role Postgres and fails the job if fewer than 200 tests
  pass.
- Lint: `npm run lint` (ESLint 9 on `apps/web`; each rule choice and its reason
  is in `apps/web/eslint.config.mjs`). CI runs it and fails the job on any lint
  error, so run it before pushing.
