# Build rules for every ops-automation builder (read first, obey exactly)

You are one builder in a team led by the session that wrote this file. The plan is
`docs/design/ops-automation-2026-10-23/README.md`; your lane brief names the design file and steps.
The designs were written by agents: **verify in the code anything you rely on.** If the code already does
what a step asks (Phase 1 landed parts of E2, E3, E4 on 23 Oct), skip that part and say so.

Owner standing instruction for every screen: "VERY CLEAR AND EASY TO UNDERSTAND, no repetitions, no need for
information that is not useful for the ops but just adding noise."

## Owner decisions already made (23 Oct 2026)
D1, D2, D3, D9, D10 (Phase 1, live). D11 yes: the commit feed leaves Home for System → Changes; every old
admin URL redirects forever. D8 yes: ops change files stay for closures/roster; a trigger records them.
D4 keep the spec's six setup reminders (+ one per channel after go-live), plus non-reminder notices; anything
sent by hand opens an EDITABLE draft first (through the approval inbox, a later wave); a rules-based
"recommendation" (extend N days / offer call / let close) is shown beside it. D5 leave HEALDESK_OPS_EMAIL as
is (routine waves Slack only, email for escalations). D6 days waiting on us do NOT extend the deadline
automatically (button only). D7 the day-22 "decide" alert fires for every stalled clinic. E7: Tier 1 only (a
button that pre-fills a prompt; no unattended Tier 2). Clinics' synthetic/demo rows are hidden behind a filter.
All other README decisions (D12 to D23) are NOT answered: do not build what depends on them.

## Isolation (non-negotiable)
- Work only in your own worktree (named in your brief) on your own branch. Never `cd` to
  `/Users/liamariavisoiu/projects/healdesk.io` (the shared main checkout, dirty, other sessions use it).
  Never `git stash` (shared stack). Never `git add -A` outside your worktree.
- `npm ci` has been run in your worktree. If a command needs a missing dependency, report; do not symlink
  another checkout's node_modules.
- **No push, no merge, no rebase onto main, no force anything.** Commit on your branch only.
- Do NOT edit `AGENTS.md`, `CLAUDE.md`, `docs/v1-product-spec.md`, anything under `.github/` (unless your
  brief says so), `infra/` (unless your brief says so). The lead edits AGENTS.md.
- Never run AWS, Terraform, `gh workflow run`, deploys, or any vendor call. Never use production credentials.
  Tests use synthetic data only.
- Commit trailer, exactly this last line of every commit message (you will forget; check with
  `git log -s --format=%B`): `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`
- Commit messages explain WHY, in prose, naming the failure the change prevents (repo style).

## Database for DB-backed tests (apps/app)
Your own throwaway Postgres: unique container and port from your brief. Recipe (mirrors CI):
```
docker run -d --name <container> -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=healdesk_test -p <port>:5432 postgres:17-alpine
# wait for pg_isready, then (psql on the host or docker exec; copy the file in with docker cp):
psql postgres://postgres:postgres@localhost:<port>/healdesk_test \
  -v migrator_password=ci -v app_password=ci -v readonly_password=ci -v writer_password=ci \
  -f apps/app/scripts/provision-roles.sql
export MIGRATION_DATABASE_URL=postgres://healdesk_migrator:ci@localhost:<port>/healdesk_test?sslmode=disable
export TEST_MIGRATOR_URL=$MIGRATION_DATABASE_URL
export TEST_APP_URL=postgres://healdesk_app:ci@localhost:<port>/healdesk_test?sslmode=disable
export TEST_WRITER_URL=postgres://healdesk_writer:ci@localhost:<port>/healdesk_test?sslmode=disable
export BETTER_AUTH_SECRET=local-test HEALDESK_PROVISION_SECRET=local-test
npm run db:migrate -w @healdesk/app && npm run db:readonly-grants -w @healdesk/app && npm run db:writer-grants -w @healdesk/app
```
- **NEVER export `DATABASE_URL`** (tests/setup/env.ts does `DATABASE_URL ??= TEST_APP_URL`; an exported
  migrator URL runs app code as the migrator and hides grant bugs).
- Without `TEST_APP_URL` the database suites SKIP SILENTLY. A "passed" run with skips proves nothing about
  data; report the skip count. Re-run migrations after you add yours.
- Forced row-level security hides rows even from the table owner: a DB test must `set app.clinic_id`
  (see existing tests for the helper).
