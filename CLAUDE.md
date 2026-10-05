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
| Chat + voice demos (they talk to *owners*) | Call and chat transcripts (no call audio is kept) and the log of every transcript open |
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
   serve clinic owners from a generic knowledge tree, and the demo call still
   runs through Synthflow until the Retell agent exists. The product's voice
   agent answers real patients, so it belongs in `apps/app`, built on Retell
   (none of it is in the code yet): Retell opens a WebSocket per call to a
   Healdesk-hosted Claude endpoint, and every tool call it makes
   (availability, slot hold, booking) runs there. `/api/callback` only *places* a demo call an owner asked for; it
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

Audited 2026-09-12; re-checked against the code 2026-09-30. The rules above all
pass — no `@vercel/*`, no edge, plain Node. What is left is in the build and in
the missing voice process, and none of it is caught by CI: no CI job builds or
runs the image.

- **`next build` still needs a `DATABASE_URL`; the image supplies a
  placeholder.** `src/db/index.ts:33` calls `env.databaseUrl()` at module
  scope, `required()` throws when `NODE_ENV === "production"`, which is what
  `next build` sets, and Next imports every route module while collecting page
  data. `apps/app/Dockerfile` (build stage, L40-48) sets build-only
  placeholders for `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` and
  `HEALDESK_PROVISION_SECRET`, so the image no longer needs a real database URL
  at build time. A bare `next build` outside Docker still fails without one;
  CI passes only because `DATABASE_URL` sits in the job-level env.
- **The optional AWS SDKs are baked in as unconditional throws.**
  `crypto/kms.ts:132` and `reporting/deliver.ts:392` route the import specifier
  through a `const` "so TypeScript can't resolve it statically". Turbopack
  resolves it anyway and inlines `throw MODULE_NOT_FOUND` into the server
  chunk: the 12 September production build still in
  `apps/app/.next/server/chunks` shows it for both `@aws-sdk/client-kms` and
  `@aws-sdk/client-sesv2`, and neither that pattern nor `next.config.ts`
  (`serverExternalPackages` lists only `pg`) has changed since. Neither SDK is
  in `package-lock.json`, so an image built today carries the same throws, and
  adding the SDK to the runtime stage after the build cannot undo them. Whether
  installing it before `next build`, or listing it in
  `serverExternalPackages`, is enough has not been tested. Consequence: in
  production `getKeyWrapper()` has no KMS and refuses `LocalKeyWrapper`, and
  the SES transport can never send. Re-check with a fresh production build
  after any fix.
- **Static assets are in the image; the host is not described anywhere.**
  `.next/static` is still not part of Next's standalone output, but the
  Dockerfile (L64-65) copies it beside `server.js`. There is still no compose
  file, `fly.toml`, Terraform or task definition in the repo.
- **The worker, migrations and queue install ship in the image as separate
  commands.** The Dockerfile (L67-76) copies the whole workspace
  `node_modules` (`tsx` is a runtime dependency; `drizzle-kit` is there only
  because the deps stage installs dev dependencies), `src/`, `drizzle/`,
  `drizzle.config.ts` and `scripts/`.
  The default command, `node apps/app/server.js`, is the web tier only; the
  worker is `npm run worker -w @healdesk/app`; migrations and `queue:install`
  run once as the migrator from an operator's shell or a CI job, never at boot.
- **There is no process for the voice agent.** Next route handlers cannot
  accept WebSocket upgrades, and Retell holds a WebSocket open for the whole
  call, so the Retell custom-LLM endpoint needs its own long-lived Node
  process: a third command in the image and a row in the Deployment table
  below. Nothing in `apps/app` implements it yet; `src/lib/voice/` still
  ingests Synthflow webhook payloads.

Fix these before promising a deploy date for `apps/app`.

---

# Product rules the code enforces

Every rule below comes from `docs/v1-product-spec.md`. They are enforced in code
around the model, never left to a prompt. Several of the surfaces they govern are
not built yet, and some existing code predates them (the account is still
created on `checkout.session.completed` and only activated by `invoice.paid`;
`lib/meta/front-door.ts` books nothing and takes booking requests instead). Read
the code before assuming a rule already holds, and treat a gap as a bug, not a
precedent.

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
  account has a payment method; phone once call forwarding is set, usually the
  same day. Never "live in two minutes".
