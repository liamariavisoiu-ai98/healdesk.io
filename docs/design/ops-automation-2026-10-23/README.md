# The ops automation program

Status: **plan, nothing built.** Written 23 October 2026 from the owner's answers to a list of twenty
proposed automations, and from eight read-only design studies in `designs/` (one per area, each from
reading `main` at `2e258ae9`). Building starts only when the owner approves a phase. Every step lands the
way this repository lands everything: a branch, tests, CI, the owner's go-ahead, then `main`.

## What the owner decided

Quoted in full in `designs/00-brief.md`. In short: extend the morning digest; **no** deploy verifier;
usage-near-cap, stuck provisioning (with the setup deadline folded in) and the clinic reminders as email
plus Slack, in time waves, every reminder visible in admin; closures and roster edited by the **clinic** on
its own dashboard, with ops getting a Slack alert, an indicator on the clinic list and an automatic audit
(plus a manual button); calendar failures retried a set number of times, then mail and Slack with links;
voice drift repaired automatically and alerted; transcript delivery watched; an automated, calm support
team by email and chat with every email approved, edited and sent by the owner; agreement, BAA,
billing, patient-rights, incident and compliance assistants, all gated by the owner; a demo pipeline report
now and a simple sales page later; launch promises and cost on the admin; and **the admin redone so it is
very clear, with no repetition and no noise.**

## What the studies found that changes the picture

Checked against `main` unless marked otherwise.

- **The support chatbot already exists** (`apps/app/src/lib/support/*`, `SupportChat.tsx`, route
  `/c/[slug]/help/chat`; 56 tests; not live-verified). What is missing is everything around it.
- **Both clinic editors exist**: closures in Knowledge → Hours, roster in Settings → Calendar → Booking
  detail. No spec change is needed. The missing pieces are on the ops side.
- **There are 105 typed ops operations**, not 60. Voice agent status and calendar writes have no screen.
- **A real bug**: closed days reach the booking engine but not what the assistant says. AYA can say
  "we're open" on a holiday with no slots. Fixing it is a product-behaviour change (owner's call, below).
- **A real gap**: a calendar write that ends `failed` or `unknown` alerts nobody.
- **Slack exists only in `apps/web`**, with no retry and no record. `apps/app` cannot post to it.
- **Ops emails cannot link to the console**: the email link scanner accepts only the app's own origin
  and Stripe. The owner's "links to the issue" needs one narrow exception (decision D3).
- **There is no inbound email processing at all**, and `hello@` sits outside every BAA. Receiving support
  email is infrastructure plus a policy decision, not a feature flag.
- **`/admin` is an engineering commit feed**, with 16 unmarked nav items, the same `Section` copied into six
  files, three delivery ledgers, launch promises on two pages, and phase-two noise on every clinic card.
- **No link can make Claude fix something with nobody present.** Links pre-fill a prompt and the owner
  presses Enter (verified by the study from Anthropic's documentation; some points marked NOT VERIFIED
  in its file). Unattended routes exist (scheduled tasks, GitHub Actions) with real limits.
- **The CRM must not use Stripe Payment Links for the sale**: they skip the agreement and the provisioning
  gate. Custom one-off charges are possible only for existing clinics.

## Five foundations, built once, used by many

| # | Foundation | Needed by | Source design |
| --- | --- | --- | --- |
| F1 | **Slack from `apps/app`** (allow-listed fields, retries, a record on `ops_alerts`) | alerts, audits, stuck setup, support, calendar | E2, E3 |
| F2 | **Console links in ops emails** (one exception: `ops_alert` kind, `/admin/` paths only) | every alert the owner wants linked | E3, E7 |
| F3 | **The admin shell**: Home ("what needs me today"), Clinics (one table of status chips), a five-tab clinic panel, shared components, one issue-link shape | everything with a screen | E1 |
| F4 | **The lifecycle watch and reminder ledger** (stages, timed waves, every send recorded) | stuck provisioning, setup deadline, usage near cap | E2 |
| F5 | **The approval inbox** (everything waiting on the owner; immutable record) | support drafts, billing, BAA, incidents, extensions | E6 |

## Phases, in order

Each phase names what the owner sees, the size, and the designs it comes from. Sizes are the studies' own.
Migration numbers are assigned when a step is built, one at a time, so two branches never claim the same one.

**Phase 1: quick, low-risk, nothing structural (about a week).** F1 (Slack from `apps/app`), usage-near-cap
events to ops, the calendar-write alert, the closed-days fix for the assistant (if approved), and the demo
pipeline row (E8 steps 1 to 3). *The owner sees:* Slack alerts for usage and failed calendar writes, and demo
stalls retried. *From:* E2 (1, 2), E3 (6, 8), E4 (5), E8 (1 to 3).

**Phase 2: the admin redo (F3).** Eight steps, page by page, old URLs redirect, all existing panels and
tests keep working. The Home list is built on the existing digest, so the extra morning data points appear
without a second digest. *The owner sees:* a clear Home, one Clinics table, one panel per clinic.
*From:* E1. Includes "Fix with Claude" on issue views (E7 steps 1 to 3) and console links in ops mail (F2).

**Phase 3: availability changes and audits.** `clinic_change_events`, the audit framework (six check packs,
four triggers, the manual button), the status on the clinic list and panel. *The owner sees:* a clinic
changes its hours, Slack says so, the list shows it, the audit result appears within minutes. Includes the
proof test (close a day, no slots that day). *From:* E4 (1 to 4, 6, 7), E3 (1 to 4, 9).

**Phase 4: stuck provisioning, setup deadline, reminders (F4).** The two lifecycle tables, the hourly
watch, wave schedules, the clinic-facing notices, the "Needs a decision" list, the reminders timeline on
each clinic. *The owner sees:* every reminder sent, to whom, delivered or bounced, and a button when a
clinic is worth an extension. *From:* E2 (3 to 7).

**Phase 5: monitors that need no new infrastructure.** Calendar backoff and stuck-write alerts, voice
drift (the clear-flag fix and wording), transcript delivery watch panel. *From:* E3 (6, 7, 9).

**Phase 6: the approval inbox and back-office assistants (F5).** `ops_approvals` plus an add-only event
table, `/admin/inbox`, then billing triage, the BAA chase list, agreement packets, the patient-rights
tracker, the incident assistant, the weekly pack, in that order. *From:* E6.

**Phase 7: the support system.** Chat tone layer and cases first, then the redone `/admin/support` and the
drafter with its eight checks, then approve-and-send, and last inbound email (SES on `in.healdesk.io`, an
infrastructure change needing a plan and apply). *From:* E5, S1 to S9. The longest phase; it cannot land
before decisions D12 to D16.

**Later session: the sales page.** Five stages, one board, Won set only by the Stripe webhook, an offer
composer on the existing checkout link. *From:* E8 (CRM-A to D).

## How it gets built

One writer per file at a time. The hot files (`OpsConsole.tsx`, `ops/api.ts`, `ops-client.ts`,
`ops/notify.ts`, `system-map.ts`, `email/lint.ts`, the schema) mean phases that touch them are built in
order, not in parallel. Within a phase, independent steps run as worktree-isolated subagents (Fable for
screens and wording, Opus for engineering), then an Opus reviewer reads each diff cold, then CI, then the
owner. Nothing here needs a "workflow" run; ordinary subagents are enough.

## Decisions the owner must make

Grouped by when they are needed. Each has the studies' recommendation.

**Before Phase 1**
- **D1 Slack from `apps/app`** with a key on the AWS host (new parameter, `/admin/map` entry). Slack signs no
  BAA. *Recommend yes*; alerts are already limited to ids, counts and the clinic name. (E2, E3, E4)
- **D2 Clinic names in Slack and ops email.** Business data, not PHI; today `notifyOps` forbids names even
  in email. *Recommend an allow-list*: name, id, counts. (E2)
- **D3 Console links in ops email**: one extra allowed origin, `https://healdesk.io`, only for the `ops_alert`
  kind and only `/admin/` paths. *Recommend yes.* (E3)
- **D9 Fix the closed-days bug in what the assistant says.** *Recommend yes*; no spec change appears needed.
  (E3, E4)
- **D10 Tell a clinic about bookings that fall on a day it just closed?** (E3)

**Before Phase 2:** **D11** the commit feed leaves the Home (keep it at System → Changes), and old admin
URLs redirect forever so links in emails and docs still land. (E1)

**Before Phase 4**
- **D4 "A reminder with every time frame".** The spec fixes six setup reminders and one per channel after
  go-live. *Recommend keeping six* and adding only non-reminder notices (extended, waiting on us). Doing
  more is a change to the source spec doc, which is the owner's to make. (E2)
- **D5 Should `HEALDESK_OPS_EMAIL` be `hello@`?** Every copy spends Resend's daily quota (100 a day on the
  free plan). **D6** days spent waiting on us extend the deadline automatically? **D7** the threshold for
  the day-22 "decide whether to extend" alert. (E2)

