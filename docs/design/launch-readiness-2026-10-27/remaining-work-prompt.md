# Paste-ready prompt: finish what Claude can do before launch

Paste everything below the line into a fresh Claude Code session at the repo root.

---

You are the lead for Healdesk's pre-launch engineering. Your job is to build and fix everything
that Claude can do before the first paying clinic goes live, and to stop at every point where the
owner must act. The audit this prompt comes from is
`docs/design/launch-readiness-2026-10-27/status.md` (main at `d6f76734`, 27 October 2026). Read it
first, then **verify it again in the code**: it may be out of date by the time you read it.

## 0. Before anything else

1. Read `CLAUDE.md` in full (especially "THE PHI BOUNDARY", "Product rules the code enforces" and
   "How work is reviewed, tested and landed"), `docs/v1-product-spec.md`,
   `HEALDESK_CLAUDE_CODE_LAUNCH_EXECUTION_PLAN.md`, `docs/claude-session-start.md` (issue its
   receipt), and `AGENTS.md`. `AGENTS.md` lines are very long: read them with `cut -c1-700` or
   `grep`, and expect its snapshot table to be stale.
2. Run `git fetch`, check `origin/main`'s latest CI (`gh run list --branch main`), and
   `curl https://app.healdesk.io/api/health`. Report anything that differs from the audit.
3. Work in your own git worktree per lane (`git worktree add ../healdesk-<lane> -b <branch>
   origin/main`). Never stage in the main checkout: other sessions share its index. Never use a
   bare `git stash`. Never run `git checkout <ref> -- .`.
4. Propose the lane order below to the owner with anything you found that changes it, and get his
   word before building. Rule 6 of "How work is reviewed": scope a big lane to a first useful slice
   and get approval for the rest.

## 1. Stopping rules (never relaxed)

- **Nothing lands on `main`, deploys (`deploy-app.yml`, Vercel), applies infrastructure
  (`infra.yml`, `host.yml`, Terraform) or touches a secret, a Parameter Store value, a Vercel
  variable, a vendor console (Retell, Stripe, Meta, Google, Slack, Resend) or the production
  database without the owner's explicit yes in chat for that action.** A deploy that rolls the
  voice service also needs his word that no call is running or planned. An infrastructure plan
  and apply are separate approvals from a code landing.
- **Never set, and never add code or infrastructure that sets:** `HEALDESK_DIRECT_BOOKING_ENABLED`,
  `voice_real_calls`, `voice_provision_enabled`, `HEALDESK_PHASE_TWO_ATTRIBUTION`. Never mark
  `approvedByCounsel: true` on any agreement, never release BAA 1.6.0 or the direct-booking
  addendum, never record or withdraw a `/admin/compliance` attestation, never move a
  `LAUNCH_PROMISES` item to `on` without production evidence and the owner's word.
- **The PHI boundary:** `apps/web` has no database client and handles no patient data; anything
  needing the database goes in `apps/app`; `apps/web` reaches `apps/app` only through the
  HMAC-signed ops envelope with hand-written projections. No `@vercel/*` and no edge runtime in
  `apps/app`. No real patient data anywhere; synthetic and seed data only.
- **Product rules:** inbound only; the AI disclosure in every opening line; no treatment names in
  payment descriptions, Meta messages or the support chat; the Meta 24-hour window enforced in the
  adapter; no card numbers taken; every failure ends at a direct clinic line; never "HIPAA
  compliant", never revenue claims, no opening dates; copy first, then the switch.
- No spending: no paid model runs (`qa:meta` live, `voice-eval` paid runs), no Retell numbers, no
  Stripe live calls without the owner's yes.
- Never put secrets, PHI, signed agreements or production logs in Git, `AGENTS.md` or PR text.

## 2. Working rules (CLAUDE.md, "How work is reviewed, tested and landed", 25 Oct 2026)

1. One review per lane, at the end, plus a final review of the merged combination. A second
   review round only for money, legal clocks, anything that emails a clinic, and anything that
   records an agreement answer or pauses AYA. Every owner-facing sentence (alerts, screens,
   runbooks, legal pages) gets an accuracy review against the code.
2. Merge as you go: merge `origin/main` into the lane branch before reporting, resolve conflicts
   there, re-verify on the merged tree. Commit after every piece of work, with a message that
   explains why and names the failure prevented.
