# healdesk.io

## Mandatory Delivery Plan and Session Continuity

For all Healdesk development sessions, including sessions started under a different Claude Code account:

### Authority
1. `docs/v1-product-spec.md` defines product behavior and scope.
2. `CLAUDE.md` defines architecture, security, engineering standards and permanent project rules.
3. `HEALDESK_CLAUDE_CODE_LAUNCH_EXECUTION_PLAN.md` is the master engineering delivery plan, subject to the two documents above.
4. `AGENTS.md` is the continuously maintained session handoff, not a source of product requirements.

### At the start of every session
- Read this file, the product specification, the execution plan and `AGENTS.md`.
- Inspect the current Git branch, commit, working tree and relevant recent changes.
- Check that the handoff agrees with the actual code and test results.
- Identify the current approved task, its dependencies and acceptance criteria.
- Do not start new implementation work until the current state is understood.
- If `AGENTS.md` is missing or outdated, reconstruct it from available evidence. Do not invent previous progress.

### During every task
- Work from the master execution plan.
- Use a unique task ID for each work package.
- Record what is implemented, what is tested and what remains.
- Keep Owner-only actions separate from Claude Code actions.
- Never mark a task complete solely because code exists.
- Never bypass compliance, safety or launch restrictions.

### Before ending every session
- Update `AGENTS.md` with the current task, completed work, modified files, test results, failures, blockers and next action.
- Record the current branch, commit SHA and uncommitted changes.
- Update the delivery plan's task statuses only when supported by evidence.
- State whether work is local, committed, pushed, deployed or live-verified.
- Provide a concise handoff summary for the next session.

### Mandatory stopping rules
Do not merge, deploy, apply infrastructure changes, alter production credentials, activate patient traffic or grant final launch approval without explicit Owner authorization.

If the session is interrupted before the handoff is written, the next session must reconstruct progress from Git and tests before continuing.

## Mandatory delivery documentation and automatic checks

- The repository must contain `HEALDESK_CLAUDE_CODE_LAUNCH_EXECUTION_PLAN.md`, `AGENTS.md`, and `docs/claude-session-start.md`. Do not delete or replace the existing architectural guidance in either `CLAUDE.md` or `AGENTS.md`.
- GitHub Actions must run `scripts/check-delivery-handoff.mjs` on pull requests and pushes to `main`. The check verifies these files exist, the session handoff has its required headings, and changes to delivery-related code include a corresponding `AGENTS.md` update or a documented exemption. A green check verifies documentation hygiene, **not** that an agent read a file or that production is ready.
- PRs should name a delivery task ID, list the tests actually run, link to evidence, identify Owner-only blockers, and say whether the change was deployed or live-tested. Use `.github/pull_request_template.md`.
- Never claim that CI has passed until the GitHub run has completed successfully. Repository branch protection and required checks must be enabled by the Owner in GitHub settings; adding a workflow alone does not make it mandatory for merging.
- For routine unrelated commits, documentation-only changes, and dependency automation, the check may allow a narrowly documented exemption. Do not fabricate a handoff update merely to satisfy CI.
- Before stopping or switching sessions, refresh `AGENTS.md` with the actual Git state and the next approved work item. If interrupted, reconstruct from Git rather than trusting stale notes.



One AI assistant for cash-pay elective clinics, sold as three inbound-only
products that launch together: an AI voice agent (on Retell), a web chat widget
on the clinic's own site, and a Meta bot covering Instagram, Facebook Messenger
and WhatsApp.

npm workspaces monorepo, Turborepo. `apps/web` (marketing + operator console),
`apps/app` (the product), `packages/{catalog,connectors,leadgen}`.

**What v1 is lives in [`docs/v1-product-spec.md`](./docs/v1-product-spec.md).**
It is the source of truth for what the product does, how it behaves, what it
cannot do and what it may claim. Since 22 October 2026 this file is the source
of truth itself: edit it directly, in a commit that explains why (the owner's
decision; it was exported from the Claude Doc at
https://claude.ai/artifact/F7bKioXheMJwn5Epc65bVQ until then, and that doc is no
longer re-exported over it). The live task list is still the "Launch plan" tab
of that doc, not a file in `docs/`. If a repo doc, a comment or a plan disagrees with the spec about
what the product is or does, the spec wins. This file still decides **where code
goes**.