- The overage rates ($0.80 a voice minute; $0.40 a chat conversation on the
  single-channel chat package and $0.30 on the rest, set by the owner on 5
  October 2026) are provisional until measured. Copy says so; the billing
  mechanics stay as they are.
- "healdesk is a service of Viixi FZC, a company registered under the Sharjah
  Publishing City Free Zone, United Arab Emirates" appears in the site footer
  and on the Terms and Privacy pages. The registered street address is not
  known yet: it is never guessed, and it renders only once someone fills it in.

---

# The clinic portal (v1)

Clinics sign in. v1 has a clinic portal and an onboarding wizard, served by
`apps/app` because they show transcripts and bookings. Neither is built yet.
Build them from the spec's "Account access and credentials", "Portal map",
"Every switch in the portal" and "What the portal does not have".

- **Seven screens, nothing nested more than one level deep:** Home, Channels,
  Behaviour, Knowledge, Conversations, Bookings, Billing. Invoices, the payment
  method and cancellation deep-link into Stripe's own portal.
- **Getting in.** Payment creates the account against the billing email and
  lands the buyer in the wizard, already signed in through a one-time link. The
  welcome email carries a sign-in link, never credentials. Setting a password is
  optional; the magic link alone is enough.
- **A second factor before any transcript opens**, and every open writes an
  access-log row. Toggles, billing and knowledge edits do not need it.
- **Three roles:** owner (everything, including billing and cancellation),
  manager (everything except billing), billing contact (invoices and payment
  method only; never transcripts). Dunning goes to the owner and the billing
  contact, never to the clinic's public inbox.
- **The wizard is four steps:** confirm the pre-filled basics; set behaviour
  (tone, greeting, deposit toggles and the gateway, voice coverage mode,
  escalation contacts); connect Google Calendar; connect the channels bought.
  Every step saves as it completes, and a clinic resumes from the link in its
  welcome email.
- **Every connection is a login button:** Google Calendar OAuth, Facebook
  login, WhatsApp embedded signup, the gateway's own connect flow. A clinic never
  pastes a key or a credential. The single-use `/connect/[token]` credential
  handover in `apps/app` today belongs to the phase-two read-back.
- **The support chat** carries a permanent line telling staff not to paste
  patient information, and is retained as a non-patient channel.
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
| `apps/app` | Vercel project #2 → BAA host (AWS, `us-east-1`) | `apps/app` | **Yes** |
| `apps/app` worker | Same BAA host, separate process | `apps/app` | **Yes** |
| `apps/app` voice endpoint (Retell custom-LLM WebSocket) | Same BAA host, separate long-lived process | `apps/app` | **Yes** |
| `packages/leadgen` | Not deployed | — | No |

The BAA host is the AWS account designated under the AWS BAA, in `us-east-1`
(`docs/policies/aws-hipaa-account.md`). The database is either AWS RDS under
that agreement or Neon on its Scale plan under Neon's own BAA — the spec
recommends one of the two, and neither is chosen or provisioned yet. Vercel is a
BAA host only on Enterprise.

The voice endpoint cannot be a route handler or a serverless function. Retell
opens a WebSocket to it at the start of every call and keeps it open until the
call ends; Next route handlers cannot accept a WebSocket upgrade, and serverless
functions cannot hold one open. Run it as its own Node process from the same
image as the web tier and the worker, so all three ship the same schema and the
same tool layer.

Two environment variables decide origins and are easy to confuse:

- `HEALDESK_APP_URL` (set on `apps/web`) — the **internal** address used to
  reach `apps/app`. Never browser-visible. A wrong-but-present value is worse
  than unset: the guards pass and honest 503s become 502s.
- `BETTER_AUTH_URL` (set on `apps/app`) — the **public** origin used to build
  every clinic-facing link: today's connect and booking links, and in v1 the
  magic sign-in links, the wizard-resume link in the welcome email and portal
  URLs. It falls back to `http://localhost:3001` rather than throwing, so
  leaving it unset silently mails dead links.

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