3. Deterministic tests: fixed dates and ids, no daylight-saving or shared-table collisions; clear
   shared tables per file. Database suites skip silently without `TEST_APP_URL`: always report
   skip counts.
4. Before any handoff run `bash scripts/verify-local.sh` on the exact tree (typecheck, lint,
   drizzle check, the whole `apps/web` and `apps/app` suites; prints pass/fail/skip).
   `VERIFY_QUICK=1` and `VERIFY_APP_FILES=...` are for iteration only. Known flake:
   `guard-spanish` under load (passes alone); say so if it is the only failure.
5. Fewer, bigger landings: batch lanes; push a batch to `check/<name>` to run GitHub CI (about
   5 minutes), read the result on the exact tree, then ask the owner to land.
6. Keep `/admin/map` true in the same change (`apps/web/src/lib/admin/system-map.ts`, and
   `apps/app/src/lib/ops/key-presence.ts` for AWS-side keys). Keep `LAUNCH_PROMISES` true in the
   same change. Every code push to `main` carries an `AGENTS.md` line (delivery-handoff check).
7. Format only touched files with `prettier --print-width 100`.

## 3. Subagents and models

- You are the lead: plan, brief, review, merge. At most four builders at once.
- Builders: a fresh `general-purpose` agent per lane, in its own worktree, with a written brief
  file (`docs/design/launch-readiness-2026-10-27/lanes/<ID>.md`) holding the goal, files,
  acceptance criteria, the stopping rules above and the working rules. Change the brief file to
  redirect a builder; do not message a running builder (it forks a duplicate).
- Models: Opus for anything touching money, agreements, legal text, the PHI boundary, the booking
  engine or security (DB-1, DEP-META, LEGAL-*, SEC-1, E2E); Sonnet for docs truth and register
  hygiene (REG), test scaffolding and run sheets; Haiku only for mechanical searches. Use an
  `Explore` agent for broad read-only sweeps, and a fresh reviewer agent, not anchored on your
  conclusion, for each lane's final review.
- Never fabricate a builder's result; read its diff and test output yourself before reporting.

## 4. Lanes

Order: REG first (cheap, removes wrong facts), then the owner-decision lanes once he has decided,
in parallel where they touch different files.

### REG — make the registers and documents true (no behaviour change)
- **Do:** (a) `AGENTS.md`: replace the stale snapshot (it says VOICE-T20/PR 60 is unmerged; it is
  merged as `0cc5fb87` and deployed) and remove the duplicated snapshot rows inside "Last completed
  work package"; rewrite "Next actions" from the audit. (b) `LAUNCH_PROMISES`: correct `left`
  text that the code contradicts: `direct-booking` (the engine is wired into calls and web chat;
  the switch is refused by `infra/aws/locals.tf` `never_on_app_tasks`, so no route sets it today),
  `data-protection-agreement` (migration 0104 is applied; ask the owner whether to move it to
  `on`), `never-say-meta` (deployed and `qa:meta` passed live on 22 Oct; ask before `on`),
  `no-audio` (agent code runs only from provisioning, which is off). (c) `docs/hipaa-compliance.md`
  vendor table and pre-launch list, `docs/handover.md` "The rest of the BAA chain": mark Retell,
  Anthropic and the database as **owner-reported signed** (not evidenced), RDS chosen and applied,
  PostHog opt-out since 23 Oct, add Slack (no BAA, drafted support replies only, owner's decision
  26 Oct). (d) Propose, do not commit without the owner, the same correction to the spec's "Where
  the chain is complete" table. (e) The `voice_desired` comment in `production.tfvars` says 2 while
  the value is 1: propose a comment fix in the next infra batch (no apply).
- **Accept:** `system-map.test.ts`, `launch.ts`'s tests, the copy guard and the delivery-handoff
  check pass; every changed sentence cites the file that proves it.
- **Files:** `AGENTS.md`, `apps/web/src/lib/admin/seo/launch.ts`, `docs/hipaa-compliance.md`,
  `docs/handover.md`.

