# Lane P5c: make the alert wording true after Phase 5 — builder: Fable (writer)

Read `RULES.md` first (trailer EXACTLY `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; check every commit with
`git log -s --format='%(trailers:key=Co-Authored-By,valueonly)'`). Also read `lanes/lane-N4-scannable-alerts.md` (the new structure:
every event has a `headline`, an `urgency` in `urgency.ts`, a "do this first" first step) and `alert-wording/types.ts`, `markup.ts`.
Worktree `/Users/liamariavisoiu/projects/healdesk-p5c`, branch `ops/p5c-wording`, cut from `ops/p5-integ` (main with the scannable alerts,
plus Phase 5 lanes P5a, P5b, P5d). `npm ci` has run. No database is needed: `cd apps/app && npx vitest run tests/alert-wording.test.ts`.
Owner's rule: plain English, full context, numbered steps that name only pages and buttons that EXIST (a lint test enforces it).
Slack carries the same text as email.

## Why
Phase 5 built the controls the alerts used to say did not exist, and changed behaviour the alerts describe. Every sentence below is now
untrue or points at the wrong place. Wording that names a page or button that is not there sends the owner looking for nothing.

## What changed in the product (verify each in the code before you write)
1. **Voice drift** (`voice.ts`, events `voice_agent_drift`, and check `voice_provision_failed`, `voice_deprovision_failed`,
   `retell_fallback_unsynced`, `voice_provision_capped` or whatever else mentions the Voice agent column, a flag, or "nothing in the
   console clears it"): a clinic's Setup tab now has a **Voice agent** card (`#voice`) with **Retry**, **Check against Retell** and
   **Clear flag and recheck** (the last two as the card says; the clear and the retry both ask for the operator's authenticator code).
   A cleared flag runs the drift check once and is skipped on later nights only while flagged. A missing agent or number is never
   recreated automatically; it says who acts (Retell support, or have the person who maintains the engine release the voice set-up and
   provision again): read `apps/web/src/components/admin/voice-words.ts` and `VoiceAgentCard.tsx` for the exact words and controls.
2. **Calendar writes** (`calendar.ts`, `calendar_write_stuck`, and any other calendar event that says "Retry"): writes that end
   `unknown` now retry on a ladder (2 min, 10 min, 30 min, 2 h, 6 h) until the slot starts, 5 tries by the sweep; a 429 and a token
   5xx are retryable now; an operator's **Retry** can go past five tries and always reads Google first; settled reasons
   (deleted in the calendar, event id taken, not ours, no calendar connected, access/connection breaks) are never retried by the
   sweep. A clinic's Setup tab has a **Calendar writes** section (`#calendar-writes`, built by lane P5b) and the System page
   (`/admin/system#calendar-writes`) lists the stuck ones across clinics. See `apps/app/src/lib/booking/calendar.ts` and
   `apps/web/src/app/admin/clinics/[clinicId]/setup/CalendarWrites.tsx`, `components/admin/queue-words.ts`.
3. **Words** (`words.ts` ~L198): "`failed` is any refusal, a timeout or a server error among them" is no longer true (a 429 or token 5xx
   now ends `unknown` and is retried; a timeout never ended failed). Fix it from `failureOutcome` in calendar.ts.
4. **Machine queues** now have a page: `/admin/system#attention` ("Requires your attention") and "Being watched". Events whose
   steps or `NO_CLINIC_PAGE` entry send the owner to `/admin/clinics` or say "no console page" for the outbox, dead letters,
   bounces, Stripe events, parked events, billing requests, orders without an account, unsent ops alerts and failed jobs
   (`critical_notice_undelivered`, email-delivery events, billing events, `ops_alert_unsent`...) should point there. Find them
   by reading `tabs.ts` `NO_CLINIC_PAGE` and grepping the section files. Transcript copies not delivered also have a list on that page
   (`#transcripts`) and the Home row.
5. **Lifecycle ignore list**: the setup-window events (`lifecycle_*`) can say "if this is one of healdesk's own test accounts, press
   **Do not watch this account** on its Setup tab's **Setup window** card". Be exact about what it does (read
   `apps/web/src/app/admin/clinics/[clinicId]/setup/SetupWindow.tsx` `IGNORE_CONFIRM`): it stops ops' setup alerts and the decision row; the
   clinic still gets its setup reminder emails and the account still closes at the end of its window unless extended.
6. **`step_up_phone_held`** (`account.ts` ~L92): the owner decided (24 Oct 2026) that when the step-up is held on a multi-location account
   the CLINIC must switch phone off; phone does not stay on unbilled. Rewrite the steps for that (ask the clinic to switch phone off in its
   portal Settings; do not tell ops to decide each time). Verify what the portal actually calls that switch (`apps/app/src/lib/locations.ts`
   `PHONE_STEP_UP_HELD`, `phoneHeldByLocations`).
7. **Jobs page**: its buttons now read "On · Turn off" / "Off · Turn on" (the quoted name "Turn on" is a whole string in JobsTable.tsx).

## The overlap to resolve (reviewer finding)
The Setup tab's old Calendar card (`OnboardingPanel.tsx`) still lists failed/unknown writes with a per-row **Retry**, and the new
**Calendar writes** section lists the same writes (the counts differ). Fix the repetition: move the proof for the quoted name
`Retry` (`PLACES.Retry` in `apps/app/tests/alert-wording.test.ts`) and for "Calendar writes needing attention" to the new
`setup/CalendarWrites.tsx` (it has a Retry button per row and the title **Calendar writes**), re-point the calendar alert sentences
at "Calendar writes" on the clinic's Setup tab, and then REPLACE the failed/unknown rows in the old Calendar card (`OnboardingPanel.tsx`
~L1272-1298) with one line linking to `#calendar-writes`, keeping the rest of that card. The written-history list may stay if the alerts
or runbook still quote it (check). Keep `npx vitest run tests/alert-wording.test.ts` green and `cd apps/web && npx vitest run
"src/app/admin/clinics"` and the Onboarding panel's tests green.

## Rules for the wording
- Keep every event's `headline` and `urgency` unless the facts changed (then say why). A first step stays "do this first".
- Every named page, section, button and anchor must exist in apps/web today (`places.ts` has the proof table; extend it for new names:
  "Voice agent", "Clear flag and recheck", "Check against Retell", "Calendar writes", "Requires your attention", "Being watched",
  "Do not watch this account", "Setup window").
- No jargon, no codes, no "RLS"-style words, no revenue claims; the lint test says which words are refused.
- Do not invent behaviour: if you cannot verify a sentence in the code, drop it or ask in your report.
- `docs/on-call.md`: update the alert runbook headings/lines for the events you change (the section is generated or hand-written: read it
  and the N4 brief before editing); keep every `OPS_EVENTS` heading present.

## Files you OWN
`apps/app/src/lib/ops/alert-wording/{voice,calendar,words,account,tabs,places,email-delivery,billing,provisioning,...}.ts` (only the sections
you change), `apps/app/tests/alert-wording.test.ts` (PLACES proofs only), `docs/on-call.md` (alert runbook only),
`apps/web/src/app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx` (the calendar rows only) and its tests. Not: `slack.ts`, templates,
`notify.ts`, `ops/api.ts`, migrations, `AGENTS.md`, `CLAUDE.md`, anything else in apps/web.

## Report
RULES.md format. List every event you changed with its old and new first step, every PLACES proof you moved or added, what you could not
verify, and anything an accuracy reviewer should check hardest.
