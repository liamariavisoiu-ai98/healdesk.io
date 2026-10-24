# Lane P5a: calendar backoff, voice drift clear, cross-clinic monitor reads (Phase 5) — builder: Opus

Read `RULES.md` first (trailer EXACTLY `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; check
every commit with `git log -s --format='%(trailers:key=Co-Authored-By,valueonly)'`).
Worktree `/Users/liamariavisoiu/projects/healdesk-p5a`, branch `ops/p5a-monitors`, cut from main `3a688325`.
`npm ci` has run there. Postgres container `hd-p5a-pg`, port `55531`. **Reserved migration: `0117`** (its journal
`when` strictly above 0116's `1792822181669`). Design: `designs/E3-monitoring-audits.md` §2.3, §2.4, §5 steps 6 and 7,
and the transcripts gap in §1. The study was written by an agent: verify every claim in the code first, and skip
anything already built (say so).

## Why
A calendar write that fails for a passing reason (Google slow, a lost reply) is retried by the desk sweep only for
24 hours, with no spacing, and gives up after five attempts: a slot next week is never retried after a weekend
outage. Voice drift can flag a clinic and nothing clears the flag, so a flagged clinic is never checked again.
And nothing lists, across clinics, the transcript copies that never reached a clinic. The owner wants each of these
to heal by itself where it is safe, to be visible in one place where it is not, and to stay calm.

## Already decided (do not reopen)
- Five attempts, spaced +2 min, +10 min, +30 min, +2 h, +6 h after each failed attempt (`calendar_write_next_at`).
  The sweep keeps going until the slot STARTS (replace the 24 h look-back with "scheduled_for in the future"); a slot
  in the past is never written. Every retry reads Google back first, as `writeToCalendar` already does.
- NEVER retried automatically: `deleted_in_calendar`, `event_id_taken`, `not_ours`, `calendar_not_connected`, any
  `target_*`, any code `calendarBreakOf` recognises (the connection is broken; the location is in manual mode), and a
  booking staff marked cancelled, showed or no-show. Read the real failure-reason vocabulary in `lib/booking/calendar.ts`
  before you write the lists, and write a test that fails if a new reason is added without being classified.
- If a Google 429 or 5xx currently ends `failed` instead of `unknown`, make it `unknown` (retryable) and say so in
  the report. If it already does the right thing, do nothing.
- `calendar_write_stuck` already exists (`lib/ops/calendar-write-alerts.ts`); keep it true: it must still fire for a
  `failed` write and for an `unknown` write at five of five, and must NOT fire for an `unknown` write that is still
  waiting for its next scheduled attempt. Its wording lives in `lib/ops/alert-wording/` which another lane (N4) owns:
  do NOT edit that directory, `ops/slack.ts`, `templates/{ops_alert,compose}.ts` or `docs/on-call.md`. Report any
  wording that becomes untrue; the lead updates it after N4 lands.
- Clearing a voice-drift flag is a write with the operator's fresh authenticator code (the existing step-up
  mechanism; find how another step-up operation such as the direct-line or exports operations asks for the code and
  copy it exactly). It never re-creates a missing agent or number (that costs money): it clears `drift_flagged_at`,
  resets the repair counter if one exists, and runs the drift check once, returning what that check found. It writes
  a security event naming the operator.
- Everything cross-clinic is a hand-written projection of ids, counts, codes, dates and the clinic's name. Never a
  patient field, a transcript, a recipient address, a calendar event title or a time of day: alert and list slots are
  "in N days".

## What to build (apps/app, then the apps/web mirrors)
1. **Migration 0117**: `appointments.calendar_write_next_at timestamptz` (nullable), set when an attempt ends
   `unknown`/retryable with the next spacing, cleared on `written`. Indexed for the sweep if the plan needs it.
   Reuse existing grants (the table is already tenant-scoped); add nothing else. Check `readonly-tables.ts` and
   `drizzle-kit generate` says "No schema changes" afterwards.
2. **Sweep** (`sweepDeskWrites` in `lib/booking/calendar.ts` and `claimable`): select writes that are retryable and due
   (`calendar_write_next_at is null or <= now`), whose slot has not started, attempts < 5, status writable. Keep the
   per-run limit and fairness across clinics. A retried write that ends non-retryable stops being swept.
3. **Operation `listStuckCalendarWrites`** (read, cross-clinic; `lib/ops/stuck-writes-ops.ts`): rows
   `{clinicId, clinicName, appointmentId, status ("failed"|"unknown"), reason (a closed code), attempts, nextAttemptAt|null,
   slotInDays, retryable: boolean}`, newest problem first, capped at 100 with `truncated: boolean`; exclude demo clinics
   (`app_clinic_is_demo`) behind an `includeDemo` boolean (default false). Plus a count. Mirror as `fetchStuckCalendarWrites`.
4. **Operation `clearVoiceDriftFlag {clinicId, code}`** (write; `lib/ops/voice-agent-ops.ts`, which you own): as above.
   Mirror as `clearVoiceDriftFlag(clinicId, code)`; outcomes: `cleared`, `not_flagged`, `not_found`, `code_refused`,
   `still_drifted` (the check re-flagged it, with the problem codes). Also add the already-existing `voiceAgentStatus`
   and `retryVoiceAgent` ops to apps/web as `fetchVoiceAgentStatus(clinicId?, {verify?})` and `retryVoiceAgent(clinicId)`
   (they have no client yet; the screens lane needs them).
5. **Operation `listUndeliveredTranscripts`** (read, cross-clinic; `lib/ops/transcript-watch-ops.ts`): per clinic with
   any copy over 72 h undelivered, bounced or expired in the last 30 days: `{clinicId, clinicName, counts: {overdue, bounced,
   expired, unconfirmed}, oldestAgeHours}`, never a copy, a recipient or a conversation id. Read through the same
   states `transcriptDeliveries` uses (reuse its function; do not reinvent the classification). Mirror as
   `fetchUndeliveredTranscripts`. Add a Home inbox source (`lib/ops/inbox/transcript-delivery.ts`, registered in
   `sources.ts`): one row when any clinic has a copy past 72 h or expired, one plain sentence, tone `bad` when any
   expired, link `/admin/system/queues#transcripts` (the page does not exist yet; lane P5b builds it with that anchor:
   export the path as a constant in one place so it is a one-line change).