### LEGAL-1 — Privacy and Terms say what the support system does
- **Depends on:** the owner approving the wording (proposals from the P7h report: Terms adds "and
  the text of a clinic's email to our support, to draft our reply, which a person approves before
  it is sent"; Privacy adds "Your emails to our support: the text is read once to draft a reply and
  deleted within hours; we keep only the topic, the urgency and counts, never the words"), plus a
  sentence that a drafted reply may be shown in the operator's Slack, and his answer on printing
  `support@`.
- **Do:** edit `apps/web/src/app/privacy/page.tsx` and `apps/web/src/app/terms/page.tsx`, bump
  `LEGAL_VERSION` (`apps/web/src/lib/legal.ts`) as the existing tests require, check the
  agreement-hash hazard (a new legal text on Vercel while the old `apps/app` image re-renders the
  old one; `docs/design/launch-readiness-handover-2026-10-21.md` § 4.2), and update
  `privacy-copy.test.ts`/`terms-copy.test.ts`.
- **Accept:** every new sentence matches `apps/app/src/lib/support/inbound/`, the drafter and
  `slack-reply.ts`; copy guard green; a second review (legal clock).

### LEGAL-2 — BAA 1.6.0 release, prepared not released
- **Depends on:** nothing to prepare; the release itself is the owner's.
- **Do:** on a branch, prepare the release as the register describes (`BAA_TEMPLATES[0]` order,
  the release migration modelled on 0081, Terms § 9's restored sentence under a new
  `LEGAL_VERSION`), with `approvedByCounsel` left **false** and a clear TODO for the owner; write
  the owner's checklist (read the marketing Sheet for 1.5.1 signers, decide the floor and overlap).
- **Accept:** full verify passes with the flag false; the branch is not landed; the diff that
  flips the flag is one line, named in the report.

### DB-1 — a safe route for the direct-booking switch (only if the owner decides to launch it)
- **Depends on:** the owner's decision to offer direct booking at launch, and how the switch may be
  set. Do not start without it.
- **Do:** design first (`docs/design/`), for example a Terraform variable `direct_booking_enabled`
  defaulting to `false`, refused unless the addendum is released, carried to the web and worker
  tasks only, with `never_on_app_tasks` adjusted and pinned by `terraform test`. Leave it `false`
  in `production.tfvars`. Run the booking suites against a real database
  (`booking-tools`, engine, holds, idempotency, `closure-blocks-bookings`) and a synthetic web chat
  booking with the switch on locally.
- **Accept:** the switch remains off everywhere committed; `terraform fmt/validate/test` green;
  a second review (money).

### DEP-META — deposit links on Instagram, Messenger and WhatsApp
- **Depends on:** the owner confirming it still launches (`deposit-link-meta` blocks go-live while
  promised), DB-1's outcome, and his approval of the Terms change (§ 2 says "it sends no payment
  link there"; counsel brief action 4 on Meta prohibitions). Propose a first slice before building.
- **Do:** in `apps/app/src/lib/meta/front-door.ts` and `booking-requests.ts`, send the clinic's own
  deposit link (`lib/billing/deposit-link.ts`) inside the 24-hour window only, through
  `sendMetaReply`, with nothing clinical and no treatment name; dropped outside the window by the
  adapter. Update the register item, `/admin/map` bridge words, and the Terms in the same batch.
- **Accept:** tests for in-window, out-of-window, treatment-name refusal, idempotency (one live
  link per appointment), and a Meta message containing nothing clinical; `qa:meta` cases added
  (run live only with the owner's yes); second review (money).

### NOAUDIO-2 — prove the no-audio promise without depending on provisioning
- **Do:** check how a hand-made clinic agent's storage settings are verified
  (`lib/voice/provision.ts` `verifyVoiceAgent`, `lib/ops/audit-ops.ts`); if a hand-made agent with
  the wrong `data_storage_setting` or retention would not raise an alert, add that check to the
  existing audit and recordings alert path. Write the owner's test-call run sheet for the deletion
  check (reuse `docs/design/live-checks-checklist-2026-10-21.md` steps D to G).
- **Accept:** a test showing a mis-set agent raises the alert; run sheet in `docs/design/`.

### OPS-1 — restore into production, designed
- **Do:** `infra/aws/README.md` says putting a restored copy in production's place is "not designed
  in full or rehearsed". Write that design and runbook (order fixed by `docs/handover.md`,
  "Restoring": destruction runs again before anything reads the data), reviewed against the code
  and the workflows. The drill itself is the owner's in CloudShell.
- **Accept:** a runbook the owner can follow without guessing; every command checked against the
  Terraform names; no apply.

### SEC-1 — the approval passcode, if the owner wants it hardened
- **Depends on:** the owner's yes (he accepted the weakness on 26 Oct).
- **Do:** propose options (longer code; a lockout shared by every instance, kept in `apps/app`
  and reached from `apps/web` through the signed ops envelope; alerting on any wrong try). Build
  only the option he picks, in `packages/catalog/src/approval-passcode.ts` and its two callers.
- **Accept:** tests for the lockout across two instances; second review (agreement answers).

### E2E — a synthetic clinic journey, end to end, locally
- **Do:** one script or test that runs a synthetic clinic from checkout (Stripe test mode and its
  test cards on localhost) through first paid invoice, provisioning, magic-link sign-in, passkey,
  the wizard's four steps, a web chat conversation with an urgent message, a booking request, the
  transcript email through the outbox (to a fake SES), and the alert queue. Then write the
  owner's production run sheet for the same journey on his own test clinic.
- **Accept:** runs green in `verify-local.sh`'s database; documents every place it stubs a vendor.

### WEBCHAT-2 — optional, not blocking
- Consider whether `web-chat-on-paste` can confirm the snippet without an operator (for example
  the widget's first load from the clinic's own origin), keeping the bubble's "call the practice"
  until confirmed. Propose before building.

## 5. Owner-only actions (not tasks for you; keep the list current in `AGENTS.md`)

- [ ] Confirm `RESEND_API_KEY` on the host; confirm the Anthropic key is the HIPAA organisation's.
- [ ] Switch on `billing-notices`, `daily-summary`, `weekly-recap`, later `support-draft`,
      `support-send`, `support-inbound-sweep`; set alert recipients.
- [ ] Stripe: live `stripe:setup`, live webhook endpoint, `STRIPE_PAYMENT_METHOD_CONFIGURATION`,
      Stripe Connect and `stripe_connect_client_id`.
- [ ] Slack app and its five parameters; mailbox forwarding of support@ and hello@ to
      in.healdesk.io; confirm the SNS alarm email.
- [ ] Release BAA 1.6.0 (or counsel); approve or drop the direct-booking addendum; decide direct
      booking and deposits at launch; decide per-channel or platform-wide go-live blocking.
- [ ] Fill in the Security Official; sign off the policies; file the AWS Artifact screenshot;
      record the vendor attestations on `/admin/compliance`; withdraw a stale `launch_promises`
      attestation.
- [ ] Approve the Privacy/Terms wording; decide on printing `support@`; decide the Retell demo
      agents' transcript storage; native-speaker and counsel review of the Spanish lines; decide on
      a healthcare attorney (state disclosure, Meta policy, UAE entity, agreements).
- [ ] Meta App Review; WhatsApp Tech Provider and the WhatsApp login configuration id; WhatsApp
      payment method per clinic; Google OAuth verification (consent-screen screenshot).
- [ ] Retell: the workspace key holding the product agents, outage mode, numbers for the first
      clinic; `RETELL_DEMO_ENGINE_AGENT_ID` on Vercel.
- [ ] Restore drill; clinic-side test call; no-audio deletion check; AYA-off reaches the direct
      line; a forwarded call per carrier; a live `qa:meta`; one real purchase on a test clinic.
- [ ] `voice_desired = 2`, Multi-AZ, WAF decisions; an independent security assessment.
- [ ] After every agreement: `voice_real_calls = true`, and the final launch attestation.

## 6. Before you stop

Update `AGENTS.md` (the "Continuously maintained session handoff" section, keeping the top
guidance unchanged): current lane and status in the five states (CODE, TESTED, DEPLOYED, LIVE
VERIFIED, OWNER APPROVED), UTC time, branch and HEAD, dirty paths, changed files, exact test
results with skip counts, CI run ids, blockers, owner decisions received, and **one next
executable step**. Say plainly what is local, pushed, landed, deployed or live-verified. Then give
the owner a short plain-English summary and the list of decisions you need from him.
