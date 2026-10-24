# Lane N1: plain-English ops alerts, the structure (wave 2) — builder: Opus

Read `RULES.md` first (still binding; trailer is EXACTLY `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`).
Worktree `/Users/liamariavisoiu/projects/healdesk-ops-n1`, branch `ops/n1-alert-wording`, cut from main `1fa04a6f`.
Postgres container `hd-ops-n1-pg`, port `55521`. **No migration.**

## Why (owner, 23 Oct 2026, verbatim in spirit)
He opened the `setup_request_reply_past_due` email on his phone and could not tell what it meant: an event
code, a bare request id and "Reply today". Standard now, for ALL ops notifications (email AND Slack, every
event in `OPS_EVENTS`, about 106, and any a later lane adds): enough context that the ops person understands
the whole situation from the message alone; short, plain, non-technical English; and very detailed numbered
steps for what to do next.

## Owner decisions for this lane
- Slack carries the SAME full text and every numbered step as the email (not a short version).
- The setup-request alert may carry the requester's BUSINESS name only (never the person's name, email, phone),
  read from the marketing Sheet in apps/web and passed in the signed `setupRepliesPastDue` request. The
  business name is typed by a prospect: cap it at 80 characters, refuse values containing `@`, a URL, or
  a run of 7+ digits (send the alert without a name instead), and pass it through the same allow-list as a
  clinic's name.
- Console links in these alerts use the one issue-link shape the admin now has:
  `/admin/clinics/<clinicId>/<tab>#<event>-<alertId>` (apps/web `lib/admin/issue-link.ts` `issueLink`,
  `issueTabFor`); with the origin from `HEALDESK_CONSOLE_ORIGIN` as `opsConsoleLink` does today (ops_alert mail
  only accepts `/admin/` paths on that origin, see `lib/email/lint.ts`). Replace the old `/admin/ops/<id>/care|
  onboarding` links. Events with no clinic link to the page that owns them (e.g. `/admin/queues#setup-requests`,
  `/admin/system/jobs`, `/admin/compliance`).

## What to build
1. **The wording model** in a new folder `apps/app/src/lib/ops/alert-wording/`:
   - `types.ts`: `AlertWording = { title; whatHappened; whyItMatters; steps: readonly string[]; }` where the text
     may use `{placeholders}` drawn ONLY from the alert's allow-listed fields (clinic name, counts, days, dates
     the existing allow-list permits). `title` at most 70 characters (an existing test enforces it).
   - One file per runbook section of `docs/on-call.md` "Alert runbook, by event" (provisioning, billing, usage,
     email-delivery, setup-and-support, agreements, voice, calendar, transcripts, go-live, account, offboarding,
     patient-rights, incidents, vendors, meta, retention, availability, setup-progress, morning-digest), each
     exporting a `Partial<Record<OpsEvent, AlertWording>>`, plus an `index.ts` that merges them. Use the
     runbook's own event lists to place events (`apps/web/src/lib/admin/fix-with-claude.ts` RUNBOOK_ANCHOR is
     the map). Later builders (Fable, lane N2) write the sentences in these files; **you write the structure and
     convert every existing event MECHANICALLY** (existing `title`/`action` text moves into `whatHappened`/
     `steps` as one step, nothing lost) so behaviour is unchanged until rewritten, and list every unconverted event
     in `LEGACY_WORDING` (a `ReadonlySet<OpsEvent>`) which N2 will empty.
   - Hand-write the plain-English wording for the FIVE events below as the pattern N2 will copy (they also prove
     the model): `setup_request_reply_past_due`, `usage_near_cap`, `calendar_write_stuck`,
     `lifecycle_decision_due`, `clinic_availability_changed`. Rules for good wording are in 5 below.
2. **Renderers**: the email (`lib/email/templates/ops_alert.ts`: keep `wordingFor`, `OpsAlertPayload`, the title
   test, compose blocks; show what happened, the facts list with human labels as today, why it matters, a
   numbered list of steps, the console link as ONE button/line, and the event code only as a small reference line
   at the bottom) and Slack (`lib/ops/slack.ts` message builder: title, what happened, who, why, ALL numbered
   steps, the link; keep the allow-list; mind Slack's per-block 3,000 character limit: split into several
   sections, never truncate a step). Both render from the SAME `AlertWording` + the same placeholder
   substitution function (one implementation, tested). Unknown or missing placeholder values never print
   `undefined`: drop the clause or use a safe fallback; test it.
