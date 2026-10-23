# Lane A1: the admin shell (screens and wording) — builder: Fable

Read `RULES.md` in this folder first. Worktree: `/Users/liamariavisoiu/projects/healdesk-ops-a1`, branch
`ops/a1-admin-shell`. First command: `git merge --ff-only ops/lead` (brings in `strip-types.ts`, the contract
you draw from). No database needed (apps/web only). apps/web tests: `npm test -w @healdesk/web -- <files>`.

## Goal
Redo `/admin` so it is very clear, with no repetition and no noise: Home ("what needs me today"), Clinics (one
table of status chips), a five-tab clinic panel, Queues, Compliance, System, five-item nav. Plus the "Fix with
Claude" panel (Tier 1 only). Design: `designs/E1-admin-redesign.md` (all of it, esp. §2 IA, §3 design-system
rules, §4 migration plan) and `designs/E7-fix-with-claude.md` steps 1 to 3. Decisions: D11 yes (feed → System →
Changes, old URLs redirect forever); synthetic clinics hidden behind a "Synthetic" filter chip; Clinics table
collapses to cards under 640 px; `/admin/map` and `/admin/host` live under System but KEEP their URLs.

## Steps (E1 numbering). Each is its own commit group; keep every existing panel test passing unchanged
0. `components/admin/ui.tsx` primitives (Section, Tag/Chip, Failure, Empty, Row, ActionButton, ClinicId,
   IssueAnchor), `--color-done` token in `globals.css`, replace the seven copied `Section`s. New `ui.test.ts`
   renders every tone. `ClinicId` stays importable from `OpsConsole.tsx` (re-export) until step 8.
1. `/admin/clinics` table from the existing reads (`fetchClinics`, cards, health, jobs), old `/admin/ops` kept.
   Chips per `ClinicStripRow` in `lib/admin/strip-types.ts`.
2. (UI half) the extra columns come from `fetchClinicStrip()` which lane A2 adds to `ops-client.ts`
   (`Promise<OpsResult<ClinicStripRow[]>>`). Build against fixtures; wire the call behind a small adapter so
   swapping is one line. `availability: null` and `lastReminder: null` draw as a muted "not measured yet".
3. Clinic panel shell `/admin/clinics/[id]/{setup,billing,deliveries,care,account}`: tabs mounting the EXISTING
   panels with the same props. Old `/admin/ops/[clinicId]/{onboarding,billing,care,transcripts,account}` become
   `redirect()` (a redirect test per old route). Deliveries tab = Transcripts panel first; the merge of the
   three ledgers is step 7.
4. (UI half) Home from `fetchOpsInbox()` (lane A2: `Promise<OpsResult<OpsInbox>>`), fixtures first. Row = count ·
   one sentence · clinic (name + copyable id) · one button. Empty state one line with the time. Commit feed moves
   to `/admin/system/changes` (`changes.ts`, `roadmap.ts`, `honesty.test.ts` untouched).
5. `/admin/queues` with sections (Reviews, Agreement checks, Support, Retell deletions, Site reads, Setup
   requests); each old queue URL redirects as its section lands. Page tests that import a page default move
   with the body.
6. Compliance absorbs agreement checks, launch promises (one home; removed from `/admin/seo`), agreements,
   incidents, notices as sub-routes. Notices' six send forms go behind a "Send a notice…" disclosure; the
   180-day ledger stays open.
7. Deliveries tab merges the three delivery ledgers with a kind filter (billing emails, "what was sent",
   transcripts, setup reminders; Status history folded in as a kind). Keep receipts without words.
8. Nav 16 → 5 (Home · Clinics · Queues · Compliance · System) with a current-section mark; noise removal list in
   E1 §2 "Noise removed" (do ALL of them, including rewording "recovered" to "booked by AYA"); delete
   `OpsConsole.tsx` last (move `ClinicId` to `ui.tsx`, update `ids-visible.test.ts`'s import).
E7: `lib/admin/fix-with-claude.ts` (closed map from OPS_EVENTS event to template and runbook anchor; uuid/enum
validation; URL-encoding; 5,000-char guard; a forged field is refused; every OPS_EVENTS entry has a template —
read `OPS_EVENTS` in `apps/app/src/lib/ops/notify.ts`, mirror the names, and add a test that fails when the two
lists differ), `components/admin/FixWithClaude.tsx` (Open in Claude Code via `claude-cli://`, Copy prompt, Open in
VS Code; renders only on /admin; the link decodes back to the template), `.claude/skills/fix-ops-alert/SKILL.md`,
runbook anchors in `docs/on-call.md`. Do NOT edit `.claude/settings.json` ask-rules (lead decides, they change
every session's prompts); list the rules you would add in your report. Prompt values: ids only.

## Files you OWN
`apps/web/src/app/admin/**`, `apps/web/src/components/admin/**`, `apps/web/src/lib/admin/**` EXCEPT
`ops-client.ts`, `ops-client*.test.ts`, `system-map.ts`, `strip-types.ts`; `apps/web/src/app/globals.css`
(only `--color-done`); `.claude/skills/fix-ops-alert/**`; `docs/on-call.md`. **Do not touch** anything in
`apps/app`. If a screen needs an operation that does not exist, STOP and report it (A2 adds
`fetchClinicStrip`, `fetchOpsInbox` in `ops-client.ts`; you only import them once they exist on your branch —
until then use an adapter returning fixtures, and say so in the report).

## Issue-link shape (lane-shared)
`lib/admin/issue-link.ts`: `/admin/clinics/<id>/<tab>#<event>-<id>` (tabs: setup, billing, deliveries, care,
account); tested; `IssueAnchor` scrolls to and highlights it (`:target`). Alerts built in apps/app (Phase 1)
use `/admin/ops/<id>/care|onboarding`; those redirect to the new shape forever.

## Tests required
Every existing admin test unchanged and green; `ui.test.ts`; `clinics-list.test.ts` (static render, fixtures);
a redirect test per moved route; `home-copy.test.ts` (every row has a count, a sentence and a link; empty state
one line; unreadable source prints "Could not read X"); `issue-link.test.ts`; `fix-with-claude.test.ts`;
`client-imports.test.ts` and `honesty.test.ts` green. Run `npm test -w @healdesk/web` fully at the end, plus
`npx tsc --noEmit -p apps/web`, `npm run lint`, and `npm run build -w @healdesk/web` if feasible. Look at the
screens in the browser pane on `next dev` if sign-in can be bypassed with test env (do not use real
credentials; if you cannot sign in to /admin, say so; do not claim it looked right).

## Report: use RULES.md format; also list every route before → after, and every noise item removed.