**Before Phase 3:** **D8** keep ops change files (the write path) for these tables as an exception when a
clinic asks? *Recommend yes*; the trigger makes them visible. (E4)

**Before Phase 6**
- **D17** keep the 10 automatic billing retries and Stripe's dunning ungated, and gate from the dead-letter
  onward? *Recommend yes*; they are idempotent and part of the contract. (E6)
- **D18** a backup approver for incidents when the owner cannot be reached. **D19** make the M5
  deletion route a go-live blocker; without it the BAA's 10 business days cannot be met on the host.
  **D20** who else receives the weekly pack. **D21** admin is one shared sign-in, so "who approved" means
  that account. (E6)

**Before Phase 7**
- **D12** free-form text in outgoing email, for one kind (`support_reply`) only, and only with an approval.
  **D13** receive support mail on SES (AWS BAA) at `in.healdesk.io` behind a forwarding rule in the owner's
  mailbox, versus Resend receiving (simpler, non-BAA). **D14** fixed "we've got your email" replies go
  without approval (they remove the silence that causes anxiety); every composed reply waits for Send.
  **D15** the console shows the draft and the case's facts, never the clinic's own words (apps/web holds
  no PHI). **D16** the chat tool `get_open_cases` (dates and states only). (E5)

**For the "Fix with Claude" design:** **D22** Tier 1 only (a button that opens or copies a safe prompt),
or also an unattended Tier 2 that only opens draft pull requests, after a test shows the Claude GitHub
app cannot run the deploy, host or database workflows. (E7)

**For the later sales page:** **D23** a per-card custom discount (and where it ranks among the existing
discounts), and whether Payment Links are allowed for anything. (E8)

## What this plan does not do
It does not build anything yet; it does not change the spec; it does not widen the read or write database
roles; and it never lets Claude send money, legal or patient-adjacent messages on its own.
