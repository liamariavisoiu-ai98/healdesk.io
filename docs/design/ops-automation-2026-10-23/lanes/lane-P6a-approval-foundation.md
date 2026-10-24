# Lane P6a: the approval inbox foundation and the billing triage kinds (Phase 6, wave A) — builder: Opus

Read `RULES.md` first (it is binding; note section "Traps already hit" in the lead's start prompt is restated at the end of this brief).
Trailer EXACTLY `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; check every commit with
`git log -s --format='%(trailers:key=Co-Authored-By,valueonly)'`.
Worktree `/Users/liamariavisoiu/projects/healdesk-p6a`, branch `ops/p6a-approvals`, cut from main `784297e2`. `npm ci` has run.
Postgres container `hd-p6a-pg`, port `55571`. **Reserved migration: `0119`** (journal `when` strictly above 0118's `1792848051003`).
Design: `designs/E6-back-office.md` §2 (the inbox) and §3 item 15 (billing triage), plus D17, D18, D21 below. The design was written by an
agent from main at 2e258ae9: **verify every claim in the code** (names, files, line numbers have moved).

## Why
The owner wants every money, legal and clinic-contact step to wait for his explicit yes, with an immutable record of who said yes to
what. Today the console has separate buttons (retry a billing request, replay an event, retry an overage invoice, commit a refund)
and a Home list; nothing collects "waiting for you" in one place, and nothing records the decision as a unit. One shared inbox is the
foundation for the next waves (BAA chase, agreement question, patient-rights, incidents, the weekly pack, editable reminder drafts).

## Already decided (do not reopen)
- **D21 (24 Oct 2026):** the admin has one shared sign-in; "who approved" means the operator account (its label, the device/IP and
  user agent the request carries, the time). Irreversible approvals need a FRESH authenticator code. No per-person sign-ins now.
- **D17:** the worker's 10 automatic billing retries and Stripe's dunning stay ungated. The inbox gates from the DEAD LETTER onward, one
  item at a time. No bulk approve for money.
- **D18:** only the owner approves an incident report; a waiting legal-clock item re-alerts email and Slack every 4 hours; **nothing is
  ever approved, sent or closed by timeout.** Items may EXPIRE (email draft 14 days, retry 7 days) into status `expired`, which only
  removes them from the waiting list; an expired item is never executed.
- **One execution path:** approving runs the EXISTING operation inside the same apps/app request (`opRetryBillingRequest`,
  `opRetryOverageInvoice`, `opReplayBillingEvent`...), so the inbox can never do more than the console button does. Read each
  operation's guards and audit rows and keep them; the approval event records the operation's outcome code.
- The fresh-code check happens on apps/web, not apps/app (apps/app holds no TOTP secret): copy the exact pattern of
  `apps/web/src/lib/admin/voice-drift.ts` (`requireOperator`, then `checkFreshOperatorCode` from `lib/admin/fresh-code.ts`, then the
  signed request; the code never crosses). A decision on an irreversible kind that arrives at apps/app without the web wrapper's mark must be
  impossible by construction (a test fails if any file other than the wrapper imports the raw `decideApproval` client function).
- Ops mail and Slack carry ids, counts, dates, enums and the clinic NAME only. The inbox's `draft`/payload hold no patient data (billing
  kinds have none). Money amounts are the clinic's own plan prices (business data), never a card or an invoice PDF.

## What to build (apps/app first, then the apps/web clients; screens come in lane P6b, not yours)
1. **Migration 0119**: `ops_approvals` and `ops_approval_events`, both apps/app tables (not tenant tables if they must be listed across
   clinics: decide and justify as the neighbours do; `clinic_id` is a nullable column), classified in `scripts/readonly-tables.ts`, in
   the closure/destruction code as appropriate (they may be kept for good: legal record; say which and why), with grants for the runtime
   role (no DELETE), RLS if tenant-scoped.
   - `ops_approvals`: id, `kind` (a closed list in code AND a CHECK constraint), `clinic_id` nullable, `subject_ref` (an id, text),
     `payload` jsonb (validated per kind; ids and codes only; a CHECK or a trigger that rejects digits-runs and `@`), `draft` and
     `draft_hash` (nullable: only email kinds), `due_at`, `urgency` (`legal_clock`|`money`|`routine`), `proposed_by` (service name),
     `proposed_at`, `status` (`waiting`|`approved`|`rejected`|`expired`|`executed`|`failed`), `decided_at`. A partial unique index on
     (kind, subject_ref) WHERE status = 'waiting' so a proposer can never double-propose.
   - `ops_approval_events`: ADD-ONLY (a trigger refuses UPDATE and DELETE and TRUNCATE; model it on `platform_compliance`'s). Each row:
     approval id, event (`proposed`|`edited`|`approved`|`rejected`|`executed`|`failed`|`expired`|`reminded`), `actor_label`, `ip`, `user_agent`
     (as the request carries them; null for service events), `draft_hash_approved`, `draft_hash_sent` (nullable), outcome code, at.
     Each operator decision also writes one `security_events` row.
2. **Proposer** (`lib/approvals/proposers.ts`, a job `approvals-propose` seeded OFF with a named switch in the migration AND in
   `tests/setup/db.ts` AND `tests/delivery.test.ts`'s job list; hourly): finds, across clinics, (a) dead-lettered billing requests
   (`kind` + attempts exhausted; read how `billing_request_dead_lettered` is raised), (b) annual overage invoices that failed
   (`overage_invoice_failed`), (c) Stripe events parked after retries (`billing_event_dead_lettered`), and inserts ONE waiting approval per
   subject (idempotent through the unique index), kinds `billing_request_retry`, `overage_invoice_retry`, `billing_event_replay`.
   Never retries anything itself. It also expires items past their window (event `expired`) and, for `urgency = legal_clock` items past
   `due_at` or waiting, raises the re-alert described under 5. Exclude demo clinics (`app_clinic_is_demo`), and clinics whose account is closed.
3. **Operations** (own file `lib/ops/approval-ops.ts`; REGISTER the cases): `listApprovals {status?, limit?}` (read; returns each item with its
   computed PACKET: the facts the owner needs, read live from the existing readers, ids/codes/amounts/days only: for a billing request
   what the retry does in money in plain words ("starts the package price on the subscription at $X a month, replacing the $0 line";
   "cancels the subscription now; this cannot be undone") using `@healdesk/catalog` prices, the reason code of the dead-letter, attempts
   of 10, Stripe subscription status, whether a newer request supersedes it), and `decideApproval {id, action: approve|reject,
   reasonCode, editedDraft?}` (write; MUTATING). `approve` executes the kind's operation in the same request through a registry
   `EXECUTORS[kind]`; an executor that refuses (guard) returns the refusal and records `failed` with the outcome code; a double
   decision on the same id is refused (compare-and-set on `status = 'waiting'`). `editedDraft` is for email kinds (none yet in this
   lane): implement the plumbing (lint again, keep both hashes) but no kind uses it yet; test it with a test-only kind.
   `listApprovalHistory {limit?, kind?}` (read) from `ops_approval_events`, without drafts.
4. **apps/web clients** (additive, REGISTER commit): `fetchApprovals`, `fetchApprovalHistory`, and the gated decision in a NEW wrapper file
   `apps/web/src/lib/admin/approval-decide.ts` (`decideApprovalWithCode(id, action, reasonCode, code)`), with strict parsers and contract
   tests; a test that no other apps/web file mentions the raw `decideApproval` client function name.
5. **Events** (new ops events; follow the lead's traps list): `approval_waiting` (a waiting item is past its due time / a legal-clock item
   re-alerts every 4 hours; the alert is `notifyOps`-based, fields: `clinicId?`, `kind`, `count` (items waiting), no ids of patients) with:
   wording in a section file under `alert-wording/` in the CURRENT format (title, `headline`, `whatHappened`, `whyItMatters`, numbered `steps`
   naming only pages/buttons that exist: the Approvals section does not exist until lane P6b builds it at `/admin/queues#approvals`;
   write the steps for that page and add its names to `places.ts` as P6b's names — see "Control names P6b will build" below), an `urgency`
   in `urgency.ts`, `EVENT_FIELDS` (`fields.ts`), `NO_CLINIC_PAGE` (`tabs.ts`) = `/admin/queues#approvals`, the web mirrors
   (`apps/web/src/lib/admin/ops-events.ts`, `fix-with-claude.ts` `RUNBOOK_ANCHOR`, `issue-link.ts` tab sets), a `### ` heading in
   `docs/on-call.md`. The lint test refuses codes, jargon, one-step lists and non-existent places: run it. `approval_executed_failed` only if you
   find a failure the owner must act on that the item itself does not show (probably not; say so).
6. **Home source** (`lib/ops/inbox/approvals.ts`, registered in `sources.ts` and `INBOX_KINDS`, test list updated): one row per kind with
   waiting items: "N billing retries are waiting for your yes" (plain sentence, no codes), tone by urgency, link `/admin/queues#approvals`.

## Control names P6b (the screens lane) will build — write wording/places against these exact names
Section **"Approvals"** (anchor `#approvals`) on the Queues page; per item: **"Approve"**, **"Reject"**; a **"History"** tab; the fresh-code field
labelled "Code from your authenticator". Add these names to `alert-wording/places.ts` with proofs pointing at the files P6b will create
(`apps/web/src/app/admin/queues/ApprovalsSection.tsx`, labels exactly as above); because the files do not exist yet, add the proofs in your
REGISTER commit but mark that the lead will land P6b together, and make the lint test pass by creating minimal stub strings is NOT
allowed: instead leave `places.ts` untouched and list the names in your report; the lead adds them with P6b.

## Files you OWN
`apps/app/src/lib/approvals/**`, `lib/ops/approval-ops.ts`, `lib/ops/inbox/approvals.ts`, `drizzle/0119_*`, `apps/web/src/lib/admin/approval-decide.ts`,
`alert-wording/approvals.ts` (new section file; register it in `alert-wording/index.ts`), their tests. HOT, additive only in ONE final commit
titled `REGISTER:`: `lib/ops/{api,notify}.ts`, `db/schema.ts`, `drizzle/meta/_journal.json` + snapshot, `scripts/readonly-tables.ts`,
`lib/ops/inbox/{sources,types}.ts`, `alert-wording/{fields,tabs,urgency}.ts`, `apps/web/src/lib/admin/{ops-client,ops-events,fix-with-claude,issue-link}.ts`,
`apps/web/src/lib/admin/system-map.ts` if you add a job/bridge, `docs/on-call.md` (new heading only), `tests/{setup/db,delivery,ops-inbox}.test.ts` lists.
Not: `AGENTS.md`, `CLAUDE.md`, `slack.ts`, templates, `.github/`, `infra/`, apps/web pages.

## Tests (real database; report skip count; fake the clock)
- Immutability: UPDATE, DELETE and TRUNCATE on `ops_approval_events` are refused for the runtime role AND the migrator.
- Proposer: seeds that mirror what production writes (a billing request dead-lettered by the real code path, not a hand-set state); idempotent
  across runs; excludes demo/closed clinics; never executes.
- Decide: approve executes exactly the existing operation and its outcome is recorded; a refused executor records `failed`; double decision
  refused; reject executes nothing; an expired item cannot be approved; a decision without an operator is refused; a `legal_clock` item
  re-alerts at most every 4 hours; nothing changes status by timeout except `waiting` → `expired` for the kinds with a window.
- Packet: contains no free text (assert the key set), money words match the catalog price; no `@`, no digit-runs beyond amounts.
- Web: contract tests for each client function; the raw-name guard; the wrapper refuses a wrong/missing code and sends nothing.
- Registry tests: operations lists, `readonly-tables`, `migration-journal`, `delivery`, `alert-wording`, `email-templates` snapshot unaffected,
  `system-map`, drizzle-kit "No schema changes". Run the FULL `npm test -w @healdesk/web` at the end.

## Traps (from the lead)
Seeds must mirror production; never gate on `data_classification` (use `app_clinic_is_demo`); forced RLS hides rows: a DB test must `set app.clinic_id`;
a new tenant table needs RLS, grants, `readonly-tables.ts`, `TENANT_SCOPED_TABLES`, closure code and `lib/retention/purge.ts` coverage; a new job is
seeded OFF with a switch in the migration AND `tests/setup/db.ts` AND `tests/delivery.test.ts`; a new ops operation needs OPERATIONS +
MUTATING_OPERATIONS + a `case` + the strict web mirror + a contract test; Drizzle `when` must exceed the previous migration; the later snapshot's
`prevId` must be the earlier's `id` and `drizzle-kit generate` must say "No schema changes".

## Report
RULES.md format. Also paste: the table DDL, the kinds list with their executor and packet sentences, every new sentence the owner will read
(packet words, Home row, alert wording), the control names you assume for P6b, and every place you had to guess.