The spec's "admin portal" is the **clinic portal** in `apps/app`. The repo's
`/admin` is **our operator console** in `apps/web`. They are different surfaces
for different people; never conflate them.

---

# Simplicity rule (owner, 28 October 2026)

**Every product offering, setting, proposal and piece of copy must be reduced
to the simplest form of the topic, and the simplest words for the client.**
Simplify the thing itself, not only the wording: if something is not needed,
do not build it, do not set it up and do not mention it. A clinic never reads
about senders, registrations, agreements with vendors or how a switch works
inside; it reads what the switch does for them and, when it is unavailable, one
short reason in plain words. Before adding a setting, a step or a sentence ask:
does the clinic need to know or do this at all? If not, remove it. Detail for
engineers and the owner belongs in the repo docs, never on the client's screen.

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
| Chat + voice demos (they talk to *owners*) | Call and chat transcripts, which are emailed to the clinic through SES when the conversation ends; the only copy is the sealed outbox row, deleted the moment SES reports it delivered and never kept past 30 days, the row staying as a receipt without the words (owner, 14 October 2026; BAA 1.5.0; healdesk keeps no call audio, and Retell holds a call's recording for a day at most) |
| The demo's scraped clinic profile (business data) | Bookings: Google Calendar availability and writes, slot holds, the manual-booking queue |
| Checkout, Stripe, agreement signing, its emailed copy and PDF; until the first paid invoice, the sealed agreement and purchase records in the marketing Sheet (owner, 14 October 2026; `lib/checkout/records.ts`) | Deposit links through the clinic's own payment gateway |
| Contact form, reviews (business contacts) | The clinic portal, the onboarding wizard and the portal support chat |
| The `/admin` operator console | The BAA register itself + retention clock: a signed agreement enters it at provisioning, its seal and re-rendered hash checked (`lib/checkout/import.ts`) |
| Anything public, cached, indexed | Clinic credentials: Google Calendar tokens, Meta Page and WhatsApp tokens, the gateway connection |
| | Inbound support mail: a clinic's email to support@ or hello@healdesk.io, forwarded by the owner's mailbox to SES on in.healdesk.io; the database keeps facts only (topic, urgency, counts, opaque ids), never its words; while the `support-draft` job is on and the case is new, the raw message waits in the KMS-encrypted bucket until the support drafter reads it in memory (keeping nothing) and sends its text, unmasked, to Anthropic's API under the signed BAA (healdesk's key is the BAA organisation's, owner-confirmed 26 October 2026) to draft a reply for ops approval, then deletes it, normally within minutes; otherwise it is deleted on arrival; the sweep deletes anything older than six hours (so up to about seven) and the bucket lifecycle (eligible one to two days after arrival, then removed asynchronously by S3, normally within a few days; the only deletion while the host is in standby) is the backstop. The console never shows the email itself, but the drafted reply, text derived from it, is shown in `/admin` on Vercel (no BAA) and held in the approval inbox, with the reply checks as the only guard: a patient detail the model repeated past them can reach the console (`lib/support/inbound/`, `lib/support/draft/email.ts`) |
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
   demo agents (Synthflow was replaced on 5 October 2026, and its webhook and
   tool routes were removed on 14 October). The product's voice
   agent answers real patients, so it belongs in `apps/app`, built on Retell:
   Retell opens a WebSocket per call to a Healdesk-hosted Claude endpoint
   (`src/voice/server.ts`, `lib/voice/retell.ts`, built 13 October 2026), and
   everything the agent says and every request it takes runs there. `/api/callback` only *places* a demo call an owner asked for; it
   is not a patient call-back, and v1 never contacts a patient first. If AYA,
   the demo persona, ever answers a real patient, that path is PHI and moves to
   `apps/app`.

   **A personalised demo call runs on that same engine** (owner, 24 October
   2026: "the demo AYAs and the client AYA should be THE SAME, only difference
   should be the start"). When `RETELL_DEMO_ENGINE_AGENT_ID` is set on Vercel
   and apps/app answers, apps/web starts the call with the demo engine agent,
   whose socket is `/llm-websocket/<secret>/demo`, and hands over the
   clinic's published profile and the requester's first name as one Retell
   dynamic variable sealed with `HEALDESK_PROVISION_SECRET`
   (`packages/catalog/src/demo-call.ts`; business data, never a patient's).
   apps/app answers it with the same turn pipeline, guard and front-desk
   prompt as a clinic's patients, from that context instead of the database,
   and keeps nothing: no gate, no ingest, no transcript, no alert, no booking.
   **Since 1 November 2026 the demo call is only the clinic's receptionist**
   (owner: "Remove the sales pitch completely. Aya is now only a
   receptionist"): it opens as the clinic's front desk with the AI and
   transcription notice ("Thanks for calling <clinic>, this is Aya, the AI
   assistant, and this call's transcribed. How can I help you today?",
   `demoVoiceOpening`) and stays there to the goodbye. There is no intro, no
   question to the owner, no pitch, no healdesk price or discount, no
   call-back offer and no listener; the sales prompt, the demo's scripted
   cases and its owner-persona eval were removed with them. One exception
   stays (owner, 25 October 2026): a demo call started by an operator signed
   in to `/admin` is sealed as a test, and its transcript is emailed to
   hello@ through SES as it ends, with nothing queued or kept; a prospect's
   demo call keeps no transcript, as the Privacy page says. **Since the
   restructure of 1 November 2026** (owner, after demo call be078f77: "I feel
   that we're going in circles", then "go ahead with the restructure"; the
   whole of what she used, and where it contradicted itself, is
   `docs/design/demo-aya-anatomy-2026-11-01.md`) a demo runs the prompt a
   clinic with a connected calendar gets (`bookingTools: true`) and books
   through the same tool layer as a clinic's calls (`booking-tools.ts`), on
   the demo's own engine (`lib/voice/demo-booking.ts`: a calendar made of the
   published or made-up hours, in memory, nothing written; the first time
   picked "just gone" once a call, the owner's proactive moment; the demo's
   deposit rule flagged as a clinic's is; a stand-in caller number, so "the
   one I'm calling from" works as on a clinic's call). Free times come only
   from the tool layer: a reply naming one with no action is answered by the
   tool layer for the day and the part of the day the caller named
   (`claimsFreeTime`, `windowNamedIn`, `turn.ts`, every call), and
   `find_times` takes `after` and `before`. What the demo adds is one short
   note per turn (`demoStageNote`): the clinic framing, a hurried or
   frustrated caller, a doctor not on the team (`unknownDoctorIn`), what she
   has already told them, and its policy rules, and nothing about booking,
   times or names, which the prompt and the tool layer own. The demo's own
   booking code before the restructure (`roleplayTimeLine`,
   `roleplayCheckedReply`, `demoConfirmLine` and their notes) is off the call
   path and waits to be deleted. The demo never says a line twice; healdesk's
   words are on its never-say list (`demoRoleplayFacts`); a refused reply
   gets the guard's line with the provider's name (`routingProvider`, on demo
   calls only until the owner decides a clinic's own lines name theirs); the
   urgent line reads out the clinic's published number after 9-1-1, opened
   with a word of sympathy and named as the clinical team's direct line
   (`demoUrgentLine`; a clinic's own urgent lines wait on the medical
   director's sign-off). `tests/voice-demo-be078f77.test.ts` and
   `tests/voice-demo-sound-alike.test.ts` replay the owner's test calls on
   this path, as do `tests/voice-demo-c4093be6.test.ts` and
   `tests/voice-demo-a44374c9.test.ts`, restored on it on 1 November 2026
   (owner's approval), and `tests/voice-call-2026-11-01-evening.test.ts`.
   On every call, a clinic's and a demo,
   a word that sounds like the menu, a provider or what she just said is taken
   as that, never questioned ("this port" is Dysport; `lib/voice/sound-alike.ts`,
   owner, 1 November 2026); a reply is shaped for a voice (`forVoice`: no
   capitals spelled out, an address and a number as a person says them, no
   popularity claim, no more than two prices in a sentence); and the call says
   its own line to a business ask ("please call our office on ..."), a question
   about how busy the practice is, a paused fragment and a bare "hi"
   (`lib/voice/call-lines.ts`). The receptionist's manner (the day's
   pleasantry before the calendar, human words for a pause, a nod before
   each question, one sentence of validation once they choose, the caller's
   first name once at the wrap-up, a word that the consultation is relaxed, and
   a closer that looks out for them, "we" and "our team" for the practice,
   an opening offered as a good find, and her energy mirroring the caller's,
   a brief caller getting no pleasantry) is in the
   shared voice prompt (`prompt.ts`, `RECEPTIONIST_MANNER`), so a clinic's
   own calls have it too; it never says a time is booked unless the booking
   line did, never says a confirmation or message is on its way, gives an
   arrival tip only from the practice's facts, claims no scarcity the
   calendar does not show, asks no email on a call, and states no popularity or outcome
   claim as the clinic's fact. What the clinic's public pages did not show
   is made up for the live demo only (owner, 1 November 2026: invent the
   calendar, the deposit and the prices "just to show them the dream
   outcome", with "a visible disclaimer"): a price for each treatment listed
   without one, a sample menu when none was found, weekday hours, a $50
   deposit and 24-hour cancellation rule, and always the free times
   (`apps/web/src/lib/demo/samples.ts`, `withDemoSamples`, applied by the
   chat and voice routes and the page, never to the stored profile the
   build's audit checks); the address, the phone number and the team are
   never made up. The demo page's note above the voice and chat cards lists
   every made-up item ("Made up for this demo", `demoNoteHtml`). Spoken text
   writes "Aya", never "AYA", which a voice spells out. While the host is in standby, the demo falls back to the
   Retell-hosted clinic demo agent, so a demo never depends on AWS being on.

3. **`/admin` on `apps/web` is deliberate, not a shortcut.** It is our tool,
   not a clinic's — and note how it gets its data. Clinics use a different
   surface, the clinic portal in `apps/app`. `/admin` must never be exposed to
   a clinic. Its sign-in, the password and the authenticator code, is checked
   on Vercel against Vercel variables and calls nothing in `apps/app` (owner,
   14 October 2026; `apps/web/src/lib/admin/totp.ts`), so the console opens
   while the AWS host is in standby.

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
than giving `apps/web` anywhere new to keep it. The one exception is the
buyer's own records (business contact data, no PHI): since 14 October 2026
the signed agreement and the purchase are sealed rows in the marketing Sheet
until the first paid invoice carries them to `/api/provision`, so a buyer can
sign and pay while the host is in standby
(`docs/design/checkout-records-on-vercel-2026-10-14.md`). Those Sheet tabs are
legal records: no hand edits, sorting or deleted rows.

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

### `apps/app` is portable, and runs on AWS

Audited 2026-09-12; re-checked against the code 2026-09-30; the AWS host was
written on 2026-10-07 and reworked after its review on 2026-10-12. The rules
above all pass — no `@vercel/*`, no edge, plain Node. The host is code in
`infra/aws`, for account `865780386982` in `us-east-1`: Terraform for ECS on
Fargate behind one load balancer, RDS for PostgreSQL 17, one KMS key, SSM
Parameter Store, CloudTrail, Config, GuardDuty, SES and alarms; a
CloudFormation bootstrap stack; and three workflows, `infra.yml` (plan,
apply), `deploy-app.yml` (build, migrate, roll, restart, roll back) and
`host.yml` (the one switch: `active` applies, sets up the database and
deploys; `standby` snapshots the database and removes it, the load balancer,
the NAT and every service, keeping the key, the parameters and the images, at
about $4 a month; started from `/admin/host` or by a first paid invoice that
finds the host off). Since 13
October 2026 it builds the owner's lean profile by default, about $70 a month
running (about $99 with the voice task, which `production.tfvars` turns on from
22 October 2026 and sizes at one vCPU and 2 GB from 25 October, once applied): one ARM64 web task of a quarter vCPU carrying the worker too
(`worker_placement`), a `db.t4g.micro`, a NAT instance instead of a NAT
gateway (`nat_mode`), and the WAF off (`enable_waf`); each is one variable
from the shape first built (README, "Costs").
`infra/aws/README.md` is the runbook. **Applied and deployed on 14 October
2026.** `infra.yml` applied main three times that day (runs 38523739346,
38525449296, 38525919193): the first two stopped on what a mocked plan cannot
see (an apostrophe in a security group description, Cloudflare comments over
100 characters, an SNS retry policy over an hour, an SNS subscription to an
endpoint that did not answer yet), each now pinned by a plan test, and the
third found nothing left to change. The owner's `deploy-app.yml` run that
morning (38527477622) built the images, ran db-bootstrap and the migrations
and rolled the web tier; `host.yml` with `active` (38538369097) then applied
and deployed main at 71a7a93, migrations through 0075, and subscribed the app
to SES's events. It holds synthetic data only. Which external secrets are
pasted is the owner's to say: check Parameter Store before relying on one.
What has been checked here, beyond those runs, is local:
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
  from it.** `.next/static` is still not
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
  Never tested against Retell itself: check its protocol fields on the demo
  clinic first (`docs/design/web-chat-and-voice-2026-10-13.md`).

What stands between this and real patients is the BAA chain above, and for
voice, `enable_voice` with its secret, a test call, and then `voice_real_calls`.
The secret and `enable_voice` may come before the agreements, for a test call
only (owner, 19 October 2026): until `voice_real_calls` sets
`HEALDESK_VOICE_REAL_CALLS=1`, the voice endpoint answers only the demo clinic
(`app_clinic_is_demo()`) and sends any other clinic's caller to its direct line,
or refuses the call, recording nothing (`lib/voice/test-calls.ts`).

---

# Product rules the code enforces

Every rule below comes from `docs/v1-product-spec.md`. They are enforced in code
around the model, never left to a prompt. Several of the surfaces they govern are
not built yet, and some existing code predates them (`lib/meta/front-door.ts`
books nothing and takes booking requests instead). Read the code before assuming
a rule already holds, and treat a gap as a bug, not a precedent.

**Channels and contact**

- **Inbound only.** No code path contacts a patient first, or after a
  conversation ends: no SMS or texting of any kind except the one exception
  below, no reminders, follow-ups, win-backs or reactivation, no missed-call
  text-back, no call-backs, no post-treatment check-ins or review requests.
  The one text (owner, 28 October 2026; optional, off by default, a clinic
  setting): after a call booking, if the caller agrees and reads their number
  back, one fixed-wording text carries the clinic's own hosted payment link,
  sent once, never resent, naming no treatment, time or amount, only when the
  clinic's payment gateway is connected, and sent by the fixed tool layer,
  never the model. The clinic's switch stays locked ("Texting the payment link is not
  available yet.", `PAYMENT_LINK_TEXT_SENDER_READY` in `switch-rules.ts`) and
  nothing sends a text yet: the sender is AWS End
  User Messaging SMS (owner, 30 October 2026) and is not built,
  `paymentLinkTextOffered()` is false so the assistant never offers one, and
  one toll-free registration, healdesk's own, is still to be filed. The sender needs no business associate
  agreement (owner, 28 October 2026): like Meta and Stripe it is handled by
  scoping, so the text is fixed words and the link and nothing else, never a
  treatment, a time, an amount or anything said on the call. The carriers'
  registration is one number healdesk registers once, not one per clinic. No text goes to a caller of a clinic whose accepted agreement is older than the one that carries the exception (BAA 1.6.0, DPA 1.1.0). Anything beyond that one text stays
  forbidden. One thing is not contact "after
  a conversation ends" (owner's ruling, 21 October 2026): a window-gated reply
  to a patient's open request, such as the fixed line telling a person on Meta
  that their booking request was decided or rescheduled. It is sent by the
  adapter only inside the 24-hour window the patient opened and is dropped
  outside it, names no treatment, and is never a reminder or a follow-up the
  patient did not ask for (`lib/meta/booking-requests.ts`,
  `lib/booking/reschedule.ts`, `sendMetaReply`).
- **The assistant says it is an AI assistant in its opening line, on every
  channel.** On calls the same line says the call is transcribed, and nothing
  about retention (owner, 24 October 2026: the consent laws ask that a caller
  be told the call is transcribed, not for how long anything is kept, which
  the written notice, the agreements and the privacy policy state;
  `docs/counsel/state-disclosure.md`, decision 11). The clinic cannot switch
  this off or edit it out through the greeting field.
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
- **On a call, the first refusal of the call may be heard as a stall** (owner,
  26 October 2026; `lib/voice/stall.ts`): once per call, a reply the guard
  refused for a price, something clinical or the never-say list, with nothing
  of it said yet, is heard as "Sorry, say that again?", and the refusal comes
  the turn after with a sorry opener; she may also stall once herself on
  something she does not know (`state.stall`). Never for urgent words, which
  are matched before the model, never twice in a call, and never ahead of a
  line that must come first. Nothing the guard refused is ever said: only
  when and how the refusal is heard changes. The voice safety suite pins it.

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
- **The demo page is the owner's own design, word for word** (owner,
  30 October 2026: "apply the html i asked, no modifications"). Every
  med spa, dental and other human-clinic demo at `/demo/[slug]` renders his
  file (`apps/web/src/lib/demo/v2/template.ts`, filled per clinic by
  `render.ts`); a vet's demo keeps the earlier page
  (`components/demo/LegacyDemoReady.tsx`), since his page speaks of a BAA and
  HIPAA. On that page alone his wording stands over the rules in this section:
  Meta chat shown as "Soon" with an early-access list (kept as a demo event,
  `metachat_vip`), the newness words the copy guard lists for it, and his
  lines on transcripts, the refund and booking systems. Change its words only
  at his word, and keep the guard's exceptions (`site-copy.test.ts`, QUOTED)
  matching them.
- **Copy first, then the switch** (owner, 19 October 2026). Client-facing copy
  states a feature of a channel that is sold as on before production does it,
  phrased as design where a page describes behaviour ("AYA is designed to
  ..."), and never the other way round: nothing is switched on and then the
  wording changed. What production does not do yet is an item in
  `LAUNCH_PROMISES` (`apps/web/src/lib/admin/seo/launch.ts`), shown at
  `/admin/compliance#launch` (Compliance › Launch, the one home since the
  admin redo of 23 October 2026); no clinic goes live while an item that blocks go-live is open.
  Move an item to `on` in the commit that makes production do it, and add one
  in the commit that adds a promise.
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
  next step. Copy quotes the block and its price, never a per-unit rate
  (owner, 30 October 2026: clinic emails no longer talk about our costs).
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
  Your practice (Knowledge in the code, at `/knowledge`; renamed for clinics
  by the owner, 1 November 2026), Conversations, Bookings, Billing. Settings holds every switch on one
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
    names nobody and it asks not to be replied to. It waits sealed in the
    outbox, retried and sent again after a bounce, until SES reports it
    delivered; then the copy is deleted and the row stays as a receipt
    without the words (status, times, attempts), which the ops operation
    `transcriptDeliveries` reads. A copy with no answer 72 hours after it
    goes, or undelivered after 30 days, is deleted too, and healdesk keeps no
    other copy, hello@ included (owner, 14 October 2026; BAA 1.5.0;
    `lib/conversations/transcript-outbox.ts`,
    `docs/design/transcript-email-2026-10-13.md`);
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
- **Slack carries ids, counts, dates, closed words and a clinic's name
  only, with one exception** (owner, 26 October 2026: "Show the draft reply
  text in Slack so I can read and approve it there with the passcode. I
  accept that Slack has no BAA."): a support reply waiting for approval
  (`support_reply_send`) is posted with its ref, the clinic's name, urgency,
  reply-by day and the reply WE drafted, never the clinic's own email
  (`apps/app/src/lib/support/slack-reply.ts`, `slack-actions.ts`). Every
  other Slack post stays on the allow-list in `lib/ops/slack.ts`.
- **It must never grow** prompt or script editing, a flow builder, per-channel
  behaviour differences, a live staff inbox, outbound campaigns, raw analytics
  dashboards, immediate in-app cancellation, or direct calendar or EMR
  configuration.

`/admin` on `apps/web` stays the operator console, and it is ours. The clinic
console deleted on 2026-09-12 is not the portal: build the portal from the spec,
not by restoring that code.

---

# The editorial library (SEO and GEO, `apps/web`, no PHI)

The public guides, research and standards pages, the glossary and the About
page carry the owner's search and AI-visibility strategy (14 and 19 October
2026). The strategy itself is the doc at
https://claude.ai/code/artifact/6a71b399-b0bc-4317-9a18-21aebd2e9aca.

- **Pieces are TypeScript data in `apps/web/src/lib/content/`**, so the copy
  guard (`lib/site-copy.test.ts`) and `lib/content/content.test.ts` read every
  sentence: citations resolve, every listed source is cited, every source was
  reopened within twelve months (against the real clock, so a stale figure
  fails the build), and our own prose keeps the house style. Never move
  content to Markdown or a CMS without moving those guards with it.
- **A piece is `draft`, `audited` or `live`, and only `live` is public.** The
  family routes (`/guides`, `/research`, `/standards/[slug]`) build from
  `livePieces()` with `dynamicParams = false`, so a draft is a 404; the
  sitemap, `llms.txt` and the `/guides` hub list live pieces only; a link to
  a piece that is not live prints as its label (`lib/content/inline.tsx`).
- **A legal piece goes live only after an independent audit of every
  statement against the primary text passes.** As of 19 October 2026 that
  audit is an AI review, not a lawyer's (owner's decision); each legal page's
  notice and `/about` say so, and the notice names a lawyer's review when one
  has taken place.
- **Structured data is built in `lib/structured-data.ts` from what the page
  prints**: `site` for the company, the catalog for prices, the registry for
  articles. `legalName` stays out of the markup, keeping the operating
  company on the Terms and Privacy pages only.
- **`/admin/seo` shows the strategy as state** (owner-approved 19 October
  2026): the owner's steps with ticks, ten checks run against the live site,
  pages by stage, the roadmap and the AI-answer panel (the launch tracker moved
  to Compliance › Launch).
  Ticks and panel runs are append-only tabs in the marketing Sheet
  (`lib/admin/seo/store.ts`); step ids are stable, so never reuse one.
- **The sitemap carries real edit dates**, typed on each route in
  `lib/seo.ts` or taken from an article's `lastReviewed`, never the build
  time. IndexNow pings the sitemap's URLs after each production deployment
  (`.github/workflows/indexnow.yml`; the key file in `public/` is public by
  design).

# Deployment

| Workspace | Target | Root directory | PHI |
| --- | --- | --- | --- |
| `apps/web` | Vercel project #1 | `apps/web` | No |
| `apps/app` | BAA host (AWS, `us-east-1`): ECS on Fargate service `healdesk-production-web` behind one load balancer, at `app.healdesk.io` and, for apps/web's signed calls only, `app-internal.healdesk.io`; defined in `infra/aws`; applied and deployed 14 October 2026 (see above); `host.yml` turns it on or puts it in standby | `apps/app` | **Yes** |
| `apps/app` worker | Same cluster: by default a container in each web task; its own service `healdesk-production-worker` with `worker_placement = "separate"` | `apps/app` | **Yes** |
| `apps/app` migrations and role creation | One-off tasks `healdesk-production-migrate` and `healdesk-production-db-bootstrap`, run by `deploy-app.yml` | `apps/app` | **Yes** |
| `apps/app` voice endpoint (Retell custom-LLM WebSocket) | Same cluster, its own long-lived service `healdesk-production-voice`, created only with `enable_voice` (off by default) | `apps/app` | **Yes** |
| `packages/leadgen` | Not deployed | — | No |

The BAA host is the AWS account designated under the AWS BAA, in `us-east-1`
(`docs/policies/aws-hipaa-account.md`). The database is Amazon RDS for
PostgreSQL 17 under that agreement, the owner's choice of 7 October 2026 over
Neon, defined in `infra/aws/rds.tf`; created and migrated 14 October 2026, synthetic data only, and removed in standby after a final snapshot it comes back from. Vercel is a BAA
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

## How work is reviewed, tested and landed (owner's rules, 25 October 2026)

These apply to every session, lead or builder, on every task. They exist to
reach the end faster **without** weakening what protects the product. The owner
asked for them to be written here so each session reads them.

1. **Review once per lane, at the end, not after every fix round.** A second
   round is kept only for what can hurt: money, legal clocks (incidents, the
   BAA/agreement deadlines), anything that sends email to a clinic, and
   anything that records an agreement answer or pauses AYA. The final review
   looks at the **merged combination**, not each lane alone, and every
   owner-facing sentence (alerts, screens, runbooks) gets an accuracy review
   against the code: false sentences were found in every wave.
2. **Merge as you go.** Before reporting, a builder merges the integration
   branch (or `main`) into its own branch, resolves the conflicts there, and
   runs the full verify (rule 4) on the merged tree. Commit after every piece of
   work; never run `git checkout <ref> -- .` or anything else that overwrites a
   working tree; never use a bare `git stash` (the stack is shared).
3. **Tests must be deterministic.** No random weeks, dates or ids that can
   cross a daylight-saving change or collide in a shared table; pin fixtures.
   Clear shared tables (for example `ops_alerts`) per file, or set unrelated
   rows aside, instead of assuming the table is empty. The database suites
   **skip silently** without `TEST_APP_URL`: always report skip counts, and
   never call a run green with skips you did not explain.
4. **One local verify command.** `bash scripts/verify-local.sh` starts a
   throwaway Postgres, migrates, runs the typecheck, lint, the drizzle schema
   check and the **whole** `apps/web` and `apps/app` suites, and prints
   pass/fail/skip counts. Run it on the exact tree you will hand over; CI must
   not be the first place a cross-lane failure is found. (`VERIFY_QUICK=1` is a
   smoke run, `VERIFY_APP_FILES="..."` names the app suites; neither replaces the
   full run before a handoff.)
5. **Fewer, bigger landings.** Land and deploy in batches, not per lane. Only an
   infrastructure plan and apply (Terraform) stay separate, with their own
   approval. None of this changes the standing rule: nothing lands on `main`,
   deploys, applies infrastructure or touches a secret without the owner's
   explicit yes in chat, and a deploy that rolls the voice service needs his
   word that no call is running or planned.
6. **Scope a big phase to a first useful slice.** Read the design in full,
   propose the slice and what waits, and get the owner's word before building
   the rest.

What these rules never relax: a code typed at the moment of an irreversible
admin act (a fresh authenticator code; for an approval decision or an
agreement answer, the one static approval passcode or a fresh authenticator
code, five wrong tries locking approvals for fifteen minutes per warm Vercel
instance; owner, 26 October 2026; the support reply's Slack dialog takes the
same passcode through the same verifier, `@healdesk/catalog/approval-passcode`,
locking per web task, lane P7i), the PHI boundary, real-database tests, CI on the exact tree that
lands, and the owner's approval before a landing or a deploy.

- **Verify before claiming something is built.** Read it out of the code, not
  out of a README, a directory listing, or a plan document. The spec says what
  v1 must do, not what exists.
- `docs/v1-product-spec.md` is the source of truth for the product (owner,
  22 October 2026): edit it directly, never re-export the old Claude Doc over it.
- Commit messages here explain *why*, in prose, and are expected to name the
  failure the change prevents. Match the surrounding style.
- Tests: `npm test -w @healdesk/web`, `npm test -w @healdesk/app`. The
  database-backed security suites **skip silently** without `TEST_APP_URL` —
  CI provisions the two-role Postgres and fails the job if fewer than 200 tests
  pass.
- Lint: `npm run lint` (ESLint 9 on `apps/web`; each rule choice and its reason
  is in `apps/web/eslint.config.mjs`). CI runs it and fails the job on any lint
  error, so run it before pushing.
- **Keep `/admin/map` true, in the same change.** It is the owner's one-look
  picture of every tool, connection and key. Key status is read live, but the
  picture itself is written by hand in `apps/web/src/lib/admin/system-map.ts`,
  so update it whenever a change:
  - adds a tool or vendor: `TOOLS`, in a category from `GROUPS` (a new
    category also needs a place in `lib/admin/map-layout.ts`);
  - adds a connection between two tools: `BRIDGES`;
  - adds an environment variable, or a GitHub repository variable a workflow
    needs: `KEYS`, with where it lives and how it is rotated, or `NOT_KEYS`,
    with the reason it is only a setting. An AWS-side key also goes in
    `apps/app/src/lib/ops/key-presence.ts`;
  - changes what a connection does, not only whether it exists (a channel
    that starts booking, a deposit link that starts being sent): that
    bridge's words, and the story that plays it;
  - finishes something the map shows as still to build: that bridge's
    `build` and `buildNote`.

  `system-map.test.ts` fails on a variable either app or its scripts read
  that is on neither list, and on a key nothing reads. It cannot see a new
  connection, a finished build or a changed behaviour, so those depend on
  this rule.
