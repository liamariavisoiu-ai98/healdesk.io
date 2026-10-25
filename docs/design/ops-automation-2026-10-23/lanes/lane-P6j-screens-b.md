# Lane P6j: the wave B screens — builder: Fable

Read `RULES.md` first (trailer EXACTLY `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; check every commit with
`git log -s --format='%(trailers:key=Co-Authored-By,valueonly)'`; never run `git checkout <ref> -- .`; COMMIT AFTER EACH PIECE). Read the P6b brief (`lane-P6b-screens.md`) and
the files it built (`apps/web/src/app/admin/queues/ApprovalsSection.tsx`, `rights/*`, `components/admin/approval-words.ts`, `rights-words.ts`) and the P5b files: they are the pattern.
Worktree `/Users/liamariavisoiu/projects/healdesk-p6j`, branch `ops/p6j-screens`, cut from the lead's wave B integration branch `ops/p6w-integ` (main plus lanes P6e retention, P6f clinic
contact approvals, P6h weekly pack, P6i incident assistant, all reviewed and fixed). apps/web only (one allowed edit in `alert-wording/places.ts`). No database. Owner's rule for every
screen: VERY CLEAR AND EASY TO UNDERSTAND, no repetition, nothing that is not useful to ops. Every sentence must be TRUE against the code (an Opus accuracy reviewer checks each one).

## What to build (use ONLY ops-client functions that exist on the integration branch; read their types and the apps/app executors/packets they front)
1. **Approvals section — the new kinds.** `components/admin/approval-words.ts` and `ApprovalsSection.tsx` must cover EVERY kind in `APPROVAL_KINDS` (a test already fails when one lacks words):
   billing (existing), the six clinic-contact kinds (`baa_resign_chase`, `agreement_question`, `setup_extended`, `setup_waiting_on_us`, `setup_help_offer`, `setup_reminder_now`)
   and the two incident kinds (`incident_open_batch`, `incident_report_send`). `fetchApprovals` has family filters (billing | incident | contact): the section shows all families,
   grouped, each card with the plain sentence of what approving does (the packet's `effect`), the facts in words, and the existing Approve / Reject / "Code from your authenticator".
   - **Contact kinds** carry a rendered DRAFT and structured editable fields (`packet.contact`: `draft`, `editable`, `fields`). Show the draft text read-only as the clinic will see it,
     and an **"Edit"** control for the closed fields only: `days` (1 to 30, only for the extension), `phrase` (one of phone, website chat, Meta chat, calendar), `note` (optional, from the closed
     per-kind list, shown in plain words). Edit calls `previewApprovalDraft` (read-only: shows the re-rendered draft) and Approve sends `decideApprovalWithCode(id, "approve", reason, code, { fields })`.
     NO free text input anywhere. The owner's fresh code is required for Approve and Reject.
   - **Incident kinds**: the report item shows the pre-filled fields as choices from the closed lists in plain words (event, what happened on, what was exposed, what we did, what to do, delay
     flags): the owner edits by choosing; Approve passes the choices (see the wrapper's incident edit argument). Show BOTH clocks: "Agreement deadline: <day>" and, labelled
     "Our own target (never shown to the clinic)", the internal 24-hour target. A batch item lists the clinics that would get an incident (names, counts, agreement version) before Approve.
2. **Incident assistant** on the existing Incidents page (`apps/web/src/app/admin/compliance/incidents`, anchor `id="incident-assistant"`, title "Incident assistant"): a form to find a scope
   (`fetchIncidentScope`: vendor or channel from the closed lists, from and to days; for database host / AWS the default is every clinic that holds data with in-window counts as information
   and a plain choice "only clinics reached in the window"), a table of clinics with counts and agreement version, and **"Propose opening these incidents"** (`proposeIncidentBatch`: only
   proposes; says so: "Nothing is opened until you approve it in Approvals"). A per-incident **checklist** (`fetchIncidentChecklist`/`tickIncidentStep`): the nine steps in plain words,
   ticked by whom/when, with a **"Tick"** control per step (the sentences must say that ticking records, does not do the step); a **"Propose the report"** button (`proposeIncidentReport`).
   The existing Send report / Not reportable buttons on the page stay untouched.
3. **Compliance pack**: page `/admin/compliance/pack/[week]` (title "Compliance pack"): a printable page (print stylesheet, one page per section group, no nav chrome when printing) of the
   pack from `fetchCompliancePack(week)`: every section in plain words, each number with what it measures; sections that `could_not_read` say so (never a zero); "incomplete" and "made N
   days late" banners when `build.partial` / `build.builtLate`; the labels `ThisWeek`/`AtWeekEnd`/`Now` explained in one line. Add the launch promises section from apps/web
   (`LAUNCH_PROMISES`, `lib/admin/seo/launch.ts`) since apps/app cannot read it. A list of packs (`fetchCompliancePacks`) with a link per week, and a **"Make this week's pack"** control (`generateCompliancePack`)
   shown when a week is missing. Link it from the Compliance page (REGISTERS nav, as `/admin/rights` was). Point `NO_CLINIC_PAGE` for `compliance_pack_ready` at the pack page ONLY IF you can do it
   inside your allowed files; otherwise report it.
4. **Agreements**: the BAA chase list: a section on `/admin/compliance/agreements` (anchor `id="open-resigns"`, title "Open BAA re-signs") from `fetchOpenResigns`: clinic, from version to
   version, days open, last reminder, whether below the floor, whether a chase is blocked and why in words; a **"Propose a chase"** control only where the operator may (the job proposes the
   chase after day 7 itself; an operator button may be absent: check the ops available; do not invent one). The agreement-question screen (Queues > Agreement checks) uses the code field already.
5. **Setup window card** (clinic Setup tab): controls **"Propose more time"** (`proposeLifecycleNotice` kind setup_extended with days), **"Propose: we are finishing it"**
   (setup_waiting_on_us, phrase), **"Offer a five-minute call"** (setup_help_offer), **"Send the next reminder now"** (`pullReminderForward`), each saying plainly that it only PROPOSES an
   email for your yes in Approvals, with the recommendation sentence already on the card beside it, and the refusals in words (read the ops answers: not daytime, a reminder went in the last 5
   days, the sixth is never pulled forward, once per stage, ...). Keep the existing Extend/Let it close controls untouched.
6. **Nav/links**: Home rows link to `/admin/queues#approvals`, `/admin/compliance/incidents`, `/admin/rights`, `/admin/compliance/pack/<week>`; every href the apps/app inbox constants export must
   resolve to a page and anchor (the existing `inbox-links.test.ts` pattern); add `issue-link.ts` anchors if alerts use them.
7. **PLACES proofs** (`apps/app/src/lib/ops/alert-wording/places.ts`, the one allowed apps/app edit): add the names the wave B alerts quote ("Incident assistant", "Compliance pack",
   "Open BAA re-signs", "Make this week's pack", "Propose opening these incidents", "Propose the report", "Tick", "Edit", "Propose more time", etc.) with proofs pointing at your files; keep
   `cd apps/app && npx vitest run tests/alert-wording.test.ts` green (no database needed).

## Files you OWN
`apps/web/src/app/admin/{queues,rights,compliance,clinics/[clinicId]/setup}/**` (the parts named), `components/admin/**` (word files), `lib/admin/{issue-link,approval-decide.ts only to add what is missing}`,
their tests, and the one `places.ts` edit. NOT: `ops-client.ts` (STOP and report if a client function is missing or wrong), `apps/app` otherwise, `AGENTS.md`, `CLAUDE.md`, `docs/`.

## Tests
Static-render/happy-dom tests per state (waiting, empty, failed read, standby, could_not_read, partial, late), each control calls the right function with the right arguments, the code field is
required, NO raw-name mention (the existing guard scans: do not name the raw decide/record functions even in comments), word tables cover every code and kind (read the closed lists from apps/app
source text), no typed text reaches an email edit, the pack page never shows a zero for a `could_not_read` section, printable markup present. FULL `npm test -w @healdesk/web`, `npx tsc --noEmit -p apps/web`,
`npm run lint`, `npm run build -w @healdesk/web` (delete `.next` afterwards: disk), `cd apps/app && npx vitest run tests/alert-wording.test.ts`.

## Report
RULES.md format; list every control and section name with its anchor, and what you did not build.
