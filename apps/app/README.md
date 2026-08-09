# @healdesk/app

The internal console and the PHI boundary. Deploys to `admin.healdesk.io` on
AWS — **not** to `healdesk.io`, which runs on Vercel and has no BAA.

> ⚠️ Read [docs/hipaa-compliance.md](../../docs/hipaa-compliance.md) before
> touching anything here. No real patient data until a BAA is in place with
> every vendor in the path; the database enforces this.

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

### 4. The BAA gate

A clinic starts `synthetic`. Marking it `production` without `baa_signed_at`
makes every PHI write fail at the database. *"Synthetic and seed data only"* is
a constraint, not a note in a document someone has to remember.

---

## Layout

```
src/
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
  proxy.ts           Next 16's middleware. A redirect, NOT a security boundary
drizzle/
  0000_init          tables
  0001_security_functions
  0002_rls_policies
  0003_grants        append-only audit_log lives here
  0004_baa_gate
scripts/
  provision-roles.sql  run once as superuser, before the first migration
  dev-db.sh
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
- **Never log PHI** — not to stdout, not to an error tracker.
- Regenerate `auth-schema.ts` with the Better Auth CLI; hand edits are limited
  to indexes.
