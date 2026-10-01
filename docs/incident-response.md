# Incident response and the breach clocks

**Owner:** the Security Official ([policies/security-official.md](./policies/security-official.md)).
**Where the clock lives:** the `incidents` table, opened from the ops console; the
deadline is computed at open and the console lists what is overdue.

## What is what

| Class | Definition | Clinic must be told by | Source |
| --- | --- | --- | --- |
| Security incident | Attempted or successful unauthorised access, use, disclosure, modification or destruction of information, or interference with operations — whether or not PHI was involved (e.g. a credential leak, a suspicious login, a bug that exposed one clinic's rows to another) | 5 **business** days from becoming aware | BAA clause "Reporting breaches and security incidents" (c) |
| Improper use or disclosure | PHI used or disclosed in a way the BAA does not permit, by us or a subprocessor (e.g. a report that carried a patient name; the agent reading appointment details to the wrong caller) | 5 **business** days | BAA (a) |
| Breach | Acquisition, access, use or disclosure of **unsecured** PHI not permitted by the Privacy Rule that compromises its security or privacy, per 45 CFR 164.402, after the four-factor risk assessment | 5 **calendar** days from discovery — well inside the 60 days 164.410 allows, on purpose, so the clinic's own 60-day clock to notify patients is not eaten by ours | BAA (b) |
| Service complaint | "Your AI mishandled a call yesterday." Not a BAA clock; a service promise | First reply within 2 business days | Terms of service |

A service complaint becomes one of the first three the moment the investigation
finds PHI went somewhere it should not have. Reclassify by opening a new incident
of the right class with the original's id in the summary; do not edit the class
on the old row.

**Non-covered clinics** (cash-pay practices that answered "no" to the
covered-entity question) are outside HIPAA. The FTC Health Breach Notification
Rule does not reach them either: 16 CFR 318.2 covers vendors of personal
health records and their service providers, and a clinic's booking records
are neither (corrected 1 October 2026; the earlier text here said the Rule
applied). What does apply is the breach-notification law of the state where
the affected people live, which in most states requires notice to individuals
without unreasonable delay and, above a threshold, to the state attorney
general. The console's `ftc_notify_by` column is kept as a conservative
second clock, 60 days from discovery, so a non-covered breach is never left
with only the contractual deadline. The BAA clock still applies — we promised
it contractually regardless of regime.

## Who decides

The Security Official classifies, within one business day of the report, using
the four-factor assessment for anything that might be a breach: the nature of the
PHI, who received it, whether it was actually viewed, and the extent of
mitigation. Write the assessment into the incident's summary in ids and
categories; never paste patient data into it.

## The procedure

1. **Contain.** Rotate the credential, disable the connection, pause the
   clinic's assistant, or revoke the session — whichever stops the thing
   continuing. Do this before anything else. Pausing is the portal's Pause AI
   switch (calls fall through to the clinic's own line, the website widget
   becomes a contact form, DMs wait for staff); until the portal exists, disable
   the clinic's agent at the voice vendor (Retell in v1) and turn off its Meta
   channels through the ops API (`setMetaFrontDoor`). A patient calling the
   clinic must still reach someone, so never contain by leaving the forwarded
   number dead.
2. **Open the incident** in the console (class, summary in ids, discovery time,
   conversation id if there is one). The deadline appears on the row.
3. **Preserve.** Do not delete the webhook payload, the transcript reference or
   the audit rows involved (no call audio is kept, so there is no recording).
   The retention purge skips nothing on its own; if the evidence is inside its
   window, note the ids in the incident and, if needed, extend the clinic's
   retention window for the period.
4. **Investigate** from the audit log first: it records every read and write of
   PHI with actor and ids. `exportPatient()` produces the accounting of
   disclosures for one person; `security_events` holds the identity-plane
   trail (who signed in, from where).
5. **Notify the clinic** by the deadline, using the template below, by email
   to the owner and manager contacts the clinic named in the wizard (until the
   wizard exists, the report recipients on the care page) and by phone to the
   owner. Never to the clinic's public inbox, which the assistant may itself be
   answering. Say what happened, which patients (by count, with ids in a secure
   attachment if they ask), what we did, what we recommend they do, and a
   contact. Record `notified_at` and how.
6. **Help the clinic notify** its patients and HHS if it decides it must. The
   cost of that notification is the clinic's, whoever caused the breach
   (terms §14, BAA Liability clause), and there is no insurance on our side to
   offer against it; help means people and information, not money.
7. **Resolve** with what changed so it cannot recur, and re-read
   [hipaa-risk-analysis.md](./hipaa-risk-analysis.md); a real incident almost
   always moves a row in its threat table.

## Notices from our vendors

A breach or security incident at a subcontractor is ours to pass on. Retell,
Anthropic and the database provider (AWS RDS or Neon) each owe us notice under
their BAA; AWS owes it under its addendum
([policies/aws-hipaa-account.md](./policies/aws-hipaa-account.md), "What AWS
commits to"). None of them can tell which of our clinics or patients were
affected; that mapping is ours, from `audit_log` and the conversation rows.

1. **Where they arrive.** Each vendor's notices go to the account contact
   address on file with that vendor. Every one of those addresses must reach
   the Security Official; check them when the agreement is signed and at each
   quarterly access review.
2. **The clock.** Our clinic BAA clock starts when the vendor's notice arrives,
   or when our own monitoring should have caught the event, whichever is
   earlier. A vendor notice is discovery for us; do not wait for the vendor's
   investigation to finish.
3. **What to do.** Open an incident of the class the notice describes, with the
   vendor's reference in the summary. Map the vendor's window and service to
   the clinics and conversations that used it in that window, by id. Then run
   the procedure above from step 4, and notify every affected clinic on its own
   deadline. A notice that turns out to affect no clinic is still logged and
   resolved with that finding.
4. **Meta and Stripe** sign no BAA. An incident at either is handled the same
   way, but what reached them should be non-clinical by design; if the
   investigation finds clinical content did reach them, that finding is itself
   an improper disclosure and is classed as one.

## Template clinic notice

Send from the Security Official's address, by email and confirmed by phone.
Fill every field from the incident row; leave nothing as a guess.

> Subject: healdesk security notice for {clinic name}, reference {incident id}
>
> On {date and time discovered}, we became aware of {one plain sentence: what
> happened}. It affected {number} of your patients' records, held by healdesk
> for {the channel or function involved}. The information involved was
> {categories only: e.g. names and phone numbers, the service asked about,
> conversation transcripts}. {If a vendor was involved: the event occurred at
> {vendor}, which notified us on {date}.}
>
> What we have done: {containment and remediation, in order}.
>
> What we recommend you do: {steps for the clinic}. If you decide your patients
> or HHS must be notified, we will give you the information you need for it,
> including the list of affected patients by secure transfer.
>
> Your contact for this notice is {Security Official's name}, {email},
> {phone}. We will update you by {date} or sooner if we learn more.

## Patient rights requests

The BAA promises the clinic what it needs to answer a patient's access,
amendment or accounting-of-disclosures request within ten business days, and
that a request made to us directly is forwarded to the clinic within five. The
clinic validates the request; we produce the bundle.

1. Log the request as a `service_complaint` incident on the care page so the
   two-day and ten-day clocks are visible, with the ticket reference in the
   summary and no patient details.
2. On the app host (or a laptop with `DATABASE_URL` pointed at production over
   the bastion), run
   `npm run patient-export -w @healdesk/app -- --clinic <id> --phone +1… --requested-by "practice manager, ticket 41"`
   (or `--email …`). It writes one JSON file, mode 0600, named by clinic and
   time, containing every row about that person and the audit rows that
   touched them — which is the accounting of disclosures. The export is itself
   recorded as an access.
3. Hand the file to the clinic's named contact over the channel the clinic
   uses for PHI (their patient portal upload, or an encrypted message);
   never as a plain email attachment and never through the ops console, which
   lives in the app that holds no PHI. Delete the local copy once receipt is
   confirmed.
4. For an amendment, correct the row with `amendContact()` (a script call or
   a one-line `tsx` invocation on the app host); the audit row records which
   fields changed, not what they said.
5. Resolve the incident with the date delivered.

The same script with `--all` produces the whole-clinic return bundle at
offboarding; see `docs/handover.md` → Retention and offboarding.

## The human response to a complaint

The monitored inbox is the privacy address in `apps/web/src/lib/legal.ts`. First
reply within two business days, from a person, saying what we are looking at and
when they will hear back. Pull the conversation by id and read the transcript in
Healdesk's own transcript view, which requires a second factor and logs the
open (until the portal exists, on the app host, audited the same way). Not in
email, and not in the vendor console: vendor-side retention is set to the
minimum, so it may already be gone there. Answer with what happened and what
changed. If the finding is that the agent behaved as designed and the caller
disliked it, say so plainly.

## Tabletop

Run this once before the first production clinic, and once a year:

> Scenario: the agent read back the next appointment time to a caller who gave
> the wrong name, and the caller was not the patient.

A second scenario, for the vendor path:

> Scenario: Retell notifies us that transcripts from one day were retained past
> the configured window and exposed to another customer's workspace.

Time each step above against the five-calendar-day clock. The run is recorded
in [policies/training-log.md](./policies/training-log.md) under "Reviews".
