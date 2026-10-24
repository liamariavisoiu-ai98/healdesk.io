# Lane P6c: the patient-rights tracker (Phase 6, wave B) — builder: Opus

Read `RULES.md` first (binding). Trailer EXACTLY `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; check every commit with
`git log -s --format='%(trailers:key=Co-Authored-By,valueonly)'`.
Worktree `/Users/liamariavisoiu/projects/healdesk-p6c`, branch `ops/p6c-rights`, cut from main `784297e2`. `npm ci` has run.
Postgres container `hd-p6c-pg`, port `55573`. **Reserved migration: `0120`** (lane P6a holds 0119 and lands first; set your journal `when`
strictly above `1792848051003` + 1 hour, i.e. use `1792855251003`, and expect the lead to re-chain your snapshot after 0119 at merge).
Design: `designs/E6-back-office.md` §3 item 16 (and §1 "Patient rights"). The design is old: **verify everything in the code**
(`apps/app/scripts/ops-*.ts`, `lib/patient-rights/*`, `ops-patient-request.ts`, `ops-erase-person.ts`, `amendments.ts`, `patient-export.ts`,
`docs/handover.md` sections "Deletion requests", "Amendments", "A request a patient makes to us", `infra/aws/scripts/run-task.sh`).

## Why
A patient may ask a clinic (and so us, its business associate) to erase, amend or export their record, or to pass a request on. The BAA
promises 10 business days for erasure and amendment and 5 for passing a request on. Today the pieces exist per clinic but nothing lists
the open requests across clinics with their clocks, and the owner has no prepared command to run for each. He asked for a tracker that
tells him what is due, never one that acts for him.

## Already decided (do not reopen)
- **D19:** the tracker TRACKS the missing deletion/amendment portal route (the BAA's 10 business days cannot be met on the AWS host
  for a request that arrives as words: there is no route that turns a person into a contact id) and ALERTS ops; it does **NOT** block go-live
  and is not a launch-promise blocker. A row in that state shows "Blocked: needs the portal route" while its clock keeps running.
- The assistant gathers and prepares; **the owner runs every command himself** (CloudShell). The tracker never runs, schedules or
  triggers `run-task.sh`, an erasure or an amendment. It shows prepared copy-text only: ids and fixed words.
- Nothing contacts a patient. No person field exists anywhere in the tracker: no name, email, phone, address, free text. The database
  rejects digits-runs and `@` in any text column that exists.
- Business days: use the existing `addBusinessDays` (read it: it is UTC weekdays; keep that and say so).

## What to build (apps/app, then apps/web clients; the screen is lane P6d, not yours)
1. **Migration 0120**: table `rights_intakes`: id, `clinic_id`, `kind` (`erasure`|`amendment`|`correction`|`export`|`patient_request`),
   `received_on` (date), `verified_via` (`notice_address`|`phone_confirmed`|`unverified`), `due_on` (date, computed at insert by the
   kind's clock), `status` (`open`|`done`|`not_applicable`), `linked_record_id` (uuid, nullable: the erasure/amendment/patient-request
   row it points to), `recorded_by` (operator label), `recorded_at`, `closed_at`. CHECK constraints for the closed lists; a CHECK or
   trigger that no text column can hold `@` or a digit-run; RLS and grants as the neighbours (tenant table: read how `lifecycle_*` or
   `patient_requests` tables do it), classified in `readonly-tables.ts`, `TENANT_SCOPED_TABLES`, closure/destruction code and
   `lib/retention/purge.ts`: **what happens to a rights record when the clinic's account closes is a legal question: keep the record
   (like the signed agreement) unless the code of a neighbouring table says otherwise, and say which you chose and why.**
2. **Operations** (own file `lib/ops/rights-ops.ts`; REGISTER the cases): `listRights {status?, limit?}` (read, cross-clinic): the open intakes PLUS
   the rows that already exist in the other tables and carry a deadline (erasure requests with their 10-business-day `deadline` and the
   vendor step stamp, patient requests with their day-5 clock, amendments if a due date can be derived: read `amendments.ts`; if none is
   stored say so and derive from the request date, labelled), each with: clinic id and name, kind, received, due, days left (business),
   state `on_time|due_soon|overdue|blocked|done`, the **prepared command** (see 4) and the Retell step for erasures (stamped or not).
   `recordRightsIntake {clinicId, kind, receivedOn, verifiedVia, linkedRecordId?}` (write, MUTATING, audit row + security event naming the
   operator, ids and dates only, idempotent on (clinic, kind, linked record, received_on)), and `closeRightsIntake {id, status}` (write).
   The write ops are plain (no fresh code: they record, they execute nothing).
3. **Clocks**: erasure and amendment 10 business days from `received_on`; export (read what the BAA/handover says; if no clock is stated
   use none and say so); patient_request 5 business days; erasure backup expiry 35 days shown as a separate fact. `due_soon` = 2 business
   days or fewer left. Write the clock table in code once (`lib/rights/clocks.ts`) with a comment citing BAA/handover sections.
4. **Prepared commands** (`lib/rights/commands.ts`): the exact `bash infra/aws/scripts/run-task.sh <task> <clinic id> <contact id> <who asked> <operator>`
   line per kind as the handover documents it, built from ids only; if a command needs a contact id the intake does not have, the row is
   `blocked` and the command is replaced by the sentence "No portal route yet turns this request into a contact id" (D19). A test asserts
   the builder emits only uuids, fixed task names and fixed words, never a person field, and that a shell metacharacter in an operator
   label can never reach the command (operator label must be matched against the same safe pattern the scripts require; read them).
5. **Alerting (D19)**: new ops event `rights_request_blocked` (a request has no route to run on the host: once per intake) and
   `rights_request_overdue` ONLY if the existing events `patient_request_past_due` / `patient_request_due_soon` do not already cover
   erasures and amendments (check; reuse them and extend their wording if they can be made to cover the new intake kinds rather than
   adding events). Follow the lead's traps for a new ops event: `OPS_EVENTS` (notify.ts), a section file in `alert-wording/` in the
   CURRENT format (`headline`, `urgency` in `urgency.ts`, `whatHappened`, `whyItMatters`, numbered `steps` that name only pages and
   buttons that exist), `EVENT_FIELDS`, `NO_CLINIC_PAGE`, the web mirrors (`ops-events.ts`, `fix-with-claude.ts`, `issue-link.ts`), a `### `
   heading in `docs/on-call.md`. The steps may name the page **"Patient rights"** (anchor `/admin/rights`) which lane P6d builds with the
   control names **"Record a request"**, **"Copy command"**, **"Mark done"**: write the wording against those names but do NOT add them to
   `places.ts` (the lead adds them with P6d); list them in your report.
6. **A job** `rights-watch` (seeded OFF, switch named in the migration, `tests/setup/db.ts`, `tests/delivery.test.ts`), daily: raises the
   blocked/due-soon/overdue alerts once per intake and state through `notifyOpsOnce`. A Home inbox source (`lib/ops/inbox/rights.ts`,
   registered in `sources.ts` and `INBOX_KINDS`; the test lists updated): one row "N patient requests are due within two business days"
   / "N are past their date", link `/admin/rights`.
7. **apps/web clients** (additive, REGISTER commit): `fetchRights`, `recordRightsIntake`, `closeRightsIntake` with strict parsers and contract
   tests.

## Files you OWN
`apps/app/src/lib/rights/**`, `lib/ops/rights-ops.ts`, `lib/ops/inbox/rights.ts`, `lib/scheduler/rights-watch.ts` (or the neighbours' convention),
`drizzle/0120_*`, `alert-wording/rights.ts` (new section file; register it in `alert-wording/index.ts`), their tests. HOT, additive only in ONE
final commit titled `REGISTER:`: `lib/ops/{api,notify}.ts`, `db/schema.ts`, `drizzle/meta/_journal.json` + snapshot, `scripts/readonly-tables.ts`,
`lib/ops/inbox/{sources,types}.ts`, `alert-wording/{fields,tabs,urgency}.ts`, `apps/web/src/lib/admin/{ops-client,ops-events,fix-with-claude,issue-link,system-map}.ts`
(system-map: only if you add a job or bridge), `docs/on-call.md` (new headings), `tests/{setup/db,delivery,ops-inbox}.test.ts` lists,
`offboarding/account-closure.ts`, `retention/purge.ts` (one line each). Not: `AGENTS.md`, `CLAUDE.md`, `slack.ts`, templates, `.github/`, `infra/`, apps/web pages.

## Tests (real database; skip count; fake the clock)
Clocks across weekends and a Friday received date; the table's text constraints refuse `@` and digit-runs; idempotent intake; the list merges the
existing rows without duplicating an intake that links one; `blocked` rows carry no command; commands contain only uuids and fixed words;
the watch job raises each alert once and is off by default; cross-clinic list excludes demo clinics unless asked; row security; migration/journal/
readonly/delivery/alert-wording/system-map tests; drizzle-kit "No schema changes". Run the FULL `npm test -w @healdesk/web` at the end.

## Report
RULES.md format. Also paste: the DDL, the clock table, the command builder's output for each kind (with fake uuids), every sentence the owner
will read, the control names you assumed for P6d, and every place you had to guess.
