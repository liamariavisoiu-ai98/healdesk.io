# Lane A2: the two admin reads in apps/app — builder: Opus

Read `RULES.md` first. Worktree `/Users/liamariavisoiu/projects/healdesk-ops-a2`, branch `ops/a2-strip-inbox`.
First command: `git merge --ff-only ops/lead` (brings `apps/web/src/lib/admin/strip-types.ts`, the contract).
Postgres: container `hd-ops-a2-pg`, port `55501`. **No new table, no migration** (if you think you need one,
STOP and report). Design: `designs/E1-admin-redesign.md` §2 (Clinics strip, Home), §4 steps 2 and 4.

## Goal
Add two read-only typed operations that the redone admin draws, built from data that exists today:
1. `listClinicStrip` → `ClinicStripRow[]` (see `strip-types.ts`): one row per clinic in ONE envelope: stage
   (setup day n of 30 with deadline, live since, paused, offboarding, closed), channel levels, calendar state
   (healthy/degraded/broken/none from connection health), voice agent state (from the `voice_agents` row and
   drift/error flags — same facts `voiceAgentStatus` uses, WITHOUT any vendor call), transcript counts (30 days:
   waiting, bounced — from the transcript outbox receipts), usage (worst meter, whole percent, from the billing
   row; do not recompute what `lib/billing/usage-alerts.ts` or `lib/portal/billing.ts` already compute: reuse),
   `blocking` (first blocker message in operator wording), `synthetic` (however the codebase marks demo/test
   clinics; verify). `availability` and `lastReminder` are returned as `null` for now (lanes B and C fill
   them). No names beyond the clinic's own. Ids, enums, counts, dates only.
2. `opsInbox` → `OpsInbox`: rows for things that need the operator today, from SOURCES THAT EXIST: open
   `ops_alerts` (unresolved), the digest's queue tally (call `collectDigest()` from `lib/ops/digest.ts`; do NOT
   edit digest.ts, another lane owns it this wave), `listClinicHealth` flags, practice reviews owed, support
   replies owed, Retell recording alerts, site-read failures, setup requests owed if readable, launch-promise
   blockers if readable from apps/app (if only apps/web can read them, skip and say so). Build it as an
   extensible registry: `lib/ops/inbox/sources.ts` exports `INBOX_SOURCES: InboxSource[]`, each source a small
   file `lib/ops/inbox/<name>.ts` returning rows or throwing; the runner catches per source and reports it in
   `unreadable` (never a zero where nothing was read). Other lanes will add sources by appending a file and one
   line. Order: earliest `dueAt`, then tone (bad, warn, info), then count. Each row's button is a link to a page
   that EXISTS TODAY (`/admin/ops/<id>/care`, `/onboarding`, `/admin/reviews`, `/admin/support`,
   `/admin/recordings`, `/admin/site-reads`…); the admin lane will redirect old URLs forever, so these keep
   working. One sentence per row, plain language, no product prose, no repeated clinic name inside the sentence.
   Closed `INBOX_KINDS` list exported.

## Files you OWN
`apps/app/src/lib/ops/strip.ts`, `apps/app/src/lib/ops/inbox/**`, their tests (`apps/app/tests/ops-strip*.test.ts`,
`ops-inbox*.test.ts`). **REGISTER commit** (additive only): `lib/ops/api.ts` (two cases), 
`apps/web/src/lib/admin/ops-client.ts` (`fetchClinicStrip(): Promise<OpsResult<ClinicStripRow[]>>`,
`fetchOpsInbox(): Promise<OpsResult<OpsInbox>>`, types imported from `./strip-types`, follow the neighbours'
pattern incl. envelope validation) and its contract test, `apps/web/src/lib/admin/system-map.ts` only if the
ops-envelope bridge wording lists operations (check `system-map.test.ts`). The ops envelope's closed operation
list and any "every operation is classified read/write" test must pass.
Do NOT edit `strip-types.ts` (lead owns the contract); if you need a field changed, STOP and report.

## Tests required (real database)
- Strip: seed clinics in each stage (setup day 3, setup day 29, live, paused, offboarding/closed, synthetic),
  channel mixes, a broken calendar, a drifted voice agent, bounced + waiting transcripts, usage at 50/95/100%;
  assert exact rows. Assert the result contains no key outside the contract and no free-text field (walk the
  JSON). Assert one query count does not grow per clinic (N+1 guard: 30 clinics read in a bounded number of
  queries; measure with a query counter if the harness has one, otherwise reason in the report).
- Inbox: each source produces its row; a throwing source lands in `unreadable` and the others still render; an
  empty database gives `rows: []` with `checkedAt`; ordering; links all start with `/admin/`.
- ops API contract: both operations are read-only, need the signed envelope, and reject unknown args.
- `ops-client` contract test updated. Row-level security: reads run in the ops (cross-tenant) context the other
  ops reads use; copy that pattern exactly, check a neighbour like `listClinicHealth`.

## Report: RULES.md format; also list the exact SQL/queries count for the strip, every inbox source and what
it reads, and any source you could not build with the reason.
