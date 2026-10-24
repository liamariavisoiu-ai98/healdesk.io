# Lane N2: write the plain-English wording for every remaining ops alert (wave 2) — builders: Fable, four in parallel

Read `RULES.md` first (trailer EXACTLY `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`). You are one of four
writers; each owns a disjoint set of section files. Worktrees `/Users/liamariavisoiu/projects/healdesk-ops-n2<letter>`,
branches `ops/n2<letter>-wording`, cut from branch `ops/integ2` (main plus lanes G, H, N1, A3). No database,
no migration, no apps/web changes; run `npm test -w @healdesk/app -- tests/alert-wording.test.ts` (it needs no
database) and the other wording tests listed below.

## Owner standard (his words, 23 Oct 2026)
Every ops notification must carry enough context that the ops person understands the whole situation from the message
alone, written short, in plain non-technical English, with very detailed numbered steps for what to do next. He opened
an alert that said only an event code, a bare id and "Reply today" and could not tell what it meant.

## What you write
For each event you own, replace the `legacy(title, action)` entry in its section file under
`apps/app/src/lib/ops/alert-wording/` with a full `AlertWording` (`title`, `whatHappened`, `whyItMatters`, `steps`),
and remove the event from that file's `LEGACY` set. Study the five finished examples first
(`setup-and-support.ts` setup_request_reply_past_due, `usage.ts` usage_near_cap, `calendar.ts` calendar_write_stuck,
`setup-progress.ts` lifecycle_decision_due, `availability.ts` clinic_availability_changed) and the rendering at
`/private/tmp/claude-501/-Users-liamariavisoiu-projects-healdesk-io/e1f97130-1c27-4792-9400-8ab82d0d72db/scratchpad/five-rendered-review.txt`.

**Wording rules**
- Say what happened in one to three short sentences (about 20 words each at most), naming who or what is affected
  (the clinic's name by placeholder) and when it started or what the deadline is when there is one.
- `whyItMatters`: the consequence for a clinic, a patient-facing channel, money, or a legal promise, in one or two
  sentences, with the deadline if there is one. Never alarmist, never blame.
- Steps: numbered (the list is the model's `steps` array), at least two and usually three to six, ordered with the
  safest first, each starting with a verb, each naming the exact page or button in today's console; say what NOT to do
  where a wrong move is likely or irreversible (a send, a refund, a close); the LAST step says what "done" looks like.
- No event codes, no snake_case, no file paths, no SQL, no job or service names, none of the lint's JARGON words
  (see `tests/alert-wording.test.ts`). Plain names for things: "the clinic's Billing tab", "Queues", "System → Jobs".
- Facts only from placeholders in the event's allow-list (`alert-wording/fields.ts` `EVENT_FIELDS`: extend it, in your
  own commit hunk, for any field the raising code really passes: read the raising code to find them, never guess).
  Never a patient, a free-text field, an appointment time (days only), a phone number or an address.
- Every step must be TRUE. Before you write a step, find the page or control in the code: apps/web
  `src/app/admin/**` (clinic panel tabs Setup, Billing, Deliveries, Care, Account; Queues; Compliance; System) and what
  the control does (read the server action and the apps/app operation). Controls built in lane A3 exist: Setup tab
  cards "Availability changes" (buttons "Run audit now", "Mark as seen") and "Setup window" (buttons "Extend the setup
  window", "Offered a call", "Let it close", "Snooze alerts"), Deliveries "Reminders". If a step would need a control
  that does not exist, write the true alternative and list the gap in your report: do not invent a button. State
  facts about system behaviour (what a retry does, whether an email is sent, who is told) only after reading the code
  that does it; where the code decides a branch (e.g. a reason code), give the step per branch.
- Extend `PLACES` in `tests/alert-wording.test.ts` (each place tagged page or button, proven by its text appearing in
  apps/web source) only for places your steps name; keep your additions in one contiguous hunk so merges are trivial.
- Each event's text may use the placeholder syntax N1 built (`{key}`, `{key:noun}`, `[optional clause]`,
  `[?field=a|b: clause]`); see `render.ts`.

## Assignments (events are in the legacy sets listed in each section file)
- **N2a**: provisioning, billing, usage, email-delivery.
- **N2b**: setup-and-support, agreements, voice, calendar, transcripts.
- **N2c**: go-live, account, offboarding, patient-rights, incidents, vendors, meta, retention.
- **N2d**: setup-progress, morning-digest, availability (the eight lifecycle events and `ops_digest_summary`; also
  switch `lifecycle_decision_due` and `clinic_availability_changed` to name lane A3's controls instead of the Touch
  log, removing the temporary comments N1 left), then update `docs/on-call.md` "Alert runbook, by event" so each section
  matches the new wording (the runbook is the longer reference, the alert is the short action list: do not copy one
  into the other; fix anything that is now wrong).

## Files you OWN
Your section files, `alert-wording/fields.ts` (your hunk), `tests/alert-wording.test.ts` (PLACES hunk only), N2d also
`docs/on-call.md`. Nothing else. Do not touch another writer's section files, `render.ts`, `facts.ts`, templates.

## Tests and report
Run `tests/alert-wording.test.ts`, `ops-alert-wording.test.ts`, `ops-slack.test.ts`, `email-templates.test.ts` (update the
snapshot only if it changed because of your wording, and read its diff), `tsc --noEmit -p apps/app`. Report: branch,
sha, the events you wrote (count), every step you could not make fully true with the missing control, a rendered
sample of three of your events in email and Slack form (use the helper N1's tests use to render), and the final
LEGACY set for your files (must be empty).