3. **Link shape**: the alert's `ops_alerts` row id is the `<alertId>`; make `opsConsoleLink`/`opsConsolePath`
   (notify.ts) build the issue-link shape. The event→tab mapping lives in apps/web (`issueTabFor`: SETUP,
   BILLING, DELIVERIES, ACCOUNT sets). apps/app cannot import it: put the mapping in apps/app
   (`lib/ops/alert-wording/tabs.ts`) and add a drift test that parses apps/web's `issue-link.ts` source and
   fails when the two disagree (the existing `ops-events.test.ts` shows the parsing pattern). Keep
   `ONBOARDING_PAGE_EVENTS`/`SUMMARY_EVENTS` working or remove them if fully replaced; update their tests.
4. **Setup-request enrichment**: apps/web `app/api/cron/setup-replies/route.ts` (and `lib/setup-requests.ts`) pass
   `requests: [{ id, business }]` (business optional) in addition to `requestIds` (keep `requestIds` accepted so
   an older web build still works); `ops-client.ts` `relaySetupRepliesPastDue`; apps/app `lib/ops/promise-ops.ts`
   validates and raises `setup_request_reply_past_due` with a `business` field that the allow-list accepts
   (like a clinic name); also pass the day the reply was promised for if the Sheet row has it (a date), so the
   wording can say "promised by 22 Oct". Tests on both sides.
5. **A wording lint test** (`tests/alert-wording.test.ts`) over EVERY event not in `LEGACY_WORDING`: has title
   ≤ 70 chars, `whatHappened` non-empty, `whyItMatters` non-empty, at least 2 steps each starting with a verb
   and each naming the exact place to act (a console page or button that exists today, e.g. "Open the clinic's
   Billing tab and press Extend deadline") and no code-like tokens (snake_case, camelCase, backticks, file
   paths, SQL words, the words in a short JARGON list you define: payload, webhook, idempotent, dead-letter,
   tenant, RLS, outbox, pg-boss, SSM, cron, migration, queue, ledger, endpoint, API, token); average sentence
   at most 22 words; every placeholder used is allow-listed for that event. Another test: `LEGACY_WORDING`
   plus the rewritten set equals exactly `OPS_EVENTS` (no event without wording; none in both). The goal state
   (N2) is an empty `LEGACY_WORDING`.
   Wording rules (also for N2): short sentences; say who or what is affected by name; say when it started and
   what the deadline is when there is one; say what the operator should NOT do when a wrong move is likely;
   steps are numbered, concrete and ordered, with the safest first; say what "done" looks like in the last
   step; never blame; no patient data, no free text typed by a clinic, no times of appointments (days only).
6. **Digest, lifecycle waves and the digest Slack summary** use their own layouts today: make the lifecycle
   waves (`lifecycle_*`) and `ops_digest_summary` render through the same model (their wording goes in the
   `setup-progress` and `morning-digest` files). The morning digest email itself is out of scope.

## Files you OWN
`apps/app/src/lib/ops/alert-wording/**`, `lib/email/templates/ops_alert.ts`, `lib/ops/slack.ts`,
`lib/ops/notify.ts` (the link builders and message plumbing; do not add or remove events), `lib/ops/promise-ops.ts`,
`apps/web/src/app/api/cron/setup-replies/**`, `apps/web/src/lib/setup-requests.ts` (the read of the business
name only), `apps/web/src/lib/admin/ops-client.ts` (the relay function only, additive), their tests, and
`apps/app/tests/ops-alert-wording.test.ts` / `ops-console-links.test.ts` / `ops-slack.test.ts` (update, never
weaken: say in the report what each change was). Do NOT edit `AGENTS.md`, `CLAUDE.md`, `docs/on-call.md`
(N2's reviewers update it), `.github/`, `infra/`, the spec. A file you need that is not listed: STOP and report.

## Tests
Real database where alerts are raised (`TEST_APP_URL`, see RULES.md). All existing ops alert tests green
(`ops-alert-wording`, `ops-console-links`, `ops-slack`, `ops-notify`, `ops-health-and-digest`, `lifecycle-*`,
`calendar-write-alerts`, `usage-alerts`, `ops`), the email-templates snapshot updated only where your five
events or the layout changed (read the diff of every snapshot you update), `tsc` for both apps, lint, apps/web
admin tests (the issue-link and ops-events mirrors).

## Report
RULES.md format; plus the five events' final text as rendered for email and for Slack (paste them), the list
of events still in `LEGACY_WORDING` with their count and their runbook section, and any wording you could not
make true because the console page or button it needs does not exist.
