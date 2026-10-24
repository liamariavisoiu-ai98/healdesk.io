# Lane G: let the change-file role write the roster tables (wave 2) — builder: Opus

Read `RULES.md` first (trailer EXACTLY `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`).
Worktree `/Users/liamariavisoiu/projects/healdesk-ops-g`, branch `ops/g-writer-grant`, cut from main `1fa04a6f`.
Postgres container `hd-ops-g-pg`, port `55522`. **Reserved migration: `0116`** (`0116_writer_baa_gate_execute`).

## Why (owner approved 23 Oct 2026: "Yes, small migration")
The db-apply role `healdesk_writer` may INSERT/UPDATE `clinic_closures`, `clinic_providers`,
`clinic_provider_services` (design `docs/design/db-access-2026-10-22.md`, owner decision D8). It cannot write the
last two: their BAA-gate trigger `app_enforce_baa_gate` (migration 0101; trigger set up in 0057) is SECURITY
INVOKER and calls `app_clinic_phi_update_permitted` / `app_clinic_accepts_phi`, which are granted only to
`healdesk_app`, so every change file on those tables fails with `permission denied for function
app_clinic_phi_update_permitted` (reproduced by two independent reviewers; closures work). The owner approved
granting EXECUTE on those two functions, which return only a yes/no, to the writer.

## What to build
1. Migration 0116 (hand-written custom migration; journal entry with `when` strictly above 0115's
   `1792766400000`; snapshot as drizzle needs for a custom migration, `drizzle-kit generate --custom` gives the
   pattern): `GRANT EXECUTE` on `app_clinic_phi_update_permitted(...)` and `app_clinic_accepts_phi(...)` (exact
   signatures from their latest definitions: grep all `drizzle/*.sql`) to `healdesk_writer` ONLY; confirm both are
   boolean-returning, that their bodies read nothing the writer lacks a right to read (the writer reads 19
   tables; if a function reads a table the writer cannot SELECT, find out whether it is SECURITY DEFINER; if it
   is invoker and needs more table grants, STOP and report instead of widening grants), and do not change
   `PUBLIC` grants. Idempotent (`DO` block checking the role exists) because the role is created by the
   provisioning scripts, not the migration; follow how 0114's `app_clinics_changed_in_transaction` grants to the
   writer conditionally.
2. Update `apps/app/scripts/writer-grants.ts` / `provision-roles.sql` ONLY if the pattern in this repo keeps the
   writer's function grants there rather than in migrations (read how the writer's other grants arrive; the
   migrate task on the host runs `db:writer-grants`): put the grant where the others are, and say which.
3. Tests with the REAL writer role (`TEST_WRITER_URL`, see RULES.md): new file
   `apps/app/tests/writer-baa-gate.test.ts`: (a) as `healdesk_writer` with `app.clinic_id` set, an INSERT into
   `clinic_providers` for a clinic that accepts PHI (its BAA state per the gate: read `app_clinic_accepts_phi`
   and the seed helpers) succeeds and writes one `direct`/`change_file` event row (lane B's trigger); (b) the same
   for `clinic_provider_services`; (c) for a clinic whose BAA does not permit PHI the gate REFUSES the writer's
   insert (so the grant did not open a way around the gate) and nothing is written; (d) an UPDATE path
   (`app_clinic_phi_update_permitted`); (e) the writer still cannot DELETE and still cannot read tables outside
   its list; (f) `tests/database-audit.test.ts` and `readonly-tables.test.ts` still pass (a new grant to a
   non-app role on a function is a "SECURITY DEFINER executable by app" check candidate: read that test's
   rules and update its INTERNAL/expected lists ONLY if its logic requires, with a reason).
   Update `tests/clinic-change-direct.test.ts`'s comment/tests that currently say the provider branches of the
   trigger are tested "as migrator only": add the writer-role provider-table cases next to them, in YOUR new
   file, not by editing that file except the comment.
4. `docs/design/db-access-2026-10-22.md` gets ONE short paragraph under the writer role's section recording the
   grant, the two functions, and the test; the file is yours for that paragraph only.

## Files you OWN
`apps/app/drizzle/0116_*` (+ journal and snapshot), `apps/app/scripts/writer-grants.ts` and
`provision-roles.sql` if step 2 says so, `apps/app/tests/writer-baa-gate.test.ts`, a comment in
`tests/clinic-change-direct.test.ts`, the paragraph in `docs/design/db-access-2026-10-22.md`. Do not touch
`scripts/db-change-file.ts` or `db-apply-lib.ts` (lane H owns them). Not `AGENTS.md`. Hot files: none expected; if you
need `readonly-tables.ts` or `schema.ts`, STOP.

## Report
RULES.md format; the two function signatures and what each reads; the exact test output lines for (a) to (e);
anything the grant newly allows that the owner should know (in one paragraph).
