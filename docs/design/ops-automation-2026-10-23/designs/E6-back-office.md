> Design input, written 23 Oct 2026 by a read-only design agent from main at 2e258ae9. Not a decision: the plan in ../README.md decides what is built and in what order. Claims are from the code unless marked NOT VERIFIED; spot-checked by the session that commissioned it.

# E6: Gated back-office assistants (items 13 to 18)

Read at main 2e258ae9, read-only. The principle throughout: **the assistant gathers facts and drafts. The owner decides, and every decision is executed by the same typed ops operation the console already uses.** Money and legal steps are never automatic.

## 1. Current state (verified in code)

| Area | What exists | Where |
|---|---|---|
| Agreement review (13) | The misclassification signal: a DPA "No" practice whose site says it accepts insurance opens one `audit_review_queue` row (kind `agreement_kind`, internal `dueOn` = next reply-by day). Ops asks the practice and records its answer. A "Yes" or "Not sure" answer starts a DPA→BAA re-sign that **pauses AYA at every location** of the organisation. Ops: `listAgreementReviews`, `decideAgreementReview`, `searchAgreements`, `resendAgreementCopy`, `markAgreementTerminated`. | `apps/app/src/lib/agreements/misclassification.ts`, `resign-pause.ts`; `/admin/reviews`, `/admin/agreements` |
| BAA re-sign (14) | `startBaaVersionResigns` broadcast; L22 email plus automatic reminders at 3 and 7 days (`RESIGN_REMINDER_DAYS`); links last 14 days and every reminder carries a fresh one. Ops alert at 7 days: `agreement_unsigned_7_days`, or `agreement_below_floor_unsigned` ("phone the practice"). **A `baa_version` re-sign never pauses AYA** (`resignHoldsPause`; owner, 19 Oct). There is **no cross-clinic list of open re-signs**; the digest only counts below-floor accounts. | `lib/agreements/resign.ts`, `resign-pause.ts`, `lib/ops/digest.ts` |
| Billing (15) | Billing requests (`plan_start`, `step_up`, `close_setup`, `cancel_now`) are retried by the worker on their own, up to `MAX_BILLING_REQUEST_ATTEMPTS = 10` with back-off. After that the request is dead-lettered and raises `billing_request_dead_lettered`. A failed annual overage invoice raises `overage_invoice_failed` and is retried at 05 UTC. Manual ops: `retryBillingRequest`, `retryOverageInvoice`, `replayBillingEvent`, `previewRefund`, `commitRefund`, `liftSuspension`, `extendSetupDeadline`, `closeUnfinishedSetup`. Every write records an audit row (`auditRecorded`). | `lib/billing/requests.ts`, `support.ts`, `annual-overage.ts`; `getClinicBilling` |
| Patient rights (16) | **Patient → us:** `ops-patient-request.ts` (ids only). L32 goes to the practice, which is reminded on business days 2 and 4. Ops is alerted on day 4 (`patient_request_due_soon`) and after day 5 (`patient_request_past_due`); `PASS_ON_BUSINESS_DAYS = 5`. **Erasure:** `ops-erase-person.ts` sets a deadline of 10 business days (`ERASURE_DEADLINE_BUSINESS_DAYS`), with the Retell subcontractor step stamped through `markErasureVendorDeleted` and backups ageing out over 35 days. **Amendment:** the 10-business-day deadline is in handover.md only; **no due date is stored** (`amendments.ts`). **Export:** `patient-export.ts`. **Incident affected list:** `ops-incident-affected.ts`. On AWS everything runs by id through `run-task.sh`, and **nothing turns a number into a contact id**, so on the host an erasure or an amendment with words waits for the M5 portal. No portal route for this was found. The care page (`getClinicCare`) shows each clinic's own requests; **there is no cross-clinic tracker**. | `apps/app/scripts/ops-*.ts`, `lib/patient-rights/*`, `docs/handover.md` §Deletion requests / Amendments / A request a patient makes to us |
| Incidents (17) | Each row carries two clocks: `agreement_notify_by`, the promise (60 calendar days on BAA ≥1.2.2 and the DPA, 5 days on ≤1.2.1), and `notify_by`, the internal 24-hour target, which must never be quoted to a clinic. A non-covered-entity breach also gets `ftc_notify_by` at 30 days. The hourly `incident-deadlines` job sends the alert. L29 is built from fixed codes. Ops: `openIncident`, `markIncidentNotified`, `markIncidentNotReportable`, `sendIncidentReport`, `resolveIncident`, `listIncidentRegister`. The procedure is in `docs/incident-response.md` (contain → open → preserve → investigate → notify + phone → help → resolve). **Mapping a vendor's incident window to clinics is a manual step today.** | `lib/incidents/*`, `lib/scheduler/incident-deadlines.ts`, `/admin/incidents` |
| Compliance (18) | Platform attestations (anthropic, database_host, aws, retell, launch_promises, runtime_*, voice_pass_through) with `effectiveOn` and `expiresOn`, entered only with a fresh TOTP code. Withdrawing a vendor stops AYA where that vendor serves. **No weekly pack exists.** | `lib/compliance/platform.ts`, `apps/web/src/lib/admin/platform-compliance.ts`, `/admin/compliance` |
| Gate pattern | `checkFreshOperatorCode`: an operator session, then a fresh authenticator code, then the signed request. `security_events` is the operator's append-only trail. Ops alerts go by email through `notifyOps` (`ops_alerts` + outbox); Slack is not in apps/app. | `apps/web/src/lib/admin/fresh-code.ts`, `lib/ops/notify.ts` |

