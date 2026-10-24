# Lane P5d: machine queues read, Home follow-ups, the lifecycle ignore list (Phase 5) — builder: Opus

Read `RULES.md` first (trailer EXACTLY `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; check every
commit with `git log -s --format='%(trailers:key=Co-Authored-By,valueonly)'`).
Worktree `/Users/liamariavisoiu/projects/healdesk-p5d`, branch `ops/p5d-queues`, cut from main `3a688325`.
`npm ci` has run there. Postgres container `hd-p5d-pg`, port `55532`. **Reserved migration: `0118`** (its journal
`when` strictly above 0116's `1792822181669`; lane P5a holds 0117 and will land first, so keep your `when` above
`1792822181669` + 1 day to leave room, and expect the lead to adjust it at merge).

## Why
The Home list names several machine queues (emails waiting, Stripe events parked, billing requests, paid orders without
an account, unsent ops alerts) and links every one of them to the Clinics list, which shows none of it; the sentence even
admits "the console has no page for it yet". The owner decided (24 Oct 2026): a read-only section under System where
the section that lists what is past its patience is headed "Requires your attention". Separately, wave 1 and 2 left
four follow-ups that make Home tell the truth, and the owner wants internal test accounts left out of the lifecycle
watch.

## Already decided (do not reopen)
- Machine queues are READ-ONLY: no buttons that act. They list a queue, a count, the age of its oldest item and a link.
- A queue "requires attention" by the rule `lib/ops/inbox/queues.ts` already has (`patienceMinutes`); reuse that rule so
  Home and the new section can never disagree. Everything else is shown below it as "Being watched" with counts only.
- Internal test accounts: an owner-managed list of clinic ids the lifecycle watch ignores. Managed by an operator in the
  console (P5b builds the UI), recorded with who and when, reversible. An ignored clinic raises no setup-window alert,
  no ops wave, no "decision owed" Home row, and shows "Not watched (internal)" where the strip shows lifecycle; it is
  NOT hidden from the Clinics table and its real problems (calendar, voice, billing) still alert.
- D6: days waiting on us never extend a deadline automatically (button only).
- Ops mail and Slack carry ids, counts, dates, enums and the clinic's NAME only. Never a patient field.

## What to build (apps/app, then the apps/web mirrors)
1. **Operation `listMachineQueues`** (read; `lib/ops/machine-queues-ops.ts`): reuse the readers in
   `lib/ops/inbox/queues.ts` (export them; do not copy the SQL). Result:
   `{ queues: [{key, words, count, oldestAgeMinutes|null, needsAttention, tone, href}], partial: string[] }` with the
   queues the file already reads: outbox, outbox dead letters, transcript copies not delivered, billing requests, Stripe
   events retrying and parked, Connect events retrying and parked, paid orders without an account, accounts below the
   BAA floor, ops alerts that could not be emailed, plus failed background jobs if the file reads them. A part that
   cannot be read is named in `partial` and absent from `queues`, never a zero. No new tables, no writes, no access-log
   row (the file's header explains why Home must not write rows the digest would). Mirror as `fetchMachineQueues`.
2. **Repoint the Home rows**: every `href` in `QUEUE_WORDS` that is `CLINICS_PAGE` becomes
   `/admin/system#attention` (export it as ONE constant, `MACHINE_QUEUES_PAGE`, so P5b can change the anchor without
   touching the sentences), and delete the `NO_PAGE` suffix and any test that asserts it. The bounced-email and
   dead-letter rows must still say what the queue is in plain English. Update the tests.
3. **Home gains the digest's email dead letters and bounces** (wave 1 follow-up): read what `lib/ops/digest.ts` counts
   for dead-lettered clinic emails and bounces/complaints; add them as inbox rows (in `queues.ts` if they are queue-shaped,
   else a new source file) with plain sentences and a link to where the owner can act (find the page that exists:
   Deliveries tab of the clinic if one clinic, else the machine-queues section). Do not duplicate a row `queues.ts`
   already produces for `outbox_dead`; check first and say what you found.
4. **"Extend the setup window" stamps the lifecycle** (wave 2 follow-up): in `opExtendSetupDeadline`
   (`lib/ops/billing.ts`), after a successful extension, in the same request, record on `clinic_lifecycle`: the new
   `deadline_at` and decision `extended` (with the operator's label and time, as `decideLifecycle` does; reuse its
   function, do not write the row a second way), so Home's "decision owed" row clears at once instead of waiting for
   the next watch run (or forever with the watch off). If the clinic has no lifecycle row, create nothing and say so in
   the result. Test: extension then `opsInbox` has no decision row for that clinic, with the watch job never run.
