# Lane C1: the lifecycle watch and its ops alerts (Phase 4, first half) — builder: Opus

Read `RULES.md` first. Worktree `/Users/liamariavisoiu/projects/healdesk-ops-c1`, branch
`ops/c1-lifecycle-watch`. Postgres: container `hd-ops-c1-pg`, port `55503`. **Reserved migration: `0115`**
(`0115_clinic_lifecycle`). Design: `designs/E2-alerts-reminders.md` steps 3, 4 and 7 (steps 1 and 2 are live
from Phase 1; verify). Decisions: D4 keep the spec's six setup reminders as they are (automatic, fixed
wording, unchanged); D5 `HEALDESK_OPS_EMAIL` unchanged: routine waves are SLACK ONLY, email only for
escalations (the `escalated` rules in E2); D6 no automatic deadline extension; D7 the day-22 "decide" alert
fires for every stalled clinic (2+ steps left or no sign-in).

## Goal
One engine that knows each billing clinic's lifecycle stage, records every reminder into one ledger the admin
can show, and raises the timed ops waves (Slack, escalations by mail). It sends NO clinic email and builds NO
clinic notice kinds in this wave (those are editable drafts through the approval inbox, a later wave).

## Steps
- **E2-3** migration with `clinic_lifecycle` (stage, stage_since, steps_left, channels_waiting,
  last_progress_at, snoozed_until, snoozed_by, decision + who/when) and `lifecycle_waves` (unique on clinic,
  stage, wave, target; target `clinic_email | ops_email | slack`; notice_id → `billing_notices`, ops_alert_id →
  `ops_alerts`; queued_at, sent_at, provider_id, delivery, error, manual_by, escalated). Pure stage function
  `lib/lifecycle/stage.ts` (table-tested with a fake clock). Job `lifecycle-watch` (hourly from the tick, seeded
  off per convention) computes stage, upserts, and RECORDS each existing spec reminder (`setup_reminder:<n>`,
  the per-channel 48-hour one) into `lifecycle_waves` when it sees its `billing_notices` row, joining
  `report_deliveries` for delivery status — it must not become a second sender and must not change what
  `lib/setup/reminders.ts` sends. Both tables `reviewed-readable` in `readonly-tables.ts`. Before an account
  exists there is no clinic row: that stage stays with the existing ops-watch alerts (do not duplicate them).
- **E2-4** ops waves and escalation rules exactly per the E2 wave table and escalation rules ("When a reminder
  becomes a human alert"), business days via the existing `addBusinessDays`, snooze (mutes ops waves only,
  never the clinic's spec reminders), `decision` (`none|extension_offered|let_close|extended`). Slack wording
  from E2 §2 (adapt to the Phase 1 allow-list: clinic name, id, counts, console link; ":rotating_light:" on
  escalations). Every wave idempotent via the unique key; replay-safe. Day-22 alert says what is owed and
  proposes the action. Console links use pages that exist today.
- **Recommendation (owner's request: "Claude should audit the state and propose recommendations")**:
  `lib/lifecycle/recommend.ts`, a PURE rules function over facts (steps left, days left, last progress, days
  waiting on us, bounced/undelivered waves, whether signed in) returning one of
  `extend {days} | offer_call | let_close | wait | phone_the_clinic` plus a one-sentence reason built from
  fixed templates and the facts. No model call, no free text. The same function feeds the day-22 alert text and
  `listLifecycle`. Table-test every branch.
- **E2-7** morning digest "Lifecycle" block in `lib/ops/digest.ts` + `email/templates/ops_digest.ts` (you OWN
  both this wave): clinics per stage with the oldest `stage_since`, waves in the last 24 h by target/outcome,
  decisions owed, clinics at ≥90%/≥100% per meter, `slack_unposted`; plus the one-line Slack summary of the
  digest. Payload stays ids and counts (`assertPayloadAllowed` for `ops_digest` must pass; extend its allow-list
  only as needed, in the digest's own files).
- **Ops operations** in your own `lib/ops/lifecycle-ops.ts`: `listLifecycle` (read: per clinic stage, decision,
  recommendation, snooze, steps left, days left; also feeds the admin's "Needs a decision" list),
  `listLifecycleWaves {clinicId}` (read: wave, target, sent, delivery, provider id, escalated, manual_by),
  `snoozeLifecycle {clinicId, days: 3|7|14}`, `decideLifecycle {clinicId, decision}` (`let_close` stops the day-27
  and day-30 ops waves; `extended` is set by the existing `extendSetupDeadline` flow — find where and set it
  there if cheap, else report). `extendSetupDeadline` itself is unchanged. Write ops record an audit row and
  a security event like the neighbours. Mirror in `ops-client.ts` (REGISTER). NO admin screens (admin lane owns
  all `apps/web/src/app/admin/**`).
- NOT in this lane: `setup_extended`/`setup_waiting_on_us`/`setup_help_offer` kinds, `sendLifecycleNotice`,
  preview, "send reminder now" — all wait for the approval inbox.

## Files you OWN
`apps/app/drizzle/0115_*` (+ journal, `when` above 0114's — the lead fixes at landing), `src/lib/lifecycle/**`,
`src/lib/ops/lifecycle-ops.ts`, `src/lib/ops/digest.ts`, `src/lib/email/templates/ops_digest.ts` (+ its
payload allow-list file), the job registration for `lifecycle-watch`, their tests. **REGISTER (additive, final
commit):** `db/schema.ts`, `scripts/readonly-tables.ts`, `lib/ops/api.ts`, `lib/ops/notify.ts` (new OPS_EVENTS),
`lib/ops/slack.ts` allow-list, `apps/web/src/lib/admin/ops-client.ts` (+ tests), `system-map.ts` (job words
only if a test requires). Lane B (0114) also adds tables/events to the same hot files: expect a trivial merge.
`lib/setup/reminders.ts` and `lib/billing/*` are READ-ONLY for you: if recording needs a hook inside them,
STOP and report instead.

## Tests required (real database; report SKIP counts)
Stage table with a fake clock (every stage + transitions); ledger uniqueness and replay; a clinic with the six
spec reminders gets six recorded rows with the right delivery status, and the reminders job's own output is
byte-identical before/after (assert no extra `billing_notices` rows); wave schedule fixtures per stage for ops
waves with business days; snooze mutes ops not clinic; `let_close`; escalation triggers (bounced, two delivered
no-progress, waiting-on-us > 2 business days, day 22+ with ≥2 steps); Slack-only vs email split (D5); `recommend`
branch table; digest block payload allowed by `assertPayloadAllowed` and contains no name; ops contract tests;
migration from zero and over 0113; `readonly-tables.test`; no new `billing_notices` kinds so the email
CHECK/registry tests are untouched.

## Report: RULES.md format; also the wave schedule as implemented (table), what the owner must switch on, and
anything in E2 you judged wrong after reading the code.
