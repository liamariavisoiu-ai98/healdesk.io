> Design input, written 23 Oct 2026 by a read-only design agent from main at 2e258ae9. Not a decision: the plan in ../README.md decides what is built and in what order. Claims are from the code unless marked NOT VERIFIED; spot-checked by the session that commissioned it.

# E2: the alerts and reminders engine (items 1, 3, 4 and 8)

Read from the code at 2e258ae9 (worktree healdesk-db-access). Read-only; nothing changed.

## 1. Current state, read from the code

**The morning digest exists; it is email only.** `apps/app/src/lib/ops/digest.ts` (I2) runs from the hourly tick at 07:00 UTC behind job `ops-digest`. It goes to `HEALDESK_OPS_EMAIL`, or `HEALDESK_ADMIN_EMAIL` if that is unset, through Resend. It carries ids and counts only (`assertPayloadAllowed(payload,"ops_digest")`), in four sections:
- queues with the age of the oldest item: pg-boss, the outbox, the transcript outbox, billing requests, billing and Connect events (retrying or parked), booking requests, paid orders without an account, support replies owed, agreements below the BAA floor, and ops alerts that could not be emailed;
- email health over 24 hours, per kind: sent, failed, bounced, complained, suppressed and dead. It includes apps/web's mail through `email_events`, plus the bounce and complaint rates;
- connection-health findings, and Google Calendar connections counted by state;
- Resend's daily count (warning at 70), and sign-in-help requests for addresses with no account.

Its state is an `ops_alerts` row keyed `day=<date>`, with up to 5 attempts and the Resend idempotency key `hd-ops_digest-<id>-<n>`. It has no Slack, no clinic names and no lifecycle or usage section. (`lib/scheduler/daily-summary.ts` is a different email: the clinic-facing daily summary, L13.)

**Setup window and reminders** (`lib/setup/reminders.ts`, job `setup-reminders`, hourly, seeded off):
- Reminders go on days 5, 10, 15, 20, 25 and 30, counted back from `setupDeadlineAt`, in the clinic's daytime only. They are outbox kind `setup_reminder`, deduped `setup_reminder:<n>`.
- After the first channel goes live, each other channel gets one reminder 48 hours later (`setup_reminder:live:<channels>`).
- The wording is in `lib/email/templates/setup_reminder.ts`.
- Closure: `lib/billing/reconcile.ts` records `close_setup` once the deadline passes with nothing live. Job `setup-closure` sends `setup_closed`.
- An extension already exists. Ops op `extendSetupDeadline` (`lib/ops/billing.ts:1589`, then `lib/billing/support.ts:144`) adds 1 to 30 days and is idempotent on `fromDeadline`. It also moves a pending closure. The clinic gets no email about it.

**Stuck before an account exists** (`lib/ops/watch.ts`, job `ops-watch`):
- `paid_intent_without_clinic` is raised 10 minutes after a paid order with no account.
- `provisioning_follow_up_past_due` is raised once B3's promised day has passed.
- `provisioning_dead_lettered` comes from `lib/checkout/dead-letter.ts`, which also sends the buyer B3 `order_confirmed_delayed`.
- `welcome_email_unsent` is raised 1 hour after provisioning (`lib/setup/welcome-email.ts`).
- Stuck on our side: `go_live_held`, `web_widget_to_confirm`, `practice_question_review_past_due` and `voice_provision_failed`. All are `notifyOps*` events in `lib/ops/notify.ts` (OPS_EVENTS, about 90 events).

**Usage near the cap** (`lib/billing/usage-alerts.ts`, job `usage-alerts`, hourly):
- Kind `usage_80` (it fires at 90%) and kind `usage_100` go to the clinic, once per meter per window, and only while the clinic's "Usage alerts" switch is on.
- `allowance_fallback` is critical and always sent.
- Ops hears nothing about any of these. Billing is the only screen that shows `pastAlertMark` (`lib/portal/billing.ts:171`).

