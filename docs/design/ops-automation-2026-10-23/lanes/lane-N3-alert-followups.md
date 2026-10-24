# Lane N3: what the wording reviews left in shared code (wave 2) — builder: Opus (the N1 builder)

Read `RULES.md` first (trailer EXACTLY `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`). Worktree
`/Users/liamariavisoiu/projects/healdesk-ops-n3`, branch `ops/n3-alert-followups`, cut from branch `ops/integ2`
(everything of wave 2 merged). Postgres container `hd-ops-n3-pg`, port `55528` (RULES.md recipe). **No migration.**

## Why
Four independent accuracy reviews of the new alert wording found problems the wording files cannot fix: limits of the
allow-list, wording defaults in shared code, and one console rule that makes many steps unreachable. You built the
alert-wording structure (lane N1); finish it.

## Tasks
1. **Allow-list and labels** (`alert-wording/allow-list.ts`, `facts.ts`, `fields.ts`, `render.ts` WORDS): add to
   `DAY_KEYS` the dates `destroyAt`, `exportDueAt`, `serviceEndedAt`, `expiresOn`; add closed word lists (plain
   English) for the fields the reviews found unprintable and whose values come from a closed set: `provider` or the
   vendor `code` on the two vendor alerts (the vendor chain: model provider, host, database host, voice provider...
   read `lib/compliance/platform.ts` and `vendor-coverage.ts` for the real closed set; unknown values print nothing),
   email `kind` and request `kind` for `email_refused`, `critical_notice_undelivered`, `billing_request_dead_lettered`
   (read the closed lists in `lib/email/kinds.ts` and `lib/billing/requests.ts`; map each to a short plain phrase such
   as 'a payment-failed notice'), `status` (closed set) and `channel` (phone, website chat, Meta) where the raising code
   passes them. Everything not in a closed list stays unprintable (patient data, ids, free text). Add each new field to
   `EVENT_FIELDS` for the events that really pass it (read the raise site; keep the lint test's field checks true), and
   tests for each word list (an unknown value prints nothing, never the raw value).
2. **Use them** in the wording of the affected events ONLY where a sentence becomes clearly better (name the vendor on
   `vendor_agreement_*`, the due and destruction days on the three offboarding export alerts, the email kind on
   `email_refused`/`critical_notice_undelivered`); keep each sentence plain, keep the lint green, and re-render.
3. **`facts.ts` label bug**: for `practice_question_failed` the field `section` means a practice-question section, and
   the facts list can print 'What changed: weekly opening hours': give that event its own label ('Section').
4. **`tabs.ts` NO_CLINIC_PAGE**: events that name no clinic and have no entry get no console link: add the right page
   (anchors that exist in apps/web) for `access_requests_capped`, `daily_email_count_70`, `dmarc_review_due`,
   `provisioning_*`, `paid_intent_without_clinic`, `agreement_copy_withheld`, `agreement_termination_finished_late`,
   `voice_provision_cap_reached`, `retell_fallback_unsynced` (no clinic), `export_*` if clinic-less, and any other event
   that can be raised without a clinic (find them by reading each raise site; add a test that lists every event and
   asserts it has a link or is a documented exception) and mirror whatever apps/web needs in `issue-link.ts` only if
   the existing drift test demands it.
5. **Shared-code wording defaults** (found by review): `render.ts` `WORDS.decision.extension_offered` prints 'an
   extension was offered' but the console button is 'Offered a call' and the Setup window card says 'a call was
   offered': change to 'a call was offered'; `lib/lifecycle/recommend.ts` sentences 'More time was offered…' become 'A
   call was offered and {no progress…}: phone the clinic.' / 'A call was offered: extend the setup window on the Setup
   window card if they ask for more time.' (update `lifecycle-rules` tests); `lib/clinic/change-events.ts`
   `changeAlertFields`: pass `written`/`deleted` only when above 0 (a removal-only change printed 'It added 0 closed
   days'); `lib/ops/digest.ts` `postDigestSummary`: pass `slackUnpostedCount` only when above 0.
6. **Touch log for every clinic**: the Care tab's Touch log Record form shows only for a production clinic in its first
   sixty days live (apps/web `care/TouchLog.tsx`, apps/app `lib/ops/health.ts` builds the row), so ten alerts' 'note it
   in the Touch log' steps are unreachable for a destroyed, leaving, not-yet-live or older clinic. Make the Record form
   available for EVERY clinic (a note by an operator: counts as business data, not PHI; keep the existing validation that
   refuses patient details, and the audit row). Read `recordClinicTouch` and the `clinic_touches` table (touches are
   tenant rows: destroyed clinics' rows go with the destruction; a note for a destroyed clinic must be refused or kept
   per the existing destruction rules: read `lib/retention` and `app_close_clinic_account` and DECIDE with a test; if a
   destroyed clinic cannot take one, say so on the card). Then the ten wordings may say 'Press Record in the Touch log
   on the clinic's Care tab' without the 'if the tab shows one' hedge: remove the hedge ONLY for clinics that can always
   have one and keep the sentence true for the destroyed-clinic case. apps/web `TouchLog.tsx` and its tests, apps/app
   `lib/ops/health.ts` (the part that gates the touch log), `lib/ops/api.ts` is hot: additive only if needed.
7. **docs/on-call.md**: line ~271 says the console's refund needs a fresh code: it does not (apps/web billing
   `commitRefund` calls ops-client with no code; confirm in code) — fix; fix the Meta line N2c reported ('mark it on the
   clinic's Setup tab': no such control; the Touch log); anywhere else the runbook contradicts the new wording after
   your changes (read the whole 'Alert runbook, by event').

## Files you OWN
`apps/app/src/lib/ops/alert-wording/{allow-list,facts,fields,render,tabs,index}.ts` and, for task 2, the section files of
the events named; `lib/lifecycle/recommend.ts`, `lib/clinic/change-events.ts`, `lib/ops/digest.ts` (only the two
call sites), `lib/ops/health.ts` (touch-log gating), apps/web `care/TouchLog.tsx` and its tests,
`tests/alert-wording.test.ts`, `docs/on-call.md`, their tests. Not the other lanes' files, `AGENTS.md`, `CLAUDE.md`.

## Tests
Real database where touched (`TEST_APP_URL`, RULES.md). Run: alert-wording, ops-alert-wording, ops-slack, ops-notify,
email-templates (read every snapshot diff), lifecycle-rules, lifecycle-watch, clinic-change-events, ops-health-and-digest,
care-ops, readonly-tables, tsc both apps, apps/web admin tests and lint.

## Report
RULES.md format; the new word lists; every event's link status (table); how the Touch log behaves per clinic state;
anything you decided and why.
