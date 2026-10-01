# @healdesk/app

The product, and the PHI boundary. Every patient conversation, transcript and booking
lives here, and so will the clinic portal. It deploys to the BAA host on AWS — **never**
to the Vercel project behind `healdesk.io`, which has no BAA. Clinics reach it at the
public origin in `BETTER_AUTH_URL`, which every clinic-facing link is built from;
`apps/web` reaches it at the internal `HEALDESK_APP_URL`, which no browser ever sees.

What it must do is decided by [docs/v1-product-spec.md](../../docs/v1-product-spec.md);
where code goes is decided by [CLAUDE.md](../../CLAUDE.md).

> ⚠️ Read [docs/hipaa-compliance.md](../../docs/hipaa-compliance.md) before
> touching anything here. No real patient data until a BAA is in place with
> every vendor in the path — the clinic, Retell, Anthropic, the database
> provider and AWS; the database enforces the clinic's.

---

## Running it locally

```bash
npm run db:up -w @healdesk/app     # Postgres in Docker, both roles, migrated
# export the four URLs it prints
npm run dev:app                    # → http://localhost:3001
npm test -w @healdesk/app
```

`db:reset` rebuilds from scratch; `db:down` removes the container.

The dev database provisions **two roles**, matching production. That matters:
running locally as a single superuser would make every isolation test pass for
the wrong reason.

---

## What lives here: v1, and what the code holds today

Read out of the code on 30 September 2026. The left column is the spec; the right
column is what exists. Nothing on the left is done unless the right says so.

| v1 surface (spec) | In the code today |
| --- | --- |
| **Voice:** the Retell custom-LLM WebSocket endpoint, a long-lived process of its own, and the tool layer behind it (availability, 60-second slot holds, bookings) | Not built. `src/lib/voice/` ingests Synthflow post-call payloads |
| **Web chat:** the widget's API; every visitor message lands here | Not built |
| **Meta:** webhooks and send adapters for Instagram, Messenger and WhatsApp; booking and payment links inside the 24-hour window, enforced by the adapter; clinical content dropped at the boundary | `src/app/api/webhooks/meta` and `src/lib/meta/`: an earlier front door that books nothing and passes booking requests to the desk |
| **Bookings:** Google Calendar availability and idempotent writes, manual booking mode, the Bookings queue | Not built. `/booking/[token]` is the desk's accept/decline page for booking requests |
| **Deposits:** a hosted payment link through the clinic's own gateway, on web chat and Meta | Authorisation only: `src/lib/billing/connect.ts` and `/api/connect/stripe` store a Stripe Connect account id; nothing moves money |
| **Clinic portal and wizard:** seven screens, magic-link sign-in, a second factor before any transcript, owner / manager / billing-contact roles | Not built. `/api/auth` is Better Auth, invitation-only; there are no clinic sign-in pages |
| **Provisioning** on the first paid invoice | `/api/provision`, called by `apps/web`'s Stripe webhook on `checkout.session.completed`; `invoice.paid` (via `/api/billing/events`) then moves the clinic from `provisioning` to `active` |
| **The operator API** behind `/admin` in `apps/web` | `/api/ops` (HMAC-signed) |
| **The worker** | `src/workers/index.ts` and `src/lib/scheduler/`; the job list is in [docs/on-call.md](../../docs/on-call.md) |
| Phase two, fenced out of v1 | Built: `src/lib/attribution`, `src/lib/sync`, the connectors, the monthly report, and `/connect/[token]`, the one-time credential handover for read-back |

---

## The security model

Four mechanisms, each covering a different failure.

### 1. One door into patient data

There is no `db` export. `src/db/index.ts` exposes only `unsafeDb` — for the
identity plane and migrations — and everything else goes through
`withTenant()` in `src/lib/tenant.ts`.

A general-purpose handle is how tenant isolation dies: someone imports it in a
hurry, forgets the clinic filter, and one clinic reads another's patients. The
name is deliberately uncomfortable.

### 2. Row-level security underneath

The application filters by clinic *and* the database refuses to return other
clinics' rows. Two locks, because a missed `WHERE` in a hotfix is a reportable
breach.

The subtle part is **why every tenant query runs in a transaction**. RLS reads
the tenant from a Postgres setting. A plain `SET` is session-scoped, and
connections are pooled:

```
Request A → borrows connection → SET app.clinic_id = 'clinic-a'
Request A → finishes, connection returns to the pool
Request B → borrows the SAME connection → inherits clinic A's access
```

