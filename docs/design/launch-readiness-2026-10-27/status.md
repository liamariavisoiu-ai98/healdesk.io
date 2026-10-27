# Launch readiness, 27 October 2026

Written for the owner. Read-only audit of `main` at `d6f76734` (the code deployed to AWS is
`fdc762cc`, which differs from it only in `AGENTS.md`). Every claim below was checked in the
code, in GitHub's run history or against the live health endpoint, unless it says
**owner-reported** (you told a session; nothing in the repo proves it) or **unknown** (it lives in
AWS, Vercel, Retell, Meta, Stripe or the production database, which this session cannot read).

Status words: **DONE-VERIFIED** (built and seen working in production), **DONE-UNVERIFIED**
(built, tested on a test database, deployed or ready, but never seen working for real),
**NOT STARTED**, **BLOCKED-ON-OWNER** (only you can move it).

---

## 1. Bottom line

**No, a first paying clinic cannot safely go live today.** The software is largely built and
deployed, CI is green on `main`, and the AWS host is up (`/api/health` answered `ok`, database ok,
no failed queue items, no late critical emails, on 27 Oct). But the go-live gate is shut by design,
and it is shut for real reasons:

1. **13 open launch-register items block go-live** for every clinic on every channel
   (section 4). The gate refuses your `launch_promises` attestation while any is open.
2. **The clinic agreement on offer (BAA 1.5.1) states the AI provider's retention wrongly**;
   1.6.0, which corrects it, is drafted and not released. The register says no clinic goes live
   under 1.5.1.
3. **Direct booking and deposit links are promised in the copy but switched off.** The direct
   booking switch, `HEALDESK_DIRECT_BOOKING_ENABLED`, cannot be set by any route today: Terraform
   refuses it on every task (`infra/aws/locals.tf` `never_on_app_tasks`). The register's own text
   ("the switch is set, the infrastructure applied") is out of date on this.
4. **HIPAA paperwork you must do yourself is open:** the Security Official's name is still
   `[founder's legal name — fill in]` (`docs/policies/security-official.md`), the policies are
   "drafted, not yet read and signed off", and no restore drill has been run.
5. **Nothing has been proved end to end with money or a real channel:** Stripe's product setup has
   never been run against a live key, no synthetic purchase-to-first-answer run is recorded, no
   clinic-side (non-demo) call has been taken, and Meta App Review and Google's verification are
   not evidenced as submitted.

**The shortest honest path** is a **web-chat-only first clinic**, because web chat needs the
fewest outside approvals (no Retell, no Meta, no carrier):

1. You decide what launches: either finish direct booking and deposit links (approve the
   direct-booking addendum, choose how the switch is set, set up Stripe Connect), **or** take
   those promises out of the copy for now. Either closes four blocking items (`direct-booking`,
   `deposit-link-chat`, `deposit-link-meta`, `direct-booking-addendum`).
2. Release BAA 1.6.0 (or send it to counsel). Claude prepares the release branch.
3. Switch on `billing-notices`, `daily-summary` and `weekly-recap`; confirm `RESEND_API_KEY` is set
   on the host. Closes `alert-sender-on` and `daily-summary`.
4. Fill in the Security Official, sign off the policies, record the Anthropic, database-host and
   AWS attestations on `/admin/compliance`, confirm the Anthropic key is the HIPAA organisation's.
5. Run the restore drill; run `stripe:setup` live; make one real purchase on a test clinic of your
   own and watch it provision, sign in, run the wizard and answer a website chat.
6. Voice-only and Meta-only items (`no-audio`, `forwarding-codes`, `voice-service`,
   `failure-direct-line`, `never-say-meta`) still block the platform-wide attestation as written.
   For a web-chat-only launch you would need to either close them or decide, in writing, that the
   register blocks only the channels it concerns. **That is a change to your own rule; Claude must
   not make it without you.**

Then voice (test calls, carrier forwarding, `voice_real_calls`) and Meta (App Review, WhatsApp
Tech Provider, Meta deposit links) follow as separate go-lives.

---

## 2. What is built, by product

