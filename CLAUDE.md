# healdesk.io

Vertical AI front-desk / voice-agent service for high-ticket elective healthcare.

npm workspaces monorepo, Turborepo. `apps/web` (marketing + operator console),
`apps/app` (the product), `packages/{catalog,connectors,leadgen}`.

---

# THE PHI BOUNDARY — read this before adding any surface

Every placement decision in this repo follows from one split. Getting it wrong
is not a style mistake: it is the difference between a compliant architecture
and an uncovered hop through a vendor who signed no business associate
agreement.

`docs/hipaa-compliance.md` is authoritative for **what PHI is**. This file is
authoritative for **where code goes**.

## The test

> Does this handle **a patient's identity attached to health information**?

The line is the individual, not the industry. A clinic owner's own name, work
email and title are **business contact data**, not PHI — that is why checkout,
the contact form and the reviews all sit on the no-PHI side. A caller's phone
number *plus the treatment they asked about* **is** PHI.

## Where things go

| `apps/web` — NO PHI (Vercel) | `apps/app` — PHI (BAA-covered host) |
| --- | --- |
| Marketing, pricing, specialty/SEO content | Patient intake, consent, contraindication screening |
| Chat + voice demos (they talk to *owners*) | Call transcripts and recordings |
| Checkout, Stripe, BAA signing UI, download | The BAA register itself + retention clock |
| Contact form, reviews (business contacts) | Appointments, sync, reconciliation |
| The `/admin` operator console | **The attribution engine** |
| Anything public, cached, indexed | Connectors, booking webhooks, clinic credentials |
| | The background worker; anything writing an audit row |

## The shortcut that is always right

**If it needs the database, it goes in `apps/app`.**

`apps/web` has no database client at all — no Drizzle, no `pg`, no connection
string, and it must stay that way. That single fact is what makes the boundary
enforceable rather than aspirational.

## The three cases that catch people out

1. **The attribution engine is inside the boundary.** It feels like analytics,
   so it feels like it belongs next to a dashboard. But reconciling *who showed
   and what they spent* means named patients and their procedures. Anything
   read back out of a clinic's EMR/POS is inside too.

2. **The demos are on the no-PHI side only because of who they talk to.** They
   serve clinic owners from a generic knowledge tree. The day AVA answers a
   real patient's call, that path is PHI and moves to `apps/app`. This is why
   the voice agent is deliberately not built yet, and why `/api/callback` only
   *places* a demo call rather than handling one.

3. **`/admin` on `apps/web` is deliberate, not a shortcut.** It is our tool,
   not a clinic's — and note how it gets its data.

## The pattern to copy when `apps/web` needs PHI-side data

It does not get a connection string. It asks `apps/app` over an HMAC-signed
request, and `apps/app` decides what to return:

- `apps/web/src/lib/admin/ops-client.ts` → `POST /api/ops` on `apps/app`
- The reply is a hand-written projection — clinic configuration, scheduler
  state, contract metadata. Never a patient row.
- Even the clinic's one-time connect URL is composed upstream, because
  `HEALDESK_APP_URL` is an internal origin that must never appear in a browser
  (`ops-client.ts:405-411`).

Add a new operation to the ops envelope rather than widening what crosses.

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
data.** Synthetic and seed data only.

### `apps/app` is portable but NOT currently deployable

Audited 2026-09-12. The rules above all pass — no `@vercel/*`, no edge, plain
Node. The gap is in the build, and none of it is caught by CI:

- **`next build` fails without a live `DATABASE_URL`.** `src/db/index.ts:32`
  calls `env.databaseUrl()` at module scope, and `required()` throws when
  `NODE_ENV === "production"`, which is exactly what `next build` sets. Next
  imports every route module during page-data collection, so all six PHI routes
  trip it. CI never catches this because `DATABASE_URL` sits in the job-level
  env. A Docker image therefore cannot be built without injecting a real
  database URL at build time.
- **The optional AWS SDKs are baked in as unconditional throws.**
  `crypto/kms.ts:132` and `reporting/deliver.ts:388` route the import specifier
  through a `const` "so TypeScript can't resolve it statically". Turbopack
  resolves it anyway and inlines `throw MODULE_NOT_FOUND` into the server
  chunk. Installing `@aws-sdk/client-kms` or `client-sesv2` in the production
  image does nothing. Consequence: in production `getKeyWrapper()` has no KMS
  and refuses `LocalKeyWrapper`, and the SES transport can never send.
- **`.next/static` is not in the standalone output** and there is no
  Dockerfile, compose file, `fly.toml` or Terraform anywhere in the repo to
  copy it. The clinic's `/connect/[token]` page renders unstyled and
  unhydrated.
- **The worker, migrations and queue install live outside the artifact.**
  `node server.js` is the web tier only; the worker is `tsx src/workers/`,
  migrations need `drizzle-kit` (a devDependency) and `drizzle/*.sql`.

Fix these before promising a deploy date for `apps/app`.

---

# No clinic-facing software

Clinics never log into anything. healdesk is a service, not a tool a clinic
operates. A clinic grants read-only booking access exactly once, through a
single-use link we mail them — they click it, paste one credential, and are
finished forever. There is no account, no password and no session in that
story; the link *is* the credential.

A clinic-facing console was built once and deleted on 2026-09-12. Do not
rebuild it. `/admin` is the operator console and it is ours.

---

# Deployment

| Workspace | Target | Root directory | PHI |
| --- | --- | --- | --- |
| `apps/web` | Vercel project #1 | `apps/web` | No |
| `apps/app` | Vercel project #2 → BAA host | `apps/app` | **Yes** |
| `apps/app` worker | Same BAA host, separate process | `apps/app` | **Yes** |
| `packages/leadgen` | Not deployed | — | No |

Two environment variables decide origins and are easy to confuse:

- `HEALDESK_APP_URL` (set on `apps/web`) — the **internal** address used to
  reach `apps/app`. Never browser-visible. A wrong-but-present value is worse
  than unset: the guards pass and honest 503s become 502s.
- `BETTER_AUTH_URL` (set on `apps/app`) — the **public** origin used to build
  clinic-facing connect links. It falls back to `http://localhost:3001` rather
  than throwing, so leaving it unset silently mails dead links.

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
  out of a README, a directory listing, or a plan document.
- Commit messages here explain *why*, in prose, and are expected to name the
  failure the change prevents. Match the surrounding style.
- Tests: `npm test -w @healdesk/web`, `npm test -w @healdesk/app`. The ~155
  database-backed security tests **skip silently** without `TEST_APP_URL` —
  CI provisions the two-role Postgres and asserts they actually ran.