`set_config(..., is_local => true)` scopes it to the transaction, so Postgres
clears it on commit or rollback whether or not we remember to.

Three more things that silently defeat RLS, all handled:

| Trap | Mitigation |
|---|---|
| Roles with `BYPASSRLS` ignore every policy — Neon's `neondb_owner` and Supabase's `service_role` both do | Runtime role has neither `SUPERUSER` nor `BYPASSRLS`; asserted by tests |
| A table's **owner** bypasses its policies | Migrations run as a different role; every PHI table is `FORCE ROW LEVEL SECURITY` |
| `current_setting()` in a policy is evaluated per row | Policies call a `STABLE` helper the planner hoists to an InitPlan |

`clinics` is the one deliberate exception — enabled but not forced, because a
forced `id = current_tenant` policy makes creating a clinic impossible. It holds
configuration, not PHI. Every table that holds PHI is forced.

### 3. The audit log cannot be rewritten

`audit_log` is append-only by **grant**, not convention: the runtime role has
`SELECT, INSERT` and nothing else. Even a fully compromised application process
cannot erase evidence of what it did.

Actor identity is a discriminated union (`user | service | connector | agent |
system`) with a `CHECK` on shape, plus a frozen `actorLabel`. The FK goes null
when a user is deleted, and an audit row reading "accessed by: nobody" is
worthless.

`assertNoPhi()` refuses to write metadata that looks like patient data — an
audit trail that leaks PHI is worse than none.

v1 adds one more reader to log: every time a clinic user opens a transcript in
the portal, behind its second factor.

### 4. The BAA gate

A clinic starts `synthetic`. Marking it `production` without `baa_signed_at`
makes every PHI write fail at the database. *"Synthetic and seed data only"* is
a constraint, not a note in a document someone has to remember.

---

## Layout

```
src/
  app/
    api/             agreements, auth, billing/events, connect/stripe, health,
                     ops, provision, reviews/verify, webhooks/meta
    booking/[token]  the desk's accept/decline page for a booking request
    connect/[token]  one-time credential handover (phase-two read-back)
  db/
    schema.ts        Tenant plane. ⚠️ PHI
    auth-schema.ts   Better Auth tables — GENERATED, do not hand-write
    index.ts         unsafeDb only; no general-purpose handle
  lib/
    tenant.ts        withTenant() — the only door into PHI
    session.ts       session → clinic grant resolution
    auth.ts          Better Auth; sign-up is invitation-only
    audit.ts         AuditRecorder + assertNoPhi
    crypto/          envelope encryption, AAD bound to {clinic, credential}
    meta/            the Meta webhook's front door (predates the v1 spec)
    voice/           Synthflow payload ingest (predates the v1 spec)
    scheduler/       the worker's jobs
    attribution/, sync/   phase two
  proxy.ts           Next 16's middleware. Redirects nobody; NOT a security boundary
  workers/index.ts   the worker process
drizzle/             SQL migrations, 0000 onwards
scripts/
  provision-roles.sql  run once as superuser, before the first migration
  dev-db.sh
Dockerfile           one image: the web tier (default) and the worker
```

Migration order is load-bearing: roles → tables → functions → policies → grants.

---

## Tests

`tests/rls-drift.test.ts` is worth more than the rest combined. It doesn't check
the tables we wrote policies for — it asks the catalog which tables have a
`clinic_id` and demands each one be protected. It starts failing the day someone
adds a PHI table and forgets, which is the failure these tests exist to catch.

The isolation tests assume the application forgets its clinic filter and check
the database refuses anyway: cross-tenant read by known primary key returns zero
rows, cross-tenant write is rejected with `42501`, and a query with no tenant set
sees nothing at all.

Without `TEST_APP_URL` and `TEST_MIGRATOR_URL` the database suites skip rather
than fail, so `npm test` still works with no Postgres running.

---

## Conventions

- **Never import `unsafeDb`** outside `src/lib/auth.ts` and migrations.
- **No `@vercel/*` runtime packages**, no edge runtime, no platform KV. If it
  wouldn't run under `next start` in a container, it doesn't belong here.
- **The Retell endpoint is its own process.** Next route handlers cannot accept
  a WebSocket upgrade, so it runs as a plain Node server from the same image,
  beside the web tier and the worker.
- **Never log PHI** — not to stdout, not to an error tracker.
- Regenerate `auth-schema.ts` with the Better Auth CLI; hand edits are limited
  to indexes.