**The outbox and the ledger** (`lib/email/outbox.ts`):
- `billing_notices` is unique on (clinic, kind, dedupe_key) and is written in the state change's own transaction.
- Retries run at 1, 5, 30, 120 and 360 minutes under `hd-<kind>-<id>-<n>`. After that the notice is dead and notifyOps fires.
- `report_deliveries` keeps one row per recipient: status, Resend `message_id`, and the `delivery_status` the Resend webhook relays (delivered, bounced, complained, suppressed).
- Every notice goes to the clinic's one address (`billingRecipients`), from `HEALDESK_EMAIL_FROM` = hello@.
- `/admin/ops/[clinicId]/care` already lists `deliveries` (kind, status, reason, attempted) but not `delivery_status` or `message_id`.

**Ops alerts** (`notifyOps` and `notifyOpsOnce`): a log line, an `ops_alerts` row (deduped for an hour or forever), and one email to `HEALDESK_OPS_EMAIL`. Fields are ids only, never names. **Email only.**

**Slack: only in apps/web.** `apps/web/src/lib/demo/alert.ts` `postInternalAlert(text)` posts to `SLACK_WEBHOOK_URL` (a Vercel variable) as best effort, with no retry, no record and a 5-second timeout. It is used only by the Stripe webhook and `own-demo.ts`. apps/app and infra contain no Slack code. `/admin/map` lists `vercel.SLACK_WEBHOOK_URL` and the `web-slack` bridge.

**Resend quota:** `email_daily_quota` says "the free plan stops at 100 a day, sign-in links and urgent alerts included". Every copy to hello@ spends that same quota.

## 2. What to build: one engine, "the lifecycle watch"

### Data (apps/app, tenant plane, RLS; one numbered migration; both tables `reviewed-readable` in `scripts/readonly-tables.ts`, since they hold no PHI)

- **`clinic_lifecycle`** has one row per billing clinic. Columns:
  - `stage`: one of `paid_no_account`*, `not_started`, `in_setup`, `waiting_on_us`, `partly_live`, `live` or `closed`;
  - `stage_since`;
  - `steps_left`, `channels_waiting` and `last_progress_at`, set when `steps_left` falls or a channel changes state;
  - `snoozed_until` and `snoozed_by`;
  - `decision`: `none`, `extension_offered`, `let_close` or `extended`, with who set it and when.

  *Before an account exists there is no clinic row. That stage stays on `checkout_intents` and the ops watch.
