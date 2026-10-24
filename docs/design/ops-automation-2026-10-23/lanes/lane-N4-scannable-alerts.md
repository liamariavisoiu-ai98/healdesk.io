# Lane N4: an ops alert you can scan in three seconds (wave 3, step 1: the structure and a preview) — builder: Opus

Read `RULES.md` first (trailer EXACTLY `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`).
Worktree `/Users/liamariavisoiu/projects/healdesk-ops-n4`, branch `ops/n4-scannable-alerts`, cut from `main` (everything
of waves 1 and 2). Postgres container `hd-ops-n4-pg`, port `55531` (RULES.md recipe). **No migration.**

## Why (owner, 24 Oct 2026, about the critical-email alert)
"The email body is very detailed but it does not manage to also be clearly indicative of the issue and is not direct
enough. I need to be able to scan the email and understand from the first 3 seconds what the issue is and then if I need
to get into details, I read the rest. Extend styling further to bold and highlighted and underlined text for improvements
as well."

Today (read `lib/email/templates/ops_alert.ts`, `alert-wording/render.ts`, `facts.ts`, `lib/ops/slack.ts`,
`lib/email/templates/compose.ts`, and the rendered samples in the scratchpad `n3-rendered.txt`) every alert opens with a
long sentence, then a facts list, then why it matters, then the steps: all at the same weight, so nothing says "this is
the problem, do this" at a glance.

## The new shape of an alert (email and Slack carry the same content)
1. **An urgency tag**, one word on a coloured chip: `URGENT` (red: money, a legal clock, a patient-facing channel down,
   data about to be lost), `TODAY` (amber: needs a person today), `FYI` (grey/blue: a recovery, a digest, a count). A
   closed per-event map `URGENCY: Record<OpsEvent, "urgent"|"today"|"fyi">` in the wording folder (a new
   `urgency.ts`), with a test that every event has one; start from the existing escalation set (`ESCALATIONS` /
   rotating_light) and the wording's content; list your choices for the owner to review in the report. The subject
   gains `URGENT:` ahead of the title for urgent events only (70-character subject limit still holds).
2. **A headline**, ONE line, bold and large: the clinic's name first when there is one, then what is wrong in plain words
   with the one fact that matters. Example for the critical-notice alert: "**Radiance Med Spa has not received a
   payment-failed notice: 10 minutes late, still retrying**". A new optional wording field `headline` (at most 90
   characters, placeholders allow-listed for the event, no jargon, not just the title repeated); until a writer provides
   it the renderer falls back to the title plus the clinic's name. For SIX events write the real headline now (the five
   hand-written ones plus `critical_notice_undelivered`) so the owner can judge the look; the other 90 are written later
   by wording writers.
3. **A "Do this first" box**, highlighted (yellow background, bold label): step 1 of the alert, followed by the console
   button ("Open in the console", or the page's name when the link is a page). Step 1 appears ONCE: the numbered list
   below continues at 2 (no repetition: the owner's rule).
4. **"More detail"** below a thin rule, at normal weight: the rest of what happened (the sentences after the headline's
   own), the facts list, "Why it matters" (bold label), then "Then" and the remaining steps numbered from 2, then the
   reference line ("Alert code: …", small and grey).
Order on the page and in the preheader: urgency, headline, do first; the preheader (the preview line in the inbox) is
`<urgency>: <headline>`.

## Styling (email HTML, plain-text email, Slack)
Inline markers in wording strings, parsed by ONE function used by email, text and Slack:
`**bold**`, `__underline__`, `==highlight==`. Rules:
- **HTML email**: `<strong>`, `<u>`, and highlight as `<mark style="background:#fff3a3;color:inherit;padding:0 2px">`
  (inline styles only; check the existing dark-mode and client conventions in `compose.ts`); text escaped BEFORE markers
  are applied; unbalanced or nested markers are rendered as plain text, never as broken HTML.
- **Plain-text email**: markers stripped; the urgency tag and labels in capitals ("DO THIS FIRST:") so the text part
  scans too.
- **Slack mrkdwn**: bold as `*x*`; underline and highlight map to bold (Slack has neither); the urgency as an emoji
  prefix (reuse the existing `:rotating_light:` for urgent; a neutral one for today and FYI); the headline as the first
  line in bold, "Do this first:" next, a divider, then the details. All steps stay (owner decision: Slack carries the
  same full text). Keep the 3,000-character block rule.
- **Automatic emphasis** (so 96 wordings do not each need markers): every VALUE filled into a placeholder is bold in the
  headline and the first sentence (clinic name, counts, days, closed words), days and deadlines are highlighted
  (`==…==` equivalent), and in steps the names of console places and buttons are bold and underlined (use the lint test's
  `PLACES` list: MOVE it to a runtime module `alert-wording/places.ts` that both the renderer and the test import; the
  test keeps its proof of each place in apps/web source). Longest match first; never inside a link; apply once.
- **Safety**: a filled value that contains `**`, `__`, `==`, `<`, `&` or any marker character must not create emphasis or
  markup: neutralise marker characters in values before substitution (tests with hostile names and business names).

## Files you OWN
`apps/app/src/lib/ops/alert-wording/**` (types, render, facts, new `urgency.ts` and `places.ts`, `index.ts`; the six
`headline`s in their section files), `apps/app/src/lib/email/templates/ops_alert.ts`, `compose.ts` (ADDITIVE: new block
types such as `headline`, `callout`, `rich`; every other email must render byte-identical: the existing snapshots prove it),
`apps/app/src/lib/ops/slack.ts`, `apps/app/src/lib/email/lint.ts` (only if the new markup needs a rule: additive),
`apps/app/tests/alert-wording.test.ts`, the email-templates and ops-slack tests and snapshots. Not `AGENTS.md`,
`CLAUDE.md`, `docs/on-call.md`, migrations, apps/web.

## Tests
Real database where alerts are raised. Run alert-wording, ops-alert-wording, ops-slack, ops-notify, email-templates (read
EVERY snapshot diff: only `ops_alert` ones may change), ops-console-links, ops-health-and-digest, lifecycle-rules, tsc both
apps. New tests: marker parsing (balanced, nested, unbalanced, hostile values, all three outputs), the step-1-once rule
(step 1 never appears twice in any event's email or Slack), urgency map complete, headline lint (≤ 90 characters, no
jargon, no placeholder outside the allow-list, falls back correctly), the subject limit with `URGENT:`, and a render test
for every event (headline present or fallback, do-first present, no marker text left, nothing prints undefined).

## Preview for the owner
Write standalone HTML previews of the rendered EMAIL (the exact HTML the template produces, wrapped only in a minimal
page) to the scratchpad directory: `critical-late.html`, `critical-dead.html`, `calendar-stuck.html`, `setup-decision.html`,
`usage-near-cap.html`, plus the Slack text of each as `.txt`. Tell me the paths. The lead shows them to the owner before the
other 90 headlines are written.

## Report
RULES.md format; the urgency table (event → level, grouped, for the owner to review); the previews' paths; how every other
email stays byte-identical; anything in the owner's request you could not do.
