# Lane B: availability changes and audits (Phase 3) — builder: Opus

Read `RULES.md` first. Worktree `/Users/liamariavisoiu/projects/healdesk-ops-b`, branch
`ops/b-changes-audits`. Postgres: container `hd-ops-b-pg`, port `55502`. **Reserved migration: `0114`** (name it
`0114_clinic_changes_and_audits`). Designs: `designs/E4-clinic-dashboard.md` and `designs/E3-monitoring-audits.md`.

## Goal
When a clinic changes its hours, closed days, providers or provider services, ops gets a recorded event (and
the Phase 1 Slack/mail path), and an audit runs by itself and again on demand; the result is readable per clinic.
Decision D8 yes: ops change files (`db-apply`) stay allowed on `clinic_closures`, `clinic_providers`,
`clinic_provider_services`; a database trigger makes every such edit visible as a `source='direct'` event.

## Steps (verify each against `main` first: Phase 1 already built the closed-days proof
`tests/closure-blocks-bookings.test.ts`, `lib/clinic/closures.ts openGiven`, the portal toast/email for bookings
on a newly closed day, `calendar_write_stuck`, Slack from apps/app, console links. Skip what exists; say so.)
- **E4-1** table `clinic_change_events` + `lib/clinic/change-events.ts recordClinicChange(tx, …)` called INSIDE the
  save transaction from `saveHours` (`lib/setup/practice.ts`), `saveProviders` and `setProviderServices`
  (`lib/connections/google-calendar.ts`), and the location-hours writer (`lib/portal/location-details.ts`). A
  refused/rolled-back save emits nothing. `summary` holds counts and dates only. Classified in
  `readonly-tables.ts`; NOT writable by db-apply (`WRITABLE_TABLES` unchanged).
- **E4-7** statement-level trigger on the three writable tables inserting a count-only `source='direct'` row unless
  the transaction set `app.change_emitted`. Prove with the real db-apply path as `tests/db-apply.test.ts` does
  (writer role; one run, one row). Remember forced RLS: tests set `app.clinic_id`.
- **E4-2** `clinic_availability_changed` OPS_EVENT raised after commit (never able to fail the save), 1-hour
  dedupe per clinic and kind, ids/counts/dates and the clinic NAME via the Phase 1 allow-list; six saves in an
  hour = one alert. Register the event in `notify.ts` and the Slack allow-list (REGISTER commit).
- **E3-1/E3-2** table `clinic_audits` (design columns, last 20 rows per clinic and pack kept), registry
  `lib/audits/checks.ts`, runner `lib/audits/run.ts` (20 s budget per check, a throwing check = `error`, never
  fails the clinic's save, GET-only vendor calls), packs `golive`, `transcripts`, `availability` (all ten checks
  in the table; `assistant_knows_closures` should now PASS because Phase 1 fixed F1, assert that), `roster`.
  Export the answer gate's pure closed-day decision from `lib/billing/answering.ts` (export only, no behaviour
  change; an existing test must still pass). `slots_honour_closures` uses the real `computeAvailability`.
  `bookings_on_closed_days` returns COUNTS only.
- **E3-3** triggers: post-commit pg-boss `clinic-audit` with singleton key per clinic + 2-minute debounce
  (six saves = one audit); hourly fingerprint comparison for `change_detected` (catches db-apply/website edits
  that call no hook); scheduled run 04 UTC after the drift check. Register jobs per the repo convention
  (read how `ops-slack` and `usage-alerts` are seeded and switched; report what the owner must switch on).
- **E3-4 + E4-3 (apps/app half)** typed ops operations in your own files `lib/ops/audit-ops.ts` and
  `lib/ops/change-ops.ts`: `runClinicAudit {clinicId, pack?}` (write op: records a security event naming the
  operator, synchronous, live probes allowed on manual runs, a per-clinic cool-down so it cannot be spammed),
  `clinicAudits {clinicId?}` (the E3 §2.5 shape; latest per pack per clinic or one clinic's history),
  `listClinicChanges {clinicId?, since?}`, `acknowledgeClinicChange {id}`. Mirror them in `ops-client.ts`
  (REGISTER commit, additive) with contract tests. DO NOT touch `apps/web/src/app/admin/**` (the admin lane owns
  all screens; the panels come in a later wave).
- **E4-6** clinic copy in the portal (Knowledge → Hours card lines, Booking detail line, status line "In use
  since…/We're checking your change…"), EXACT wording from E4 §3.D. Check what the Phase 1 toast already says; do
  not duplicate or contradict it. Owner wording from Phase 1 (`closed_day_bookings` email) is untouched. Files:
  `app/c/[slug]/knowledge/**`, `settings/CalendarControls.tsx`, `lib/portal/knowledge.ts`. If a design line
  conflicts with must-never-grow, skip it and report. The release of live holds on a newly closed date
  (`releaseLiveHolds` `dates` filter, reason `closure_added`): check if Phase 1 did it; if not, build with a test.
- NOT in this lane: Slack/email plumbing (exists), calendar backoff, voice drift, console panels, digest changes.

## Files you OWN
`apps/app/drizzle/0114_*` (+ journal entry, `when` above main's latest), `apps/app/src/lib/audits/**`,
`lib/clinic/change-events.ts`, `lib/ops/audit-ops.ts`, `lib/ops/change-ops.ts`, `lib/setup/practice.ts`,
`lib/connections/google-calendar.ts` (the two functions only), `lib/portal/location-details.ts`,
`lib/portal/knowledge.ts`, `app/c/[slug]/knowledge/**`, `app/c/[slug]/settings/CalendarControls.tsx`,
`lib/booking/holds.ts`, `lib/billing/answering.ts` (export only), job/tick registration files, their tests.
**REGISTER (additive, final commit):** `db/schema.ts`, `scripts/readonly-tables.ts`, `lib/ops/api.ts`,
`lib/ops/notify.ts`, `lib/ops/slack.ts` allow-list, `apps/web/src/lib/admin/ops-client.ts` (+ its tests),
`system-map.ts` (job/bridge words only if a test requires). Another lane (C1) reserves 0115 and also adds
tables/events to the same hot files: expect a trivial merge.

## Tests required (real database; report SKIP counts)
- `clinic-change-events.test.ts`: a saved closure adds one row `{kind: closures, source: portal, actor …, added:[D]}`;
  a refused save adds none; roster save adds one row with counts; six saves → one alert; a rolled back
  transaction leaves no row and no alert.
- `db-apply` trigger test as above. `readonly-tables.test`. `audits-*.test.ts`: a fixture per check yielding
  pass/warn/fail; closed date gives no slots; a booking on a newly closed date yields warn with a COUNT; a
  throwing check yields `error` and the pack still stores; retention keeps 20; debounce; fingerprint detects a
  direct insert; `runClinicAudit` cool-down and security event; ops contract tests; no result field holds a
  name, time, address or free text (walk the JSON).
- Migration applies from zero and on top of 0113 (run both paths) and the journal order is right.
- `tsc` on apps/app and apps/web, lint, neighbouring suites (`closure-blocks-bookings`, `knowledge-screen`,
  `calendar-providers`, `db-apply`, `ops-alerts`, `ops-slack`).

## Report: RULES.md format; also state what the owner must switch on after deploy, and the exact audit result
JSON for one passing and one failing fixture.