| Product | Built | Seen working for real | Status | What is missing |
| --- | --- | --- | --- | --- |
| **Voice agent (Retell, custom-LLM WebSocket)** | `apps/app/src/voice/server.ts`, `lib/voice/retell.ts`; voice service on AWS (`enable_voice = true`, 1 task, 1 vCPU) | Your demo test calls (for example 72dc66b7, d2d9a915) ran on this endpoint's demo path | DONE-VERIFIED for demos; DONE-UNVERIFIED for clinics | No clinic-side call (the patient path of the made-up demo clinic) has been taken; Spanish not heard; `voice_real_calls = false` so only the demo clinic is answered; agents and numbers are made by hand while `voice_provision_enabled = false` |
| **Web chat widget** | `apps/app/src/widget/v1.js`, `/api/widget/v1/[slug]/*`, safety suites for web chat | No production chat on a clinic site recorded | DONE-UNVERIFIED | Goes live only after an operator confirms the snippet on the clinic site (`web-chat-on-paste`, not blocking) |
| **Meta bot (Instagram, Messenger, WhatsApp)** | Webhook, connect flows, 24-hour window in the adapter, clinical screen, never-say list; takes booking requests only (`lib/meta/front-door.ts`) | `qa:meta` 13/13 once on 22 Oct (one sample) | DONE-UNVERIFIED | No deposit link on Meta (promised, blocking); WhatsApp embedded signup is off (`meta_whatsapp_config_id = ""`, needs Tech Provider); App Review not evidenced; Meta policy risk (section 6) |
| **Clinic portal and wizard** | Home, Settings, Knowledge, Conversations, Bookings, Billing, Setup, step-up and passkeys under `apps/app/src/app/c/[slug]` | Nobody outside tests has signed in as a clinic | DONE-UNVERIFIED | A full synthetic clinic run in production |
| **Checkout, billing, Stripe** | Checkout, agreement signing, Sheet records, provisioning on first paid invoice, overage, dunning | No live purchase | DONE-UNVERIFIED | `stripe:setup` never run with a live key (`docs/handover.md`); live webhook endpoint unknown; `STRIPE_PAYMENT_METHOD_CONFIGURATION` (your step); `STRIPE_CONNECT_CLIENT_ID` empty, so no clinic can connect a deposit gateway |
| **Booking (Google Calendar)** | Engine, 60-second holds, idempotent writes, manual mode, closures; wired into calls and web chat (`lib/assistant/booking-tools.ts`) | No | DONE-UNVERIFIED, switched off | Direct booking is offered only when the switch, counsel's addendum and a live calendar all allow; until then every channel takes requests for staff. Google OAuth verification not submitted (consent screenshot "not yet") |
| **Deposits** | Stripe Checkout on the clinic's connected account, web chat sends after a booking | No | DONE-UNVERIFIED, off | Depends on direct booking and on Stripe Connect; nothing on Meta |
| **Support system** | Portal support chat, cases, drafter, approval inbox, inbound mail on SES (applied, subscribed), Slack approvals (deployed, off) | `/api/webhooks/inbound-mail` answers as configured; no case seen end to end | DONE-UNVERIFIED | Your mailbox forwarding, the Slack app and its five parameters (still `__unset__`), the `support-*` jobs switched on |
| **Ops console (`/admin` on Vercel)** | Clinics, Jobs, Inbox and Approvals, Compliance, Incidents, Rights, Recordings, Map, SEO | Deployed; Claude cannot sign in to check | DONE-UNVERIFIED | Nobody has opened the newest screens since Phases 6 and 7 |
| **Alerts to clinics** | Urgent alert queued with the urgent screen's writes, sent after commit; "I've told the team" depends on the sender being ready (`lib/notices/urgent-readiness.ts`) | No | DONE-UNVERIFIED | `billing-notices` job and `RESEND_API_KEY` (yours) |

Every scheduled job ships **off** (`drizzle/0007`: `enabled DEFAULT false`). Which are on in
production is **unknown** from here; read System › Jobs.

---

## 3. The BAA chain