- Remove the container when done: `docker rm -f <container>`.
- Machine is under load from other sessions: never race the clock in tests; fake `Date`; run a changed test
  file alone, then the touched directory; the whole `apps/app` suite is CI's job (run it only if cheap).
  `guard-spanish.test.ts` "read in time" is a known load flake.

## Hot files: one writer per file
Hot: `apps/app/src/lib/ops/{api,notify,digest,slack}.ts`, `apps/web/src/lib/admin/{ops-client,system-map}.ts`,
`apps/app/src/db/schema.ts`, `apps/app/scripts/readonly-tables.ts`, `apps/app/src/lib/email/{kinds,lint}.ts`,
the email templates registry, `apps/web/src/app/admin/ops/OpsConsole.tsx`, `drizzle/**` and its
`meta/_journal.json`, `AGENTS.md`.
- Your brief lists the files you OWN. You may edit those freely.
- A hot file you do not own: make **only additive edits** (a new `case`, an import, a new table block, a new
  classification line, a new event name), all in ONE final commit whose subject starts `REGISTER:`. The lead
  merges REGISTER commits in order and resolves trivial additive conflicts. Never reformat, reorder or
  rewrite lines you did not add.
- A file you need that is neither owned nor hot-additive: STOP and report which file and why. Do not edit it.
- Put new operation logic in your OWN new file (e.g. `lib/ops/audit-ops.ts`), not inside `api.ts`.
- Migrations: use exactly the number your brief reserves. Drizzle skips a migration whose `when` timestamp is
  lower than the newest applied one, so set `when` in the journal strictly above main's latest (the lead
  re-checks at landing). New tables: RLS like their neighbours, runtime-role grants, and classified in
  `readonly-tables.ts` (a test fails otherwise).

## Product and safety rules (CLAUDE.md, restated where builders trip)
- PHI boundary: `apps/web` has no database client and no PHI; it reaches `apps/app` only through the
  HMAC-signed ops envelope, by adding typed operations. `apps/app` stays plain Node (no `@vercel/*`, no edge).
- Ops mail and Slack carry ids, counts, dates, enums and the clinic's NAME only (Phase 1 allow-list in
  `lib/ops/slack.ts` / `notify.ts`). Never a patient field, conversation text, free text typed by a clinic,
  a calendar event title, a phone number or an address. Alert slots are "in N days", never a time.
- Nothing contacts a patient first. Clinics are not patients. Patient-related mail is a pointer into the portal.
- Claims: never "revenue", "collected", "recovered"; "booked by AYA" and "calls answered" are fine.
- A new email kind needs: the registry, the allow-list, TWO CHECK constraints and a migration. The email link
  scanner accepts only the app origin, Stripe, and (for `ops_alert`) the console origin on `/admin/` paths.
- Every new key/variable/vendor/connection goes in `/admin/map` (`system-map.ts`: TOOLS, BRIDGES, KEYS or
  NOT_KEYS), and AWS-side keys in `key-presence.ts`. A test fails on a variable neither list knows.
- Console links in alerts must point at pages that exist (`/admin/ops/<id>/care` or `/onboarding` until the
  admin shell lands; old URLs will keep redirecting after it).
- Jobs follow the existing convention (seeded OFF with a named switch in `/admin/ops`, owner flips it) unless
  your brief says otherwise; read how `ops-slack` (Phase 1) and `usage-alerts` do it.
- Scope discipline: build the steps named, nothing wider. The portal's "must never grow" list is untouched.

## Before you report
Run: `npx tsc --noEmit -p apps/app` (and `apps/web` if you touched it), `npm run lint` for touched
workspaces, your new tests, the neighbouring test directory, and the `readonly-tables` and `system-map` tests.
Then write your report in the format below. **Report only what you ran; say what was skipped.**

## Report format (your final message)
1. Branch, HEAD sha, commits (subjects), files changed (count + list).
2. Steps done / skipped (and why) / found already built.
3. Tests run: command, files, passed/failed/SKIPPED counts. Database suites: confirm `TEST_APP_URL` was set.
4. Forbidden files untouched? (list `git diff --stat origin/main..HEAD` for hot files and say which are REGISTER).
5. Anything you could not verify, assumptions, risks, questions for the owner (decisions only the owner can make).
6. Container removed? Commit trailers checked?