## 2. The approval inbox (shared, item 3)

**Data** goes in apps/app, because items name clinics and execute apps/app operations. Two tables:
- `ops_approvals`: id, `kind` from a closed list, `clinic_id` (nullable), `subject_ref` (an id), `payload` (validated per kind, ids and codes only), `draft` (subject and body for emails), `draft_hash`, `due_at`, `urgency` (`legal_clock` | `money` | `routine`), `proposed_by` (service name), `proposed_at`, `status` (`waiting` | `approved` | `rejected` | `expired` | `executed` | `failed`).
- `ops_approval_events`: **append-only**, with a trigger that refuses UPDATE and DELETE (the same pattern as `platform_compliance`). Each event records what happened (proposed, edited, approved, rejected, executed, failed), the operator's `actorLabel`, the IP address and user agent, the hash of the body as approved and as sent, and the outcome code. Each decision also writes one `security_events` row.

Both tables are classified in `readonly-tables.ts`: approvals are readable; events are readable, but not their `draft`.

**Ops operations:** `listApprovals` (read) and `decideApproval({id, action: approve|reject, editedDraft?, reasonCode, code?})` (write). Approving runs **the existing operation inside the same apps/app request** (`retryBillingRequest`, `commitRefund`, `sendIncidentReport`, the outbox enqueue for an email, and so on). There is one execution path, so the inbox can never do more than the console button does.

**Screen** `/admin/inbox`: a single list, ordered by deadline. Each row shows the clinic name and id, what is proposed, the clock, the packet (the facts) and the draft. It has three controls: **Approve**, **Edit** (drafts only; the edited text is linted by `lib/email/lint.ts` again, and both hashes are kept) and **Reject** (a reason code). Irrevocable kinds need a fresh TOTP code on Approve. Those kinds are: any email to a clinic, a refund, a billing retry, an overage invoice, cancel or close-setup, an incident report, not-reportable, an agreement decision, a re-sign broadcast, a setup extension and an attestation. Every proposal is shown with an "Executed by" line that names the operation. A history tab is read straight from `ops_approval_events`.

**Arrival:** an item with a legal clock raises `notifyOps` (email), plus the Slack bridge other designs add, carrying ids and a link to the row. A waiting item past its `due_at` re-alerts once. Items expire: an email draft after 14 days, a retry after 7 days. **Nothing is ever approved by timeout.**

E5's support drafts, item 8's extensions and item 3's notifications all use this one inbox through new `kind`s.

## 3. Per assistant