| Link | Owner-reported | Evidence in the repo | Status |
| --- | --- | --- | --- |
| Clinic to healdesk (BAA at checkout) | — | BAA **1.5.1** is `BAA_TEMPLATES[0]`; 1.6.0 drafted, `approvedByCounsel: false` (`packages/catalog/src/baa.ts`) | BLOCKED-ON-OWNER (release 1.6.0) |
| Data protection agreement (vets, "No" practices) | Released 20 Oct | `dpa/1.0.0` live; migration 0104 applied (the 22 Oct migration-state query read 112 applied) | DONE-UNVERIFIED (register item still says "deploy"; it is stale) |
| healdesk to AWS | Accepted 22 Sep | `docs/policies/aws-hipaa-account.md`; Artifact screenshot "still to file" | DONE (filing open) |
| healdesk to database host (RDS under AWS's BAA) | Coverage confirmed | RDS in `infra/aws/rds.tf`, applied 14 Oct | DONE-UNVERIFIED as an attestation |
| healdesk to Anthropic | Signed | None in the repo; the key in AWS is not confirmed to be the HIPAA organisation's | BLOCKED-ON-OWNER (confirm the key) |
| healdesk to Retell | Signed | None in the repo; the three live marketing demo agents store transcripts 30 days, against the Privacy page | BLOCKED-ON-OWNER |
| Attestations on `/admin/compliance` | — | Go-live reads `anthropic`, `database_host`, `aws`, `launch_promises`, and for voice `retell`, `runtime_voice`, `voice_pass_through` (`lib/compliance/subjects.ts`) | **Unknown** (in the database) |
| Meta | Never signs | Scoped: nothing clinical stored or echoed, clinical screen at the boundary | DONE-UNVERIFIED |
| Stripe | Never signs | Amount, "Appointment deposit", opaque reference; treatment names refused (`deposit-link.ts`) | DONE-UNVERIFIED |
| Slack (new, 26 Oct) | No BAA, your decision | Carries only the drafted support reply | Disclosure gap (section 5) |

**Stale documents disagree with the above:** the spec's chain table, `docs/hipaa-compliance.md`
(database "Not chosen", Retell and Anthropic "Pending", calendar "not built yet", PostHog
"consent-gated" though analytics became opt-out on 23 Oct, no Slack row) and `docs/handover.md`
(RDS "not yet applied") all predate your reports.

---

## 4. Launch-register items that block go-live (`apps/web/src/lib/admin/seo/launch.ts`)

| Item | Register status | Checked in the code | Status |
| --- | --- | --- | --- |
| `direct-booking` | building | Engine is wired into calls and web chat. Left: the addendum, and a way to set the switch, which Terraform currently refuses | BLOCKED-ON-OWNER |
| `deposit-link-chat` | building | Built in web chat after a booking; needs direct booking and Stripe Connect | BLOCKED-ON-OWNER |
| `deposit-link-meta` | building | **Not built**: the front door sends no link; Terms § 2 says "it sends no payment link there" | NOT STARTED |
| `alert-sender-on` | owner | Code done; needs the job and the key | BLOCKED-ON-OWNER |
| `never-say-meta` | owner | Built and deployed; `qa:meta` passed once live (22 Oct). Could move to On with your word | DONE-UNVERIFIED |
| `failure-direct-line` | owner | Built; needs the Retell fallback sync with the key, outage mode confirmed, one test call | BLOCKED-ON-OWNER |
| `no-audio` | building | Agent-writing code exists but runs only from automatic provisioning, which is off; deletion backstop and alert built; no test call has proved the deletion | DONE-UNVERIFIED |
| `forwarding-codes` | owner | Codes pinned by tests; a test call per carrier still needed | BLOCKED-ON-OWNER |
| `voice-service` | owner | `enable_voice` is on and applied; left: a clinic-side test call, then `voice_real_calls` after the chain | BLOCKED-ON-OWNER |
| `baa-chain` | owner | See section 3 | BLOCKED-ON-OWNER |
| `daily-summary` | owner | Built; jobs off | BLOCKED-ON-OWNER |
| `baa-1-6-0-retention` | owner | 1.5.1 still offered | BLOCKED-ON-OWNER |
| `direct-booking-addendum` | owner | `approvedByCounsel: false` | BLOCKED-ON-OWNER |

`urgent-alert` is `on`, which is true only while the sender is on. Not blocking: `web-chat-on-paste`,
`data-protection-agreement` (stale, see section 3), `extra-locations`, `location-phone`,
`location-calendar`, `phone-flips-live`.

**Your attestation of `launch_promises`:** `AGENTS.md` says you attested it earlier and must
withdraw it, because `deposit-link-meta` was added on 26 Oct after it. Whether it is withdrawn is
**unknown** (database).

---

## 5. Legal and counsel

All legal documents were adopted on your own review, without a lawyer (`docs/counsel/README.md`).
Legal pages carry an AI review, not a lawyer's.

| Item | What the code or docs say | Status |
| --- | --- | --- |
| BAA 1.6.0 (the model provider's retention) | Drafted, not released; Terms § 9 waits on it | BLOCKED-ON-OWNER |
| Direct-booking addendum | Drafted, not approved | BLOCKED-ON-OWNER |
| State disclosure (`docs/counsel/state-disclosure.md`) | AI notice and transcription line on every call; open: Washington and Connecticut "recorded announcement" with no audio kept; Texas TRAIGA and Utah written notice (Utah "before the written exchange" on WhatsApp); Massachusetts, New Hampshire, Utah ch. 77 texts not read on the official sites; the latest opener wording not reviewed | BLOCKED-ON-OWNER (counsel) |
| Security Official named | Still a placeholder | BLOCKED-ON-OWNER |
| Policies read and signed off | "Drafted, not yet read and signed off" (`docs/policies/training-log.md`) | BLOCKED-ON-OWNER |
| Privacy: clinic support email | Privacy says nothing about clinics' emails to support being read by the AI to draft a reply, nor that the draft goes to Slack | NOT STARTED (wording proposed on 26 Oct, awaiting you) |
| Terms: what the model receives | Terms say it receives "the content of each conversation"; not a clinic's support email | NOT STARTED (same proposal) |
| `support@` printed in copy | Mail is received at support@, but the site prints only hello@; your call | BLOCKED-ON-OWNER |
| Terms vs the demo on Meta deposit links | Terms: "sends no payment link there"; the demo says AYA is designed to. Copy-first rule allows the demo's wording, but the Terms must change when the feature ships | NOT STARTED |
| Retell's live demo agents keep transcripts 30 days | Conflicts with the Privacy page and with "demos keep nothing" | BLOCKED-ON-OWNER |
| Spanish lines | Native-speaker and counsel review not done | BLOCKED-ON-OWNER |
| Claims ("never HIPAA compliant", no revenue claims, no opening dates) | Copy guard tests in `apps/web`; spot check found no violation | DONE-VERIFIED in tests |
| Meta policy (Developer Policies § 5.6.5 on healthcare conversations) | Counsel brief's top-ranked risk; no lawyer engaged | BLOCKED-ON-OWNER |
| UAE entity questions (enforcement, service, licence scope) | Open risk 5 in `brief.md` | BLOCKED-ON-OWNER |
| "Healthcare attorney review" | First box in `hipaa-compliance.md`'s pre-launch list, unticked | BLOCKED-ON-OWNER |

---

## 6. Security

| Item | Finding | Status |
| --- | --- | --- |
| Approval passcode (accepted by you, 26 Oct) | One static 6-digit code for every approval and agreement answer, in `/admin` and in Slack. The five-try lockout lives in each process's memory, so every cold Vercel instance, every redeploy and every AWS web task starts a fresh count, and the console and Slack count apart. Six digits is a million guesses: anyone who obtains the scrypt hash (Vercel variable or Parameter Store) can recover the code offline. It guards money and agreement answers | Accepted risk; recommend a longer code or a shared lockout before clinics depend on approvals |
| Operator console | Password and TOTP checked on Vercel; the Vercel account is "the real door" (`access-control.md`) | DONE-UNVERIFIED |
| Dependency audit | Green on `main`; one exception, `GHSA-c475-qrg2-pj4r` (basic-ftp via the undeployed `packages/leadgen`), **expires 20 Dec 2026** | DONE-VERIFIED |
| SEC-01 (CI checks), SEC-02 (upgrades), SEC-03 (audit red) | Merged; secret scan, CodeQL and audit green on `d6f76734` | DONE-VERIFIED |
| Independent security assessment / pentest | Brief written (`docs/design/independent-security-assessment-brief-2026-10-22.md`); not engaged | BLOCKED-ON-OWNER |
| WAF | Off by your choice (cost) | Accepted risk |
| Single operator | No separation of duties (risk analysis) | Accepted risk |

---

## 7. Infrastructure

| Item | Finding | Status |
| --- | --- | --- |
| Host | Active since 14 Oct (`host.yml`); last deploy 27 Oct 07:41 UTC, success; `/api/health` ok | DONE-VERIFIED |
| `enable_voice` | `true` in `production.tfvars`, applied | DONE-VERIFIED |
| `voice_real_calls` | `false`; only the demo clinic is answered | Correctly off; yours to switch |
| `voice_provision_enabled` | `false`; agents and numbers by hand | Correctly off; yours to switch |
| `HEALDESK_DIRECT_BOOKING_ENABLED` | Refused by Terraform on every task | No route exists to set it |
| Voice redundancy | `voice_desired = 1`; the comment above it says 2 survives a lost task. One task down drops every call on it | Your choice; recommend 2 before real calls |
| Database | `db.t4g.micro`, single-AZ, 35-day backups, deletion protection, encrypted | DONE |
| Restore drill | **Never run** (risk analysis T9); restoring into production "not designed in full or rehearsed" (`infra/aws/README.md`) | NOT STARTED |
| Alarms | 11 CloudWatch alarms to `alarm_email` via SNS; Slack ops alerts; confirmation of the SNS email is yours | DONE-UNVERIFIED |
| Worker heartbeat | Hourly tick; ages up to an hour are normal (932 s seen) | DONE-VERIFIED |
| Inbound mail | Applied, subscribed, endpoint answers | DONE-UNVERIFIED |
| Slack approvals | Deployed, off (five parameters `__unset__`) | BLOCKED-ON-OWNER |

---

## 8. What only you can do

**Secrets and settings**
- [ ] Confirm `RESEND_API_KEY` in Parameter Store; confirm the Anthropic key is the HIPAA organisation's.
- [ ] Switch on `billing-notices`, `daily-summary`, `weekly-recap` (and later `support-draft`, `support-send`, `support-inbound-sweep`) in System › Jobs; set alert recipients.
- [ ] Stripe: run `stripe:setup` with the live key; create the live webhook endpoint; create the payment method configuration and set `STRIPE_PAYMENT_METHOD_CONFIGURATION`; set up Stripe Connect and give `stripe_connect_client_id`.
- [ ] Slack app: create it, paste the bot token, signing secret, channel id, operator ids and the passcode hash.
- [ ] Gmail (or your mailbox): forward support@ and hello@ to in.healdesk.io.
- [ ] Confirm the SNS alarm email subscription.
- [ ] `RETELL_DEMO_ENGINE_AGENT_ID` on Vercel, if not done.

**Agreements and legal**
- [ ] Release BAA 1.6.0 or send it to counsel; approve or drop the direct-booking addendum.
- [ ] Fill in the Security Official's name; read and sign off the policies in the training log; file the AWS Artifact screenshot.
- [ ] Record the Anthropic, database-host, AWS (and later Retell) attestations with evidence on `/admin/compliance`; withdraw the `launch_promises` attestation if it is still recorded.
- [ ] Decide on a healthcare attorney (state disclosure, Meta policy, UAE entity, BAA text).
- [ ] Approve the Privacy and Terms wording for support email and Slack; decide whether `support@` is printed.
- [ ] Decide the Retell demo agents' 30-day transcript storage.

**Decisions**
- [ ] Launch with direct booking and deposits, or take those promises out of the copy for now.
- [ ] If direct booking: how its switch may be set (today nothing can set it).
- [ ] Whether the register blocks per channel (for a web-chat-only first clinic), or stays platform-wide.
- [ ] `voice_desired = 2`, Multi-AZ, WAF before real patients.
- [ ] Whether to harden the approval passcode.

**Accounts and approvals**
- [ ] Meta App Review submission; WhatsApp Tech Provider access verification, then the WhatsApp login configuration id; WhatsApp payment method for each clinic's account.
- [ ] Google OAuth verification (the consent-screen screenshot is still to take).
- [ ] Retell: the workspace key that holds the product agents; confirm outage mode; numbers for the first clinic.
- [ ] Independent security assessment.

**Tests that need you (calls, money, real accounts)**
- [ ] Restore drill in CloudShell (run sheet ready).
- [ ] A clinic-side test call on the demo clinic; a no-audio deletion check; a failure test (AYA off reaches the direct line); a forwarded call per carrier.
- [ ] A live `qa:meta` run with the HIPAA key (it spends model credit).
- [ ] One real purchase on your own test clinic, through provisioning, sign-in, wizard and a first answer.
- [ ] Then, after every agreement: `voice_real_calls = true`, and the final launch attestation.

---

## 9. Risks

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| Meta may refuse or later revoke the product on Messenger and Instagram | Developer Policies § 5.6.5 forbids healthcare-provider conversations there; it is the counsel brief's first risk | Launch web chat first; take legal advice before selling Meta |
| Legal text never reviewed by a lawyer | A defect in the BAA makes both healdesk and the clinic non-compliant | Counsel review of BAA 1.6.0, the DPA and the state-disclosure lines before the first signature |
| Copy promises features that are off | Direct booking and deposits are on the homepage, pricing and terms | Ship them or withdraw the copy before taking money |
| No restore ever proved | Recovery time unknown | Run the drill before go-live |
| Single voice task, single-AZ database, no WAF | One failure drops calls; calls then rely on Retell's fallback to the clinic's line | `voice_desired = 2`; test the fallback |
| Static 6-digit approval passcode | Weak guard on money and agreement decisions | Longer code or shared lockout |
| Stale handoff and compliance docs | The next session or an auditor reads wrong facts (examples: `AGENTS.md`'s snapshot says VOICE-T20 is unmerged, it is merged and deployed; `hipaa-compliance.md` says the database is not chosen) | Remaining-work lane REG |
| Heavy owner dependency | Most blockers are yours, not code | Work through section 8 in the order of section 1 |