6. **Failure-safe**: every new read returns "could not read" (partial) rather than a zero when a part fails, like the
   other inbox sources.

## Files you OWN
`apps/app/src/lib/booking/calendar.ts`, `lib/ops/{calendar-write-alerts,voice-agent-ops,stuck-writes-ops,transcript-watch-ops}.ts`,
`lib/ops/inbox/transcript-delivery.ts`, `lib/voice/provision.ts` (the drift clear only), `drizzle/0117_*`, their tests.
HOT, additive only in ONE final commit titled `REGISTER:`: `lib/ops/api.ts` (OPERATIONS, MUTATING_OPERATIONS, `case`s),
`db/schema.ts`, `drizzle/meta/_journal.json`, `scripts/readonly-tables.ts` if needed, `lib/ops/inbox/sources.ts`,
`apps/web/src/lib/admin/ops-client.ts` (types, strict envelope parsers, functions), `apps/web/src/lib/admin/system-map.ts`
only if a key or bridge changes (you expect none). Not: `alert-wording/**`, `slack.ts`, `notify.ts` (unless you add an
event: you should not), `AGENTS.md`, `CLAUDE.md`, `docs/`, apps/web pages.

## Tests (real database; report the skip count; fake the clock)
- Backoff table: after each failed attempt `calendar_write_next_at` is exactly +2m, +10m, +30m, +2h, +6h; the sweep
  skips a not-due write and takes a due one; stops at five; stops when the slot has started; a 3-day-old unknown write
  with a future slot IS retried (it was not before).
- Never-retry classification: one case per excluded reason, and a case that fails if a reason in the source union is
  unclassified. A staff-cancelled booking is never claimed.
- `calendar_write_stuck` still fires for failed and for 5-of-5, not for a waiting retry.
- `listStuckCalendarWrites`: demo hidden, truncation, no forbidden fields (assert the exact key set).
- `clearVoiceDriftFlag`: wrong or missing code refused with nothing changed; a flagged clinic is checked again after
  clearing (fake Retell); `still_drifted` path; a security event row is written; a non-flagged clinic returns `not_flagged`.
- `listUndeliveredTranscripts`: key set exactly as above; a clinic with only a young held copy is absent; row security
  holds (the read runs per tenant).
- apps/web: ops-client contract tests for every new function (strict envelope; rejects an extra or missing field).
- Run: `npx tsc --noEmit -p apps/app -p apps/web` (one each), `npm run lint`, your files alone, then
  `tests/*calendar*`, `tests/*voice*`, `tests/ops-*`, `readonly-tables`, `migration-journal`, `system-map`, `delivery`.

## Report
RULES.md format. Also paste: the reason vocabulary and your retry/never-retry table, the exact op argument/result
types as mirrored, and every sentence in existing alert wording (`alert-wording/voice.ts`, `calendar.ts`) that is now
untrue and why.
