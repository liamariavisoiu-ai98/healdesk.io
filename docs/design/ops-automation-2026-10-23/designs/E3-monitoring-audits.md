> Design input, written 23 Oct 2026 by a read-only design agent from main at 2e258ae9. Not a decision: the plan in ../README.md decides what is built and in what order. Claims are from the code unless marked NOT VERIFIED; spot-checked by the session that commissioned it.

# E3: Monitoring and audits (items 5-audit, 6, 7, 9, 10, 11)

Read from the worktree at 2e258ae9. Paths are under `apps/app/src/` unless they say otherwise.

## 1. Current state (verified)

**Availability.** Weekly hours are `clinics.opening_hours`. Closed days are `clinic_closures` (a date in the clinic's time zone). Both are written only by `saveHours` (`lib/setup/practice.ts:243`), which replaces every closure from today on and records an audit row `clinic_hours`. Callers: the wizard (`app/c/[slug]/setup/screens/PracticeScreens.tsx`), the portal's Knowledge page (`lib/portal/knowledge.ts`) and the website path (`lib/website/store.ts:849`). Location hours have their own writer (`lib/portal/location-details.ts:239`), and R2 `db-apply` can also write closures.
- **Read by:** booking availability (`lib/booking/availability.ts:447`, so voice, web chat and Meta share one engine), the answer gate for `after_hours_only` (`lib/billing/answering.ts:577-606`, `closedToday`), `requests-still-open` and `daily-summary`.
- **NOT read by:**
  - `assistantFacts` (`lib/assistant/facts.ts:172`): the model gets weekly hours only;
  - `openNow` in `lib/assistant/turn.ts:186` (the urgent reply);
  - the Meta front door (`lib/meta/front-door.ts:276`).
- **The gap:** AYA can say "we're open Monday" on a holiday while the booking tool offers no slots that day. **Finding F1.**
- **Retell holds no hours** (`lib/voice/provision.ts:84-93`). Under the custom engine the knowledge, hours and coverage come over our socket on every call. Retell holds only the transport, voice, language, number binding and fallback. So an availability change needs no Retell call, and Retell's part of an audit is "the agent is ready, current and not drifted". The native engine (`docs/design/voice-native-llm-migration-2026-10-21.md`) would change this. It is not built.

**Provider roster.**
- **Written by:** `saveProviders` and `setProviderServices` (`lib/connections/google-calendar.ts:1551,1711`), plus R2.
- **Read by:** `calendarTargetsFor` (`availability.ts:275`), only when `bookingDetail = named_provider`.
- **Monitoring:** none.

**Calendar writes.**
- **The writer:** `writeToCalendar` (`lib/booking/calendar.ts:286`). Its `unknown` reasons are timeout, network, unconfirmed, threw and target_unverified.
- **Automatic retries:** the 5-minute calendar watch's desk sweep retries `unknown` and stuck `writing` rows. It reads Google back first, covers only the last 24 h, takes 20 a run and stops at `MAX_WRITE_ATTEMPTS = 5`.
- **`failed`:** never swept. Only ops `retryCalendarWrite` retries it (`fromFailed`).
- **Broken connections:** a definitive break calls `markCalendarBroken`, and `lib/booking/mode.ts` derives manual booking mode from it.
- **Who hears:** the clinic gets L7/L34 booking alerts. Ops hears `calendar_broken`, `calendar_degraded`, `calendar_recovered`, `calendar_watch_*` and `google_oauth_client_rejected`.
- **The gap:** there is no ops alert for a single write that ended `failed` or used up its 5 attempts. `listCalendarWrites` (40 rows) appears only on the onboarding page.

**Voice drift.**
- **The check:** `checkVoiceAgentDrift` (`lib/voice/provision.ts:739`) runs nightly at 03 UTC (`provision-job.ts:36`).
- **Repair:** `reapply` puts back storage, engine, webhook, voice, language, keywords, number binding, outbound and fallback. After `MAX_DRIFT_REPAIRS = 3` the clinic is flagged instead. A missing agent or number is flagged and never re-created.
- **Alert:** `voice_agent_drift`, at most once per day per drift.
- **Ops operations:** `voiceAgentStatus` (with `verify`: GET-only read-back) and `retryVoiceAgent`.
- **Gaps:**
  - No admin page calls `voiceAgentStatus` (it appears only in `apps/web/src/lib/admin/ops-client.ts:1134`).
  - Nothing clears `drift_flagged_at`: `retryVoiceAgent` returns `already` for a ready clinic (`provision.ts:417`). A flagged clinic is never checked again.

**Transcripts.**
- **The outbox:** `lib/conversations/transcript-outbox.ts`. Retries wait 1, 2, 5, 10 and 30 minutes, then an hour between tries. Ops is alerted on the 3rd failure, on a bounce, on expiry and when a send goes unconfirmed.
- **Ops views:** `transcriptDeliveries` and `resendTranscript`, per clinic, at `apps/web/src/app/admin/ops/[clinicId]/transcripts`. The digest counts copies still held.
- **The gap:** no view across clinics.

**Go-live.**
- **The check:** `goLivePreconditions` (`lib/onboarding/go-live.ts:150`). Ten codes, each with a `side` (clinic or ours). Go-live is automatic.
- **Alert:** `go_live_held`, once per reason.
- **Where it shows:** `getOnboarding.goLive`, and the `listClinicCards` tracker.
- **The gap:** no status across clinics.

**Alerting.**
- **The path:** `notifyOps` (`lib/ops/notify.ts`) writes a log line and an `ops_alerts` row, then emails `HEALDESK_OPS_EMAIL`.
- **No Slack in apps/app.** Slack exists only on apps/web (`apps/web/src/lib/demo/alert.ts`, `SLACK_WEBHOOK_URL`).
- **No links in ops emails:**
  - the template "links nowhere" (`lib/email/templates/ops_alert.ts:15`);
  - the link scanner (`lib/email/lint.ts:447-480`) refuses every origin except apps/app's public origin and Stripe, so a link to `healdesk.io/admin` is refused today.

## 2. What to build

### 2.1 One audit framework (apps/app; it holds clinic data)

**Table `clinic_audits`** (migration 0112, classified in `scripts/readonly-tables.ts`). It holds ids and codes only, so it is a candidate for the read list.

| Column | What it holds |
| --- | --- |
| `id`, `clinic_id` | uuid |
| `pack` | `availability`, `roster`, `golive`, `calendar`, `voice` or `transcripts` |
| `trigger` | `change` (clinic edit), `change_detected` (fingerprint moved: R2, website, anything), `scheduled` or `manual` |
| `change_kind` | `hours`, `closures`, `location_hours`, `providers`, `services`, or null |
| `fingerprint` | sha256 of hours, upcoming closures, active providers and their service keys, and location hours |
| `result` | `pass`, `warn`, `fail` or `error` |
| `checks` | jsonb `[{id, result, hint, counts}]`; counts and codes, never names or times |
| `requested_by` | operator label or service |
| `started_at`, `finished_at` | timestamps |

Keep the last 20 rows per clinic and pack.

**The registry** (`lib/audits/checks.ts`). Each check is `{id, pack, label, run(ctx) → {result, hint, counts}}`. Checks are read-only: they do no writes except storing the result, and make GET-only vendor calls. The runner (`lib/audits/run.ts`) runs a pack's checks with a 20 s budget per check, stores one row and returns it. The pack's result is the worst of its checks. A check that throws is `error`, and it never fails the clinic's own save.

**The availability pack** (item 5). What "implemented and running without problems" means, check by check:

| id | Compares | Reuses | Fix hint (example) |
| --- | --- | --- | --- |
| `hours_valid` | Hours parse, at least one open day, time zone confirmed | `parseOpeningHours`, `availability.ts` reasons | "Time zone unconfirmed: no times are offered on any channel. Ask the clinic to confirm it in Settings." |
| `closures_stored` | Upcoming DB closures match the fingerprint the change saved; none in the past; at most 60 | `readUpcomingClosures` | "The saved closed days differ from what the clinic sent; open Knowledge with them." |
| `booking_mode` | Auto vs manual, and why | `bookingModeFor` | "Manual booking because the calendar is broken: send a calendar link." |
| `calendar_reachable` | Connection `active` and verified within 10 min. A manual run also does a live probe, without recording it | calendar-watch state; `probeGoogleToken` | "Google refused the token: the clinic must reconnect." |
| `slots_honour_closures` | Runs `computeAvailability` (the engine all channels use) for the next 14 days. It asserts zero slots on a closure date, zero outside weekly hours (in local time), and at least one slot on some open day | `availability.ts` | "No free time in 14 days although open: the calendar may be blocked all day." |
| `bookings_on_closed_days` | Counts appointments, open booking requests and live holds on newly closed dates | appointments, booking_requests, slot_holds (counts only) | "3 bookings fall on a day now closed; the clinic must move them." |
| `voice_answers_closed_days` | The answer gate's pure decision with `closedToday=true` at local noon, for the clinic's coverage mode | `answering.ts` (export the pure part) | "Voice will pass calls through on the holiday; coverage mode is X." |
| `voice_agent_current` | `voice_agents` row ready; hash equals the expected hash; not drift-flagged; no `lastError`. A manual run adds `verifyVoiceAgent` | `provision.ts` | "Retell drifted: see the voice panel." |
| `web_chat_live` | The web channel is live and the widget confirmed. Web chat has no availability copy of its own | `readChannelStates` | "Widget not confirmed on the site." |
| `assistant_knows_closures` | Upcoming closures appear in `assistantFacts` | `facts.ts` | Fails until F1 is fixed (see 4). |

**The other packs** run on the same runner:
- **`roster` (item 6):**
  - each active provider's calendar is still in `listProviderCalendars` and passes `confirmCalendarTarget`;
  - under `named_provider`, every service in `agent_configs.services` has at least one active provider;
  - no provider is left with zero services.
- **`golive` (item 7):** one check per `GoLiveCode` from `readGoLiveCheck`, carrying its `side` and `text`, plus each channel's Gate B `missing`. It runs hourly for clinics not yet in production.
- **`calendar` (item 9):** connection health, plus the counts of future writes that are `failed`, or `unknown` with 5 attempts.
- **`voice` (item 10):** `voice_agent_current` plus the read-back.
- **`transcripts` (item 11):**
  - over 7 days, fail on any `expired` or `unconfirmed`;
  - warn on `bounced`, or on a copy held more than an hour;
  - otherwise pass.

**Triggers.**
- **change:** after the commit of `saveHours`, `saveProviders`, `setProviderServices` or the location-hours update, enqueue pg-boss `clinic-audit` with `{clinicId, trigger, changeKind}`. A singleton key per clinic and a 2-minute debounce mean a clinic adding six holidays gets one audit and one Slack message.
- **change_detected:** the hourly tick compares each clinic's fingerprint with its last audit's. This catches R2 `db-apply` and website edits, which call no hook.
- **scheduled:** every pack at 04 UTC, after drift. This feeds the morning digest's section, which E-digest owns.
- **manual:** ops operation `runClinicAudit {clinicId, pack?}`. It is a write op that records a security event naming the operator, runs synchronously in under 25 s, and includes the live probes.

**Ops operations (R3), added to the closed list:**
- `runClinicAudit`
- `clinicAudits {clinicId?}`: the latest row per pack per clinic, or one clinic's history
- `listStuckCalendarWrites`: across clinics
- `clearVoiceDriftFlag {clinicId}`: step-up, sets `drift_flagged_at` null and runs the drift check once.

**Slack message for item 5** (ids, the clinic's name and a link; no patient data):
> 🗓 *Bright Smile Dental* (`1f3c…`) changed its availability: closed days (6 added). Audit: ✅ passed. https://healdesk.io/admin/ops/1f3c…#audit

If the audit warns or fails, a second line names the failing check's hint.

### 2.2 The Slack and email leg (shared; I need it, I don't own it)

Add Slack as a third delivery in `notifyOps`, for an allowlisted set of events. It reads a new SSM key, `HEALDESK_OPS_SLACK_WEBHOOK_URL`, which goes on `/admin/map` and in `key-presence.ts`. Its fields go through the same `loggable` and `emailable` allowlist, plus the clinic's name, which is business data. Every event in this design gets a console link `/admin/ops/<clinicId>#<section>`. That conflicts with the link rule (see 4).

### 2.3 Calendar retry policy (item 9)

**Set number:** 5 attempts, the existing `MAX_WRITE_ATTEMPTS`. Add `calendar_write_next_at`, with backoff of +2 min, +10 min, +30 min, +2 h and +6 h. Replace the sweep's 24 h lookback with "until the slot starts". A slot in the past is never written.

**Retried automatically:**
- the `UNKNOWN_OUTCOME_REASONS` (timeout, network, unconfirmed), threw and target_unverified;
- Google 429 and 5xx, if any currently map to `failed`, which the build must check. Every retry reads Google back first, as today.

**Never retried automatically:**
- `deleted_in_calendar`, `event_id_taken`, `not_ours`, `calendar_not_connected`, `target_*` (not allowed);
- any `calendarBreakOf` code (the connection is broken, the location is in manual mode, and the fix is reconnecting);
- a booking the staff marked cancelled, showed or no-show.

**Escalation:** `calendar_write_stuck` through `notifyOpsOnce`, keyed on the appointment id. It fires when a future write is `failed`, or `unknown` at 5 of 5. `calendar_broken` gains Slack and a link too.

**Email subject:** "Calendar write needs a person: Bright Smile Dental"

> A booking at Bright Smile Dental (clinic 1f3c…) could not be written to its Google Calendar. Appointment 9ab2…, slot in 4 days, status failed, reason event_id_taken, 5 of 5 attempts. The clinic was already told to add it by hand. Likely fix: there is already an event under our id at another time, so check for a duplicate and do not retry. Open: https://healdesk.io/admin/ops/1f3c…/onboarding#calendar-writes

**One fix line per reason:**
- **transient:** "Retry".
- **broken:** "Send a calendar link".
- **target_\*:** "The clinic changed calendar access; send a calendar link".
- **deleted_in_calendar:** "The clinic deleted it; nothing to do".

### 2.4 Voice drift (item 10)

| Problem | Policy | Proposed fix in the alert |
| --- | --- | --- |
| voice, language, keywords | Auto-repair (today) | None needed; "someone edited the agent in Retell's dashboard" |
| fallback, number_agent | Auto-repair, and **Slack at once** (calls may not reach the clinic) | "Confirm the direct line on the clinic's panel; run audit" |
| number_outbound | Auto-repair (v1 is inbound only) | "Find who attached an outbound agent in Retell" |
| storage, engine, webhook | Auto-repair, then human review: calls may have gone elsewhere, or been kept against the retention rule | "Check Retell's audit; consider an incident on /admin/incidents" |
| agent_missing, number_missing | **Never auto-repaired** (re-buying costs money) | "Re-provision: clear the flag, then Retry voice agent" |
| 3 repairs in a row | Flag and leave for a person | "Something keeps changing it: check Retell API keys and integrations" |

**Wording:**
> Voice agent drift at Bright Smile Dental (1f3c…): fallback. Repaired automatically (repair 1 of 3). Proposed fix: confirm the clinic's direct line; nothing else needed if tonight's check is clean. https://healdesk.io/admin/ops/1f3c…#voice

### 2.5 What each result exposes (data shape for E1)

`clinicAudits` returns, per clinic:

```
{ clinicId, name, overall: "pass"|"warn"|"fail"|"running"|"never",
  lastChange: { kind, at } | null,
  packs: { [pack]: { result, at, trigger, failing: [{ id, hint }] } } }
```

- **The list:** one status dot (`overall`) and a "changed availability · time" badge when `lastChange` is newer than the last viewed time.
- **The panel:** each pack's result, its failing hints and a **Run audit now** button. The panel also shows:
  - stuck calendar writes, each with a Retry button;
  - the voice status with **Clear flag and recheck**;
  - the transcript counts for 7 days;
  - go-live items, split into the clinic's side and ours.

## 3. Reuse vs new, and rails

- **Reused:** `goLivePreconditions`, `bookingModeFor`, `computeAvailability`, `probeGoogleToken`, `verifyVoiceAgent`, `checkVoiceAgentDrift`, `listTranscriptDeliveries`, `notifyOps` and `ops_alerts`, pg-boss and the tick.
- **New:** the table, the registry, the runner, 4 ops operations, the Slack leg, `calendar_write_next_at`, and 2 events.
- **Rails:**
  - **R3** for everything the console does.
  - **R1** could read `clinic_audits` if it is listed.
  - **R2** writes are caught by `change_detected`.
- Nothing is stored in apps/web, so no Sheet tab is needed.

## 4. Guardrails and conflicts

- **PHI.** Checks store counts and codes. `bookings_on_closed_days` gives counts, never times or names. Alerts give the slot as "in N days", never the time, following the patient-mail pointer rule. No patient is contacted.
- **OWNER DECISION, email links.** Your wish for "links to the issue" conflicts with the ops-alert template ("links nowhere") and with the link scanner in `lib/email/lint.ts`. **Recommend:** allow one extra origin, `HEALDESK_CONSOLE_ORIGIN=https://healdesk.io`, only for the `ops_alert` kind, only for `/admin/` paths, only to `HEALDESK_OPS_EMAIL`, with ids alone in the URL. The console stays behind its password and TOTP.
- **OWNER DECISION, Slack from apps/app.** Slack signs no BAA. **Recommend:** allowed, because ops alerts are already lint-limited to ids, counts and the clinic's name. Use a separate webhook key from apps/web's.
- **OWNER DECISION, F1 (product behaviour).** Closures do not reach the assistant's facts, the urgent reply or the Meta open check. **Recommend** fixing it in code: add upcoming closures to `assistantFacts` and use `closedOn` beside `isOpenAt`. No spec change appears needed (spec, "Every switch in the portal" / Knowledge hours), but the owner should confirm.
- **Clinic-facing:** nothing new in the portal. The audit is ours (must-never-grow respected). Telling the clinic about bookings on newly closed days stays with the existing L-notices; whether to add one is open question 3.

## 5. Build order

1. **S. `clinic_audits` migration, registry, runner and the `golive` and `transcripts` packs.** Test: fixtures yield pass, warn and fail; `readonly-tables.test`. Files: `drizzle/0112_*`, `db/schema.ts`, `lib/audits/*`, `scripts/readonly-tables.ts`.
2. **M. The availability and roster packs, plus the export of the answer gate's pure decision.** Test: a closure date yields no slots, and a fixture with a booking on a closed date yields warn. Files: `lib/audits/checks.ts`, `lib/billing/answering.ts`.
3. **S. Triggers: post-commit enqueue, debounce, hourly fingerprint, 04 UTC run.** Test: six saves give one audit; an R2-style direct insert is detected. Files: `lib/setup/practice.ts`, `lib/connections/google-calendar.ts`, `lib/portal/location-details.ts`, `lib/scheduler/tick.ts`, `workers/index.ts`.
4. **S. Ops operations `runClinicAudit` and `clinicAudits`, and their ops-client types.** Test: an ops API contract test. Files: `lib/ops/api.ts`, `lib/ops/audit-ops.ts`, `apps/web/src/lib/admin/ops-client.ts`.
5. **M. The Slack leg and the console link, once the owner decides.** Test: `lint.ts` allows only `/admin/` on `ops_alert`; the system-map test. Files: `lib/ops/notify.ts`, `lib/email/lint.ts`, `templates/ops_alert.ts`, `apps/web/src/lib/admin/system-map.ts`, `lib/ops/key-presence.ts`, `infra/aws/ssm.tf`.
6. **M. Calendar backoff, `calendar_write_stuck` and `listStuckCalendarWrites`.** Test: backoff timing with a fake clock; never-retry reasons are never swept. Files: `lib/booking/calendar.ts`, migration, `notify.ts`, `ops_alert.ts`.
7. **S. `clearVoiceDriftFlag` and the drift wording per problem.** Test: a flagged clinic is checked again after clearing. Files: `lib/voice/provision.ts`, `lib/ops/voice-agent-ops.ts`.
8. **S. F1, if approved.** Test: the facts list a closure, and the urgent reply treats the closed day as closed. Files: `lib/assistant/facts.ts`, `turn.ts`, `lib/meta/front-door.ts`.
9. **M. Console panels (with E1).** Test: render tests. Files: `apps/web/src/app/admin/ops/**`.

## 6. Open questions

1. May ops alert emails link to `healdesk.io/admin`? (See 4.)
2. May apps/app post to Slack directly, with its own webhook?
3. Bookings on a newly closed day: alert ops only, or also send the clinic a pointer notice?
4. Fix F1 now, before any clinic sets a holiday?
5. Should a `fail` on the availability audit page someone at once (Slack @here), or only show on the list?
