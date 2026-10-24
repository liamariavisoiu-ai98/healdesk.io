# Lane P6b: the Phase 6 screens (Approvals, Patient rights) — builder: Fable

Read `RULES.md` first (trailer EXACTLY `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; check every commit with
`git log -s --format='%(trailers:key=Co-Authored-By,valueonly)'`). Also read the P5b brief (`lane-P5b-screens.md`) and the files it
built: they are the pattern for server actions, step-up code fields, standby handling and word tables.
Worktree `/Users/liamariavisoiu/projects/healdesk-p6b`, branch `ops/p6b-screens`, cut from the lead's integration branch `ops/p6-integ`
(main plus lanes P6a approvals and P6c rights, fixed after review). apps/web only; no database. `npm ci` has run.
Owner's rule for every screen: VERY CLEAR AND EASY TO UNDERSTAND, no repetition, no information that is not useful for the ops.
Every sentence must be true against the code (an Opus accuracy reviewer will check each one).

## What to build (use ONLY ops-client functions that exist on the integration branch; read their types)
1. **Approvals** — a section of the Queues page (`apps/web/src/app/admin/queues/ApprovalsSection.tsx`, anchor `id="approvals"`, listed in the
   page's SECTIONS nav and given its own outcome query key like the other sections; `/admin/inbox` redirects to `/admin/queues#approvals`):
   from `fetchApprovals()`: one card per waiting item: the clinic's name (link to its Billing tab), what is proposed in one plain sentence
   (the packet's `effect`), the packet facts in words (amount, attempts, reason in plain words from a word table you write for the closed reason/engine
   codes; a test fails if a code has no words), whether the worker that will carry it out is switched on, how long it has waited and when it
   expires ("leaves the list without running on <date> if nobody decides"). Controls with EXACTLY these names: **"Approve"** and **"Reject"**
   (Reject asks for a reason from the closed list, in plain words), both asking for the field labelled **"Code from your authenticator"**
   (reuse the CodeField from the Setup tab) and both calling the step-up wrapper `decideApprovalWithCode` in `lib/admin/approval-decide.ts`
   (NEVER the raw ops-client `decideApproval`; a test already scans for the raw name: do not mention it anywhere, not even in a comment).
   The outcome line says what really happened ("Made due again; the billing worker carries it out at its next run" — read the
   `ApprovalDecision` types and the executors' messages in apps/app so the words match). A tab **"History"** from `fetchApprovalHistory()`
   (event words, who by (the operator label), when; no drafts). Empty: "Nothing is waiting for your yes." A failed read says so, never a zero.
   Irreversible items get a confirm sentence before the code field ("This cannot be undone once the billing worker has carried it out.").
2. **Patient rights** — a new page `apps/web/src/app/admin/rights/page.tsx` (`/admin/rights`; add it under Compliance in the nav model the
   admin shell uses, and give it an `id`/title "Patient rights"): from `fetchRights()`: a table of open requests across clinics: clinic, kind in
   words, received, due, business days left (never "0 days left" while overdue), state chip (on time / due soon / overdue / blocked / done), the Retell step
   for erasures. Controls with EXACTLY these names: **"Record a request"** (a form: clinic, kind, received day, how it was verified, asked-for kind for a
   passed-on request; it generates a request key (uuid) ONCE when the form opens and sends it, so a double click records once; calls
   `recordRightsIntake`; shows the outcome: recorded / already recorded), **"Copy command"** (copies the prepared command text from the row
   to the clipboard, nothing is run; when the row is blocked it shows the row's note instead of a button), **"Mark done"** (calls
   `closeRightsIntake`; shows the refusal sentence when an erasure's Retell step is not recorded yet). Above the table one plain sentence that
   the page runs nothing: "This page runs nothing. You run each command yourself." A failed read says so; standby shows the standby notice.
   Never print a person, a contact id, or anything typed; the ids on screen are the clinic's name and the request's kind and dates.
3. **Links**: Home rows from apps/app point at `/admin/queues#approvals` and `/admin/rights`: both must exist (`inbox-links.test.ts` fails otherwise);
   add `issue-link.ts` anchors if the alerts use them (`approval_waiting`, `rights_request_*`: read how P5b did `SYSTEM_ANCHORS`).
4. **PLACES proofs**: add to `apps/app/src/lib/ops/alert-wording/places.ts` (the lead allows this one edit in your lane) the names the Phase 6
   alerts quote, with proofs pointing at your files: "Approvals" (section title), "Approve", "Reject", "History", "Code from your authenticator"
   (ApprovalsSection.tsx), "Patient rights" (page title), "Record a request", "Copy command", "Mark done" (the rights page's components). Run
   `cd apps/app && npx vitest run tests/alert-wording.test.ts` (no database) until green: it also checks every no-clinic page and anchor.
5. **System map / nav**: if the admin nav or `system-map.ts` lists pages, add the two (a hot file: additive `REGISTER:` commit only if needed).

## Files you OWN
`apps/web/src/app/admin/queues/**` (ApprovalsSection and the page's section list), `apps/web/src/app/admin/rights/**`, `apps/web/src/app/admin/inbox/**`
(redirect), `components/admin/**` (new word files), `lib/admin/{issue-link}.ts`, their tests, and the one edit to `alert-wording/places.ts`. Not:
`ops-client.ts` (REGISTER only if a type is missing; STOP and report instead), `apps/app` otherwise, `AGENTS.md`, `CLAUDE.md`, `docs/`.

## Tests
Static-render tests per state (waiting items, empty, failed read, standby, truncated), each control calls the right function with the right
arguments (mock the wrappers/ops-client), the code field is required, no raw-name mention (the existing scan), word tables cover every code
(read the closed lists from apps/app source text), the request key is generated once per form open, the rights page never renders a command
for a blocked row. FULL `npm test -w @healdesk/web`, `npx tsc --noEmit -p apps/web`, `npm run lint`, `npm run build -w @healdesk/web` (delete `.next` afterwards:
disk is nearly full), `cd apps/app && npx vitest run tests/alert-wording.test.ts`.

## Report
RULES.md format; list every control and section name with its anchor, and what you did not build.