- **`lifecycle_waves`** is **the reminder ledger** that admin shows. One row per wave per target, unique on (clinic_id, stage, wave, target), which makes it idempotent. Columns:
  - `target`: `clinic_email`, `ops_email` or `slack`;
  - `notice_id`, which points to `billing_notices`, or `ops_alert_id`, which points to `ops_alerts`;
  - `queued_at`, `sent_at`, `provider_id` (the Resend message id, or Slack's `ts`, or null for a webhook), `delivery` (`delivered`, `bounced`, `failed` or `skipped`), `error` and `manual_by` (the operator who pressed "send now").

  `delivery` is not copied: the read joins `report_deliveries` through `notice_id`.
- `ops_alerts` gets `slack_posted_at`, `slack_attempts` and `slack_error`. That way **every** ops alert can go to Slack, not only this engine's. The runtime role needs UPDATE on those three columns only; 0046 keeps `fields` immutable.

### Job: `lifecycle-watch` (hourly from the tick, seeded off)

For each billing clinic, it computes the stage from `readSetupState`, the channel states and `clinic_billing`, upserts `clinic_lifecycle`, then fires the waves that are due and not yet in the ledger.

- **It sends no clinic emails itself.** The `setup-reminders` job keeps sending the six spec reminders. The watch only **records** each one into `lifecycle_waves` when it sees the `billing_notices` row, so the ledger is complete without a second sender.
- **Snooze** mutes the ops waves only. It never mutes the clinic's spec reminders.

### The wave schedule (day = day of the 30-day window, counted back from the deadline, as the reminders are)

| Stage | Clinic (from hello@, outbox) | Ops email + Slack |
|---|---|---|
| paid_no_account | B3 already (once) | +10 min (exists), **+2 h**, **+24 h** escalation |
| account, welcome unsent | (none) | +1 h (exists) |
| not_started / in_setup (clinic owes a step) | days 5, 10, 15, 20, 25, 30 (spec; exist) | **day 7** Slack only "no progress"; **day 15** Slack + email if `last_progress_at` is older than 5 days; **day 22** "decide: extend?" with buttons; **day 27** "closes in 3 days"; **day 30** "closing tonight"; closure recorded (exists) |
| waiting_on_us | one **"we're on it"** email after 1 business day (new kind, once per stage entry) | **+4 h** Slack; **+1 business day** Slack + email; **+2 business days** escalation, proposing an extension equal to the days spent waiting on us |
| partly_live | one reminder per channel at 48 h (spec; exists) | **day +7** Slack only; **day +14** Slack + email |

**When a reminder becomes a human alert** (it sets `escalated=true`, and the Slack message starts with ":rotating_light:"):
- a clinic wave that bounced, failed or died. `clinic_address_bounced` already exists; it is now also linked to the wave;
- two clinic waves in a row that were delivered with no progress in between;
- `waiting_on_us` for more than 2 business days;
- day 22 or later with `steps_left ≥ 2`, or no sign-in at all.

Below these, a wave is Slack only, as information.

### Manual buttons (from the clinic list row and the clinic page)

Each is a typed ops op. Each shows a server-rendered preview before Send. Each writes `lifecycle_waves.manual_by` and an audit row.

- **Extend deadline** (+7, +14 or a custom 1 to 30 days): reuses `extendSetupDeadline`, and also queues the new `setup_extended` email. This is item 8's button. It shows only on the day-22 or later alert, or on a `waiting_on_us` escalation.
- **Send reminder now**: pulls the **next** spec reminder forward instead of adding one, so the total stays at six. A new dedupe rule moves `setup_reminder:<n+1>` to now.
- **Offer a 5-minute call**: new kind `setup_help_offer`. Allowed once per stage entry.
- **Snooze ops alerts** for 3, 7 or 14 days.
- **Let it close**: records `decision=let_close`, which stops the day-27 and day-30 ops waves.

### Wording: clinic emails (hello@, Resend outbox, the clinic's one address, no patient data)

The existing six reminders keep their current wording.

- **`setup_extended`**, subject "More time to finish setting up AYA"
  > We've given you more time: you now have until {closesOn} to finish setting up AYA for {clinic}. What's left:
  > • {actions, same lines as the reminder}
  > [Continue setup]
  > If something on your side is in the way, reply to this email and we'll sort it out with you.
- **`setup_waiting_on_us`**, subject "Nothing for you to do: we're finishing {channel}"
  > You've done your part. We're finishing {channel phrase} on our side and will email you when it's ready. You don't need to do anything, and this time doesn't count against your setup window. (Include the last clause only if the owner chooses to credit the time. See Q4.)
- **`setup_help_offer`**, subject "Want us to finish this with you?"
  > Setting up {channel phrase} takes about five minutes with someone on the line. Pick a time and we'll do it together.
  > [Book a five-minute call] · or reply with a time that suits you.
- **Usage**: unchanged (`usage_80` and `usage_100`).

### Wording: ops email (`ops_alert` entries) and Slack, one line each

Every Slack line ends with `<https://healdesk.io/admin/ops/{clinicId}|Open in admin>` and `id {clinicId}`.

- paid_no_account +2 h: "Paid order still has no account after 2 hours: ref {ref}. Check provisioning."
- paid_no_account +24 h: ":rotating_light: Paid 24 h ago, still no account: ref {ref}. The buyer was promised an email by {day}."
- day 7: "{clinic}: day 7 of setup, no progress since {date}. Reminder 1 delivered {date}."
- day 15: "{clinic}: halfway through setup, {stepsLeft} steps left, last progress {n} days ago."
- day 22: ":rotating_light: {clinic}: 8 days left, {stepsLeft} steps left. Decide whether to offer more time: [Extend] [Offer call] [Let it close]."
- day 27: "{clinic}: closes in 3 days ({closesOn}). Decision so far: {decision}."
- day 30: "{clinic}: today is the last day. The account closes tonight unless extended."
- waiting_on_us +4 h: "{clinic} is waiting on us: {reason, e.g. practice review / voice number / widget confirm}."
- waiting_on_us +1 business day: "{clinic} has waited on us for 1 business day ({reason}). They were told we're on it."
- waiting_on_us +2 business days: ":rotating_light: {clinic} has waited on us for 2 business days ({reason}). Suggest extending by {n} days."
- partly_live +7: "{clinic}: {live channels} live; {channel} still waiting on them for 7 days."
- bounce: ":rotating_light: {clinic}: setup reminder {n} bounced. Their address may be wrong. Call them."
- usage 90: "{clinic}: {meter} at {pct}% ({used}/{included}), resets {date}. Email sent to clinic: {yes or switched off}."
- usage 100: "{clinic}: {meter} allowance used up. Mode: {extra blocks bill / stop and fall back}."
- fallback engaged: ":rotating_light: {clinic}: allowance cap reached and 'Stop and fall back' is on. Calls now go to their direct line."

## 3. Usage near the cap (item 3)

- **What exists:** the clinic email at 90% and 100%, per meter, per window, and the `allowance_fallback` email.
- **What is missing, and what to build:**
  - two new OPS_EVENTS, `usage_near_cap` and `usage_cap_reached`, raised with `notifyOpsOnce` in the same pass as `enqueueNotice`, keyed clinic + meter + window. They are raised **even when the clinic's switch is off**, because they are internal. Each goes to the ops email (hello@, see Q1) and to Slack;
  - `allowance_fallback` added to Slack;
  - a Usage column on the clinic list: name, clinic id, % per meter, reset date, mode, and whether the clinic was emailed.
- **Buttons ops can trigger from the list** (all closed-catalog kinds rendered in apps/app; nothing typed reaches the clinic):
  1. **Resend usage alert**: sends `usage_80` or `usage_100` again under dedupe `…:manual:<date>`, once a day at most;
  2. **Suggest a step up**: new kind `usage_step_up`, subject "A bigger monthly allowance would cost you less":
     > {clinic} used {pct}% of its {meter words} this month. Moving up a step in Billing gives you a bigger allowance for less than paying for extra blocks of 100. [Open Billing]
  3. **Explain fallback**: `allowance_fallback` again, only while the fallback is engaged;
  4. the setup buttons above;
  5. existing ops that already email: `issueCalendarLink` (calendar reconnect), `startForwardingTest`, and `welcomeHandoff`/sign-in help;
  6. **Log a touch** (`recordClinicTouch`, exists) for anything done by phone.

## 4. Slack

- **Today:** apps/web only, through the Vercel variable `SLACK_WEBHOOK_URL`. Alerts are fire-and-forget and leave no record.
- **Proposal:** add `apps/app/src/lib/ops/slack.ts`. It needs:
  - a new SSM parameter `SLACK_WEBHOOK_URL`, created as `__unset__` by Terraform and pasted with `put-external-secrets.sh` (it is the same channel's webhook);
  - an entry in `/admin/map` KEYS (`aws.SLACK_WEBHOOK_URL`) and in `key-presence.ts`;
  - a bridge `app-slack`.
- **What a Slack message may carry** (`SLACK_EVENTS`, an allowlist):
  - the event label, the clinic's **name** (business data) and its id, counts, dates and the admin link;
  - never a conversation id, a patient, an address or free text.
- The Slack text is rendered from the same `ops_alert` table entry as the email. Slack signs no BAA, so the lint test should reject any Slack payload key outside the allowlist.

## 5. Idempotency, retries, failure

- **Idempotency:**
  - each wave is unique on (clinic, stage, wave, target);
  - clinic emails reuse the outbox's unique dedupe and Resend idempotency keys;
  - ops emails reuse `ops_alerts` and `notifyOpsOnce`;
  - manual sends carry an expected-state token (as `fromDeadline` does), so a replayed envelope inside its 300-second window cannot send twice.
- **Resend failing:**
  - clinic mail follows the outbox's existing retry ladder, then dead, then notifyOps. The wave shows "failed" and escalates to Slack;
  - ops mail is already retried by the digest's counter. **Slack now backs it up**: a failed ops email still posts to Slack;
  - when the quota is exhausted (`daily_quota_exceeded`), mail waits until 00:05 UTC, and Slack says so once.
- **Slack failing:** the `ops-slack` sweep (minute queue) retries at 1, 5 and 30 minutes on 429, 5xx or a timeout, and stamps `slack_posted_at` or `slack_error`. After 3 failed attempts the alert is counted in the digest as `slack_unposted`, and email still carries it.
- **Both failing:** the admin lists read the DB ledger directly, so nothing is lost. Proposed: `/api/health` turns amber when more than 5 alerts are unposted to both.

## Morning digest additions (item 1, this scope)

Add a "Lifecycle" block:
- clinics per stage, with the oldest `stage_since`;
- waves sent in the last 24 hours, by target and outcome;
- decisions owed (day 22 or later with no decision; waiting on us for more than 1 business day);
- clinics at ≥90% or ≥100% per meter;
- `slack_unposted`.

Plus a one-line Slack summary of the digest: "Digest: 3 decisions owed, 1 waiting on us, 2 near cap: Open admin". The payload stays ids and counts. Names appear only in admin.

## Rails

- **R3 (typed ops ops):** everything. New ops: `listLifecycle` (read), `listLifecycleWaves(clinicId)` (read), `sendLifecycleNotice` (write, closed kind list), `snoozeLifecycle`, `decideLifecycle`, `previewLifecycleNotice`. `extendSetupDeadline` is reused.
- **R1 (read queries):** `clinic_lifecycle` and `lifecycle_waves` become readable for ad hoc questions.
- **R2:** not used.
- **apps/web stores nothing new.** No Sheet tab is needed.

## Guardrails and conflicts

- **OWNER DECISION A:** the owner wants reminders "with every time frame". The spec ("Checkout and provisioning" ¶ and "The first 48 hours") fixes six reminders while nothing is live, and one per channel after go-live. Recommendation: keep six. Add only *non-reminder* account notices (`setup_extended`, `setup_waiting_on_us`, `setup_help_offer`), and make "send now" pull a reminder forward rather than add one. Any extra cadence means the owner edits the spec's source doc.
- **OWNER DECISION B:** Slack is a non-BAA vendor. Clinic names are business data, not PHI, so the recommendation is to allow name, id and counts. Today notifyOps forbids names even in email; this changes that for Slack and ops email only, through an allowlist.
- **Portal must-never-grow:** nothing here adds a portal screen. "Outbound campaigns" are not built: every clinic email is either a single triggered notice or a manual, previewed one.
- **Patient outbound:** untouched. All recipients are the clinic's one address, or ops.
- **Transport:** all of this mail is `phiClass:"none"` through Resend from hello@. Nothing goes through SES.

## Build order

1. **S:** `ops_alerts` Slack columns, `lib/ops/slack.ts`, the `ops-slack` sweep, the SSM parameter, map and key-presence. Test: notifyOps posts once, retries, never posts a non-allowlisted key. Files: `notify.ts`, `jobs.ts`, `tick.ts`, `infra/aws/ssm.tf`, `system-map.ts`, `key-presence.ts`, a migration.
2. **S:** `usage_near_cap` and `usage_cap_reached` events, plus a usage column in `listClinicHealth`. Test: one alert per window, raised even with the switch off. Files: `usage-alerts.ts`, `notify.ts`, `ops_alert.ts`, `ops/api.ts`, `ops-client.ts`.
3. **M:** the `clinic_lifecycle` and `lifecycle_waves` migration, `lib/lifecycle/stage.ts` (pure stage function), and the `lifecycle-watch` job, recording existing reminders. Test: stage table tests with a fake clock; the ledger is unique; `readonly-tables.ts`.
4. **M:** the ops waves and escalation rules. Test: schedule fixtures, snooze, business days.
5. **M:** the three new clinic kinds (two CHECK constraints, the registry, the allowlist) and `sendLifecycleNotice`/preview. Test: template fixtures, copy guard, once per stage entry.
6. **M:** admin: a "Needs a decision" list, the clinic page "Reminders" timeline (wave, target, sent, delivered, provider id), and the buttons. This overlaps the admin redesign agent.
7. **S:** digest Lifecycle block plus the Slack one-liner. Files: `digest.ts`, `ops_digest.ts`.

## Open questions (for the owner)

1. Should `HEALDESK_OPS_EMAIL` be hello@healdesk.io? Every ops copy spends the Resend daily quota (100 a day on the free plan): upgrade the plan, or keep the ops email to escalations and send the rest to Slack only?
2. Do you accept clinic names (never patient data) in Slack and ops email?
3. Do you want more clinic reminders than the spec's six? If so, you edit the spec doc first.
4. Should days a clinic waits on us extend its deadline automatically, or only through the Extend button?
5. Should the day-22 "decide" alert fire for every stalled clinic, or only above a threshold (for example, a setup fee of $697 or more)?