5. **Lifecycle ignore list** (migration 0118): table `lifecycle_ignored_clinics` or a column on `clinic_lifecycle`,
   whichever fits the existing design best (read `lib/lifecycle/*` and `drizzle/0115`); you decide, and justify in the
   report. Operations `setLifecycleIgnored {clinicId, ignored: boolean, note?: short closed phrase list or null}` (write;
   audit row and security event naming the operator) and `listLifecycleIgnored` (read), with `listLifecycle` and the
   strip gaining an `ignored` flag. Every consumer of the watch must skip ignored clinics: the hourly watch, waves, the
   decision source, the recommendation, the lifecycle block of the digest. A free-text note is NOT allowed (ids and a
   closed phrase list only). Mirror as `setLifecycleIgnored(clinicId, ignored)`, `fetchLifecycleIgnored`. Tenant table
   rules: RLS, grants (no DELETE unless needed), `readonly-tables.ts`, `TENANT_SCOPED_TABLES`, and the closure/destruction
   code (`app_close_clinic_account`, `KEPT_FOR_GOOD`, `lib/retention/purge.ts`) as RULES.md and the lead's traps list say.
6. **apps/web client for `getAgreement`**: the operation exists in apps/app; add `fetchAgreement(agreementId)` with a
   strict envelope parser and contract test. (`retryVoiceAgent` and `voiceAgentStatus` clients belong to lane P5a.)
7. **Go-live row**: find out whether Home already shows clinics that are ready to go live or held (grep the inbox sources,
   `lib/onboarding/go-live.ts`, `go_live_held`). If missing, add one source `lib/ops/inbox/go-live.ts`: one row "N clinics
   are ready to go live" (when the check's only open items are ours or all clear and the clinic is not live) or "N clinics
   are held at go-live", with the first clinic's link, using `goLivePreconditions` per clinic in the existing per-clinic
   pattern. If it already exists, say so and do nothing.

## Files you OWN
`apps/app/src/lib/ops/{machine-queues-ops,lifecycle-ops,billing}.ts` (billing.ts: the one extend function only),
`lib/ops/inbox/{queues,go-live,decisions}.ts`, `lib/lifecycle/**`, `drizzle/0118_*`, their tests; apps/web: `lib/admin/` only
through the REGISTER commit. HOT, additive only, ONE final commit titled `REGISTER:`: `lib/ops/api.ts`, `db/schema.ts`,
`drizzle/meta/_journal.json`, `scripts/readonly-tables.ts`, `lib/ops/inbox/sources.ts`, `apps/web/src/lib/admin/ops-client.ts`.
Not: `alert-wording/**`, `slack.ts`, `notify.ts`, `templates/*`, `docs/on-call.md`, `AGENTS.md`, `CLAUDE.md`, apps/web pages.
If a new ops EVENT is needed, STOP and report; you should not need one.

## Tests (real database; report the skip count; fake the clock)
- machine queues: each queue's count and oldest age from seeded rows that mirror what production writes (do not seed a
  state the code never produces); `needsAttention` agrees with the Home row rule for the same data (one test asserts the
  two functions agree for every queue); an unreadable part is in `partial`; the op writes nothing (row counts before/after,
  including access-log tables).
- Home: the repointed links; dead-letter/bounce rows; the extension clears the decision row without the watch running;
  an ignored clinic is absent from the watch, waves, decisions, digest block and strip lifecycle, and a real calendar alert
  for it still fires; un-ignoring restores it; the ignore list's write is refused without an operator and leaves an audit row.
- Migration: applies on top of 0116 and 0117 (rebase check: run migrations with 0117 simulated absent too), RLS and grants
  verified through the runtime role, `readonly-tables`, `migration-journal`, `delivery`, drizzle-kit "No schema changes".
- apps/web: contract tests for every new client function; `npx tsc --noEmit` for both apps; `npm run lint`.

## Report
RULES.md format. Also paste: the queue list with each `needsAttention` rule, every new inbox sentence, the design you
chose for the ignore list and why, what you found for item 7, and any contract gap P5b (the screens lane) will hit.
