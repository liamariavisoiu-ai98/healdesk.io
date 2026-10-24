# Lane A3: the console screens the new alerts point at (wave 2) — builder: Fable

Read `RULES.md` first (trailer EXACTLY `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`). You are the same
builder who made the admin redo in wave 1 (lane A1): the shell, `ui.tsx` primitives and its rules are yours to reuse.
Worktree `/Users/liamariavisoiu/projects/healdesk-ops-a3`, branch `ops/a3-admin-panels`, cut from main `1fa04a6f`.
apps/web only, no database; `npm test -w @healdesk/web -- <files>`. Owner's rule for every screen: VERY CLEAR AND
EASY TO UNDERSTAND, no repetition, no information that is not useful for the ops.

## Why
Wave 1 landed the operations behind these screens (availability change events and audits, the lifecycle watch) but
built no screen for them: the new plain-English alerts (lane N1) could not honestly say "open X to see the change"
or "press the Extend button to record your decision" because those controls do not exist. Build them, with EXACTLY
the names below, because the alert wording (lane N2) will quote them and a test checks each quoted name appears in
apps/web's source.

## What to build (all use ops-client functions that already exist on main; read their types)
1. **Setup tab, card titled "Availability changes"** (clinic panel, `clinics/[clinicId]/setup`): from
   `fetchClinicChanges({clinicId})` and `fetchClinicAudits(clinicId)`: the last changes (what changed in words: hours,
   closed days added/taken off, location hours, providers, services; when; by whom in the coarse actor words
   "the clinic", "ops", "a change file", "outside the portal"), whether each has been seen, and the latest result of
   each audit pack (pass/warn/fail, running, never, "audits are off", with the failing checks' hints in plain words).
   Buttons: **"Run audit now"** (`runClinicAudit`; disabled while running; shows the outcome line: ran, busy, too
   soon, closed account) and **"Mark as seen"** (`acknowledgeClinicChange`). Anchor `#availability` so an alert link
   can land on it. An empty card says "No changes yet." not a zero.
2. **Setup tab, card titled "Setup window"**: from `fetchLifecycle()` filtered to this clinic: stage in words, days
   left, steps left, last progress, the decision so far, whether alerts are snoozed and until when, and the
   recommendation sentence the watch computed (it is already plain text: show it, do not recompute). Buttons:
   **"Extend the setup window"** (the existing `extendSetupDeadline` control: reuse the Billing tab's component or its
   action, 1 to 30 days, with the fresh-code step it already has; the card shows the recommended number of days as the
   default), **"Offered a call"** (`decideLifecycle` `extension_offered`), **"Let it close"** (`decideLifecycle`
   `let_close`, with a one-sentence confirm: "The clinic's setup window will close on its last day; ops alerts about
   it stop."), **"Snooze alerts"** with 3, 7 or 14 days (`snoozeLifecycle`). Anchor `#setup-window`. Only for a clinic
   the watch covers; others show nothing (not an empty card).
3. **Deliveries tab, section titled "Reminders"** (lifecycle ledger, `fetchLifecycleWaves(clinicId)`): one line per
   reminder or ops wave: what, to whom (the clinic, ops email, Slack), when sent, delivered/bounced/failed/skipped (read
   the words the API gives; skipped as "snoozed"), and that a clinic's six setup reminders are included. Newest first.
   Anchor `#reminders`.
4. **Home rows**: nothing to do in apps/web beyond what the inbox draws; lane A4 (apps/app) adds the rows (availability
   audits not green or audits off with changes waiting; setup decisions owed). Make sure `InboxList` draws `op` and
   `link` buttons for them correctly and that a row's link can carry a hash anchor (`#availability`, `#setup-window`):
   extend `consolePath` validation in `ops-client.ts` ONLY if a hash is currently refused (it is a hot file: additive,
   one small commit titled `REGISTER:`), and test it.
5. **Billing tab**: the usage-alerts switch label "80% and 100% emails" is wrong; the first email goes at
   `USAGE_ALERT_PERCENT` (90, `@healdesk/catalog`): import it and print "90% and 100% emails".
6. Fix the stale comment in `lib/admin/issue-link.ts` (alerts now emit `/admin/clinics/<id>/<tab>#<event>-<alertId>`),
   and make `IssuePanel` draw for those hashes (it does) AND scroll to a matching card anchor when the hash's event is
   `clinic_availability_changed` (`#availability`) or a lifecycle event (`#setup-window`): add a small map and test.
7. Home's inbox rows for the new sources are drawn from `InboxRow` already; no change to `strip-types.ts` (lead owns it).
   The Clinics table's Availability and Last reminder columns fill automatically once lane A4's strip returns values
   (they print "not measured yet" until then): check the table handles every `AuditLevel` and a `lastReminder` of
   `{day: null}` and `{day: n}` with test fixtures.

## Files you OWN
`apps/web/src/app/admin/clinics/[clinicId]/{setup,deliveries,billing}/**`, `components/admin/**`,
`lib/admin/{issue-link,clinic-rows,inbox*}.ts`, their tests, `ui.tsx`. Hot: `ops-client.ts` additive REGISTER only
(item 4). Not `apps/app`, not `strip-types.ts`, not `AGENTS.md`, `CLAUDE.md`, `docs/on-call.md`, `.github/`.

## Tests
Every new card and section: static-render tests with fixtures for each state (including "could not read"), the
buttons call the right ops-client function with the right arguments (mock ops-client), the confirm sentence for Let it
close, standby behaviour unchanged. Full `npm test -w @healdesk/web`, `npx tsc --noEmit -p apps/web`, `npm run lint`,
`npm run build -w @healdesk/web`.

## Report
RULES.md format; list every control name you built (they are quoted by alert wording), and what you did not build.