### 13. Agreement and BAA review packet
**Packet** (from `listAgreementReviews`, `searchAgreements`, `getClinicCare`, and the clinic's `site_profile.acceptsInsurance` with the URL that was read):
- the clinic, its agreement kind and version, and the signed date;
- the signatory (business contact);
- the covered-entity answer given at checkout;
- what the site says, and when it was read;
- any earlier review decisions;
- an open re-sign, if there is one;
- the review's internal due day;
- **the consequence of each answer**: "No" → the review passes and nothing changes. "Yes" or "Not sure" → a BAA re-sign opens and **AYA pauses at N locations until it is signed**.

**Draft** (to the clinic's one address, Resend, hello@):
> Subject: A quick question about your healdesk agreement
> Hi {clinic name} team, when you signed up you told us your practice doesn't bill insurance electronically, so you signed our Data Protection Agreement. Your website mentions accepting insurance. That can be fine (superbills, or being out of network). If your practice sends insurance claims or eligibility checks electronically, though, you need our business associate agreement instead. Could you reply with one word: Yes, No or Not sure? If it's Yes or Not sure, we'll send the business associate agreement to sign, and AYA pauses until it's signed. Thanks, the healdesk team

**Gate:** two steps. (a) Approve sending the question. (b) Once the practice has replied, the owner picks the answer they heard, which runs `decideAgreementReview`; the pause count is shown and a fresh code is required. **The assistant never** infers the answer from the website or from the reply text, and never decides.

### 14. BAA re-sign chase list
**New read op** `listOpenResigns`: resign id, clinic, reason, from version → to version, started, last L22 email sent (from the ledger), days open, the link's expiry, `belowFloor` and `fromVersionAcceptable`.
**Screen:** a section of `/admin/agreements`, ordered by below-floor first and then by days open.
**Draft** (proposed only after day 7, once the automatic L22 reminders are spent):
> Subject: Your updated business associate agreement is waiting
> Hi {clinic name} team, version {to} of our business associate agreement is ready for your signature. AYA keeps answering as normal under the version you signed ({from}). Nothing changes until you sign. Open, read and sign here: {fresh link}. If anything in it raises a question, just reply to this email.

The link is minted in apps/app from `BETTER_AUTH_URL` when the email is sent, never stored in the draft. Below-floor accounts also get a **phone checklist** (the published number from the clinic profile, and what to say), as the alert already asks.
**Never:** imply a pause, suspension or deadline (the "never pauses" rule), send more than one human chase per 7 days, or start a broadcast. `startBaaVersionResigns` stays an owner-only, fresh-code inbox item.

### 15. Billing retry triage
**Packet** for each dead-lettered request (from `getClinicBilling`):
- kind, reason, attempts out of 10, last error code, created;
- Stripe subscription status, whether a newer request supersedes it, and channels in service;
- **what a retry does in money**. For example, `plan_start` replaces the $0 line with the package price. `cancel_now` cancels the subscription, cannot be undone, and gets a red label.

Failed overage: the window, the amount as previewed, and the `hd_ref` that resumes the existing invoice. Refund: the `previewRefund` output in full.
**Gate:** each item is approved one at a time. Executing it calls the existing operation, and the outcome is written back to the item. No bulk approve for money.
**Draft:** only where no automatic notice exists. The `payment_failed` and dunning notices already go automatically.
**Never:** retry after dead-letter, refund, replay an event, lift a suspension or change a price on its own.

**OWNER DECISION:** you asked that every retry be "gated by my approval". Today the worker's 10 automatic retries and Stripe's dunning emails run without approval. I recommend keeping them: they are idempotent and part of the contract, and gating them would stall plan starts. Your approval would then apply from the dead-letter onward. The alternative is to gate the first attempt as well.

### 16. Patient-rights tracker
**New table** `rights_intakes` (apps/app). It holds only: clinic id, kind (`erasure` | `amendment` | `correction` | `export` | `patient_request`), `received_at`, `verified_via` (`notice_address` | `phone_confirmed` | `unverified`), `due_on`, status, and the linked record id (erasure id or request id). There are no person fields and no free text; the database rejects digits and @ in any text. It is recorded through the new write op `recordRightsIntake`, which can be done from apps/web because it is ids and dates only.

**Clocks:**
- erasure and amendment: 10 business days, from intake (the existing `addBusinessDays`);
- patient request: 5 business days;
- erasure backup expiry: 35 days.

**Screen:** `/admin/rights`, one cross-clinic list with overdue rows in red.
**Prepared commands:** each row shows the exact `bash infra/aws/scripts/run-task.sh <task> <clinic id> <contact id> <who asked> <operator>` with a copy button, ids only, for the owner to run in CloudShell. **The assistant never runs it.**
**Blocked state:** on AWS, an erasure or amendment without a contact id shows "Blocked: needs the M5 portal route" while the clock keeps running.

**OWNER DECISION:** before real patients, the M5 deletion and amendment route must exist, or the BAA's 10 business days cannot be met on the host. I recommend making it a launch-promise item that blocks go-live.

### 17. Incident runbook assistant
**Checklist** (from incident-response.md), ticked per incident, with each tick an event: contain, open, preserve the ids, investigate, notify by email **and** phone, affected list recorded (count), help the clinic, resolve.

**New read op** `incidentScope({vendor|channel, from, to})`. It returns the affected clinic ids, each with its conversation count and agreement version, so the owner can see both clocks per clinic. **Proposal:** one `openIncident` per clinic in the scope, as a single gated inbox item.

**Drafted report:** the L29 fields pre-filled from the incident class (event code, dates, mitigation codes). The owner edits them by choosing from the fixed lists only, because L29 has no free text. Sending runs `sendIncidentReport` with a fresh code.

**Clocks shown:** the internal 24-hour target, labelled "internal target"; the agreement deadline; and the 30-day owner-notice clock.

**Never:** send, mark not-reportable, close an incident, or type a person into anything.

**OWNER DECISION:** the 24-hour target depends on you being reachable. Name a backup approver, or accept that the target may slip while the agreement's deadline still holds. The inbox re-alerts every 4 hours while a legal-clock item waits.

### 18. Weekly compliance pack
Generated Monday 07:00 New York by a switched job in apps/app and stored as an immutable `compliance_packs` row (week, JSON, hash). The new read op `getCompliancePack(week)` serves it, and `/admin/compliance/pack/[week]` renders **one printable page**. It holds counts, ids and dates, never patient data.

| Section | Source |
|---|---|
| Agreements: signed this week by kind and version; re-signs open, signed or below floor; reviews open or decided | `searchAgreements`, `listOpenResigns`, `listAgreementReviews` |
| Vendor chain: each attestation's status and expiry in the next 30 days | `listPlatformCompliance` |
| Incidents: opened, reported and resolved; any target missed; any agreement deadline at risk | `listIncidentRegister` |
| Patient rights: received, on time, overdue, blocked | `rights_intakes`, erasure and patient-request rows |
| Data lifecycle: transcript deliveries (sent, deleted, over 30 days); retention purge and erasure-expiry runs | `transcriptDeliveries`, `scheduled_jobs` |
| Access: operator sign-ins, fresh-code uses, clinic device recoveries | `security_events` |
| Approvals: decided, and median time to decide | `ops_approval_events` |
| Launch promises still open | `LAUNCH_PROMISES` (apps/web) |

**Recipient:** the owner only. The email is a pointer plus the five headline numbers, sent by Resend to hello@. An auditor gets the printed page from the owner.

## 4. Guardrails

- apps/web stores nothing new. Every new table is in apps/app, migrated and classified.
- All clinic email goes through Resend from hello@, contains no patient data, and is linted.
- Nothing contacts a patient. The reply to a patient (handover step 4) stays a human email.
- No portal screen is added, and nothing here touches the clinic portal's must-never-grow list.
- Every new operation is added to `/admin/map` and to the closed operation list.

## 5. Build order

1. **S.** `ops_approvals` and `ops_approval_events`, with the immutability trigger and `readonly-tables` classification. Proved by a trigger test and a classification test.
2. **M.** `listApprovals` and `decideApproval`, plus `/admin/inbox`, with fresh-code kinds. Proved by an ops-client contract test and "approve executes the same op". Touches `ops/api.ts`, `ops-client.ts`, `admin/inbox/*`.
3. **S.** Billing triage kinds, reusing the existing ops. Proved by refund and retry tests.
4. **S.** `listOpenResigns` and the chase kind. Proved by tests that the draft never contains "pause" and that the link is minted at send.
5. **S.** The agreement packet and question kind.
6. **M.** `rights_intakes`, `recordRightsIntake` and `/admin/rights`, with the command builder. Proved by a test that the builder emits ids only and a business-day clock test.
7. **M.** `incidentScope`, the checklist and the pre-filled L29.
8. **M.** `compliance_packs` job and page. Proved by a snapshot test and a test that the pack holds no free text.

## 6. Open questions

1. Should the automatic billing retries and dunning stay ungated (§15)?
2. Who is the backup approver for incident clocks?
3. Should the M5 deletion route become a go-live blocker?
4. Should the pack go to anyone besides you?
5. Should the inbox ever allow more than one operator identity? Today's sign-in is a single shared operator, so "who approved" means "the operator account".
