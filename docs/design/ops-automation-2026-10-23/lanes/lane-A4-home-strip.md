# Lane A4: fill the Clinics columns, add the Home rows, trim two heavy reads (wave 2) — builder: Opus

Read `RULES.md` first (trailer EXACTLY `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`).
Worktree `/Users/liamariavisoiu/projects/healdesk-ops-a4`, branch `ops/a4-home-strip`, cut from branch `ops/integ2`
(main plus lanes G, H, N1 and A3, not yet landed). Postgres container `hd-ops-a4-pg`, port `55524`. **No migration.**

## Why
Wave 1 built the Clinics table and Home with two columns and several rows deliberately empty ("not measured yet")
because the tables they read (`clinic_change_events`, `clinic_audits`, `lifecycle_waves`) came from other lanes.
Those landed. Now the strip and the inbox read them, so the owner's morning list says what needs him.

## What to build
1. **Strip columns** (`apps/app/src/lib/ops/strip.ts`, contract `apps/web/src/lib/admin/strip-types.ts`, which you
   must NOT edit): `availability` = `{changedAt, audit}`: `changedAt` the newest `clinic_change_events.changed_at`
   (null if none), `audit` the `overall` of that clinic's latest availability audit (`pass|warn|fail|running|never`,
   same rule `clinicAudits` uses; read `lib/ops/audit-ops.ts` and reuse its function rather than copying the logic;
   when changes are waiting and the `clinic-audits` job is off, report `never`, and say in the report how the
   contract's `AuditLevel` copes with audits_off: the contract has no such value; if it needs one STOP and ask
   the lead); `lastReminder` = `{day}`: the setup-window day of the newest clinic-email wave (`setup_reminder:<n>`)
   from `lifecycle_waves`, or `{day: null}` for a clinic with no reminder yet, `null` ONLY for a clinic the
   lifecycle watch does not cover. Keep the strip's per-clinic statement count bounded (the wave-1 test counts it):
   add queries only inside the existing per-clinic transaction.
2. **Inbox sources** (`lib/ops/inbox/`, one file per source, registered in `sources.ts`, each caught on its own
   as the others): (a) availability: a clinic whose latest availability audit is warn/fail, or that has unseen
   changes with no audit run (audits off), or a change not yet marked seen older than 1 day: one row per clinic,
   plain one-sentence text, link `/admin/clinics/<id>/setup#availability`; (b) "Needs a decision": every clinic
   with a decision owed per the lifecycle view (`decisionOwed` in `lib/lifecycle/view.ts`, reuse it), sentence
   including the watch's recommendation, link `/admin/clinics/<id>/setup#setup-window`, `dueAt` the setup window's
   last day, tone `bad` when 3 days or fewer remain. Each row's button is a LINK (the op-button allow-list in the
   console stays empty). Sentences are plain English with no codes, per the owner's rule.
3. **Old links**: `lib/ops/inbox/ops-alerts.ts` (flag_alert), `lib/ops/inbox/health-flags.ts`, `flag-alert` and any
   other place in apps/app that builds `/admin/ops/<id>/...` or `/admin/setup`, `/admin/support` and other retired
   console paths (grep `apps/app/src` for `/admin/`): use lane N1's helpers (`opsConsolePath` /
   `opsConsoleLink` in `lib/ops/notify.ts`, the shape `/admin/clinics/<id>/<tab>#<event>-<alertId>`) and pass the alert
   id where the row has one, so the console scrolls to the issue; update their tests.
4. **Two heavy reads**: `listLifecycle` gets an optional `clinicId` argument (validated uuid) that reads only that
   clinic (today it loops over every billing clinic); `clinicAudits` takes an optional `history: false` /
   `limit` so a page that does not show history does not fetch it (default unchanged for existing callers, but cap
   history at the newest 50 rows). Mirror both in `apps/web/src/lib/admin/ops-client.ts` (REGISTER-style additive:
   `fetchLifecycle(clinicId?)`, `fetchClinicAudits(clinicId?, {history?})`), then make lane A3's Setup page
   (`apps/web/src/app/admin/clinics/[clinicId]/setup/page.tsx`, the two call sites only) pass them. Tests both sides.
5. **Two gaps A3 hit in ops-client**: `LifecycleWriteOutcome` lacks `auditRecorded` (apps/app's decide/snooze
   write an audit row; return `auditRecorded` like the neighbour operations do and mirror it so the cards can warn
   "the audit entry could not be written"), and a `LifecycleWave` carries no `event` name: add `event` (the
   `ops_alerts.event` of the alert the wave points at, null for clinic-email waves) to `listLifecycleWaves` and the
   mirror, and change A3's `Reminders.tsx` `waveWords` to use `event` for day-22/27/30 (decision vs closing-soon)
   instead of `escalated` (keep `escalated` as the fallback). Tests both sides.

## Files you OWN
`apps/app/src/lib/ops/strip.ts`, `lib/ops/inbox/**`, `lib/ops/lifecycle-ops.ts`, `lib/ops/audit-ops.ts`,
`lib/lifecycle/view.ts` (read mostly), `lib/ops/flag-alert.ts`, `lib/ops/health-flags.ts`, their tests; apps/web:
`ops-client.ts` (additive, one commit titled `REGISTER:`), A3's `setup/page.tsx` call sites and
`deliveries/Reminders.tsx` `waveWords`. Not `strip-types.ts`, `AGENTS.md`, `CLAUDE.md`, `docs/on-call.md`, migrations.

## Tests
Real database (RULES.md). The wave-1 strip and inbox tests stay green and gain cases: a clinic with a change and a
failing audit; with changes and audits off; with decisions owed; one with no lifecycle row; the N+1 test still
bounded; each new source degrades alone; every inbox link starts with `/admin/` and points at a page and anchor
that exist in apps/web (assert by reading apps/web's source for `id="availability"`, `id="setup-window"`).
apps/web: ops-client contract tests for the new arguments and fields; the full web suite stays green.

## Report
RULES.md format; the strip's new statement count per clinic; every new inbox sentence (paste); any contract gap.
