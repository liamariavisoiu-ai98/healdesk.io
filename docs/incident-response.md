# Incident response and the breach clocks

**Owner:** the Security Official ([policies/security-official.md](./policies/security-official.md)).
**Where the clock lives:** the `incidents` table, opened from the ops console; the
deadline is computed at open and the console lists what is overdue.

## What is what

| Class | Definition | Clinic must be told by | Source |
| --- | --- | --- | --- |
| Security incident | Attempted or successful unauthorised access, use, disclosure, modification or destruction of information, or interference with operations — whether or not PHI was involved (e.g. a credential leak, a suspicious login, a bug that exposed one clinic's rows to another), including anything a state breach-notification law treats as a breach of the security of the data | **24 hours** from becoming aware (immediately following it); the BAA's outer limit is 60 calendar days | BAA clause "Reporting breaches and security incidents" (c) |
| Improper use or disclosure | PHI used or disclosed in a way the BAA does not permit, by us or a subprocessor (e.g. a report that carried a patient name; the agent reading appointment details to the wrong caller) | **24 hours** from becoming aware (immediately following it); the BAA's outer limit is 60 calendar days | BAA (a) |
| Breach | Acquisition, access, use or disclosure of **unsecured** PHI not permitted by the Privacy Rule that compromises its security or privacy, per 45 CFR 164.402, after the four-factor risk assessment | **24 hours** from discovery (immediately following it) — far inside the 60 calendar days the BAA and 164.410 allow, on purpose, so the clinic's own 60-day clock to notify patients is not eaten by ours | BAA (b) |
| Service complaint | "Your AI mishandled a call yesterday." Not a BAA clock; a service promise | First reply within 2 business days | Terms of service |

BAA 1.2.1 allowed five business days for (a) and (c) and five calendar days
for (b). Since BAA 1.2.2 (owner, 9 October 2026), and in the 1.3.0 and DPA
drafts, the agreement promises all three "without unreasonable delay and in no
case later than 60 calendar days" after discovery, the product spec's wording,
and the public pages say the same. That is the outer limit, not the target.
Notify every clinic within 24 hours of discovery, whichever version it signed:
that meets every version, keeps a covered clinic's own 60-day clock to notify
patients clear of ours, and is what still meets the state laws that require
notice immediately following discovery (Cal. Civ. Code 1798.82(b)), now that
the agreement no longer says so. Since 7 October 2026 the console's
`notify_by` is discovery plus 24 hours for all three classes at every clinic.
An incident opened before then keeps the five-day deadline it was opened with:
work to 24 hours from discovery for it too, not to the console.

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
general. The console's `ftc_notify_by` column is kept as a second clock, 30
days from discovery: California's deadline for the clinic, as the owner of
the data, to notify the people affected (Cal. Civ. Code 1798.82(a)(2)(A); the
column held 60 days until 3 October 2026), so a non-covered breach is never
left with only the contractual deadline. The 24-hour BAA clock applies to them
as to every clinic.

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
   conversation id if there is one). Two deadlines appear on the row: the
   one the clinic's agreement promises (60 calendar days under BAA 1.2.2 on
   and the DPA), and our internal 24-hour target, which is never quoted to a
   clinic as a promise.
3. **Preserve.** Do not delete the webhook payload, the transcript reference or
   the audit rows involved (no call audio is kept, so there is no recording).
   The retention purge skips nothing on its own; if the evidence is inside its
   window, note the ids in the incident and, if needed, extend the clinic's
   retention window for the period.
4. **Investigate** from the audit log first: it records every read and write of
   PHI with actor and ids. `exportPatient()` produces the accounting of
   disclosures for one person; `security_events` holds the identity-plane
   trail (who signed in, from where).
5. **Notify the clinic** immediately, and within 24 hours of discovery at the
   latest, using the template below: by email to the notice address in its
   agreement, and also by phone. The notice address is the clinic's one
   address: the email on its healdesk account (the signatory's, before the
   account existed), or any address the clinic has since given us in writing
   for notices; a shared inbox is fine. Say what happened, with the date of
   the breach and the date we discovered it; what information was involved;
   what we did; what the affected patients should do to protect themselves;
   what we recommend the clinic do; and a contact. With every breach report,
   identify each affected patient in a list sent by secure transfer, never in
   the email. The secure transfer is the incident's page in the clinic's
   portal (`/c/<slug>/incidents/<id>`, since 19 October 2026): record the
   list from the app's own shell, by contact id only, with
   `npm run ops:incident-affected -w @healdesk/app` (on the AWS host, its
   one-off task through run-task.sh), and the practice reads each person's
   record id and the contact details we hold behind its passkey step-up, once
   the report has gone, with an access row naming every one shown. The list
   goes with each contact's own deletion. Record `notified_at` and how, and
   add to the report as we learn more.

   The written report is sent from the console's **Incidents** page
   (/admin/incidents, since 14 October 2026): **Send report** emails the
   clinic's address an L29 report built from fixed fields only (what
   happened, from a fixed list; the dates of the event and of its discovery;
   each type of information with a count; what we did; what the affected
   patients can do to protect themselves and what we recommend the clinic do,
   each picked from a fixed list; and the reply address as the contact),
   records `notified_at`, and can be sent again as an update. The patients'
   steps and our recommendations are in the written report because the BAA's
   Reporting clause asks a breach report for the steps and its Notices clause
   makes the written notice the notice; the phone call repeats them, it does
   not replace them. A breach's report sent with no steps yet says they will
   follow in an update, which must then carry them. The email never names
   anyone and states no deadline. A breach's report links to the incident's
   page, where the patients' list is read as above. The incidents page counts
   how many people each list names as recorded, never who; the count stays
   when one of them is later erased. If the incident owes the clinic no report (a
   routine unsuccessful attempt the agreement already reports once, say),
   record that with **Not reportable** and the reason instead. Nothing
   reaches a clinic unless it is sent from that page.

   If a law enforcement official says a notice would impede a criminal
   investigation or damage national security, delay it as 45 CFR 164.412
   says: for the period a written statement specifies, or, on an oral
   statement, record it with the official's identity and delay no more than
   30 days unless a written statement follows. Then notify at once, and say
   in the report that notice was delayed: tick **Notice delayed** in the
   breach's report on `/admin/incidents`, with the day the delay ended, and
   the report says a law enforcement official required it, as the BAA's
   Reporting clause asks.
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

Send from the Security Official's address, by email to the clinic's notice
address (step 5) and confirmed by phone. Fill every field from the incident
row; leave nothing as a guess.

> Subject: healdesk security notice for {clinic name}, reference {incident id}
>
> On {date and time discovered}, we discovered that {one plain sentence: what
> happened}. It happened on {date or dates of the breach, or "a date we have
> not yet established"}. It affected {number} of your patients' records, held
> by healdesk for {the channel or function involved}. The information involved
> was {categories only: e.g. names and phone numbers, the service asked about,
> conversation transcripts}. {If a vendor was involved: the event occurred at
> {vendor}, which notified us on {date}.} {If delayed: a law enforcement
> official asked us to delay this notice until {date}.}
>
> What we have done: {containment and remediation, in order}.
>
> What your patients can do to protect themselves: {steps, or "nothing
> further, because {reason}"}.
>
> What we recommend you do: {steps for the clinic}.
>
> Who was affected: the list identifying each affected patient is at {secure
> location}, available to you today. It is never sent by email. We will add
> to it, and to this notice, as we learn more.
>
> Your contact for this notice is {Security Official's name}, {email},
> {phone}. We will update you by {date} or sooner if we learn more.

## Patient rights requests

The BAA promises the clinic what it needs to answer a patient's access,
amendment or accounting-of-disclosures request within ten business days, and
that a request a person makes to healdesk itself (by email or letter, not
through the clinic's assistant) is passed to the clinic within five business
days: record it with `npm run ops:patient-request -w @healdesk/app`, which tells
the clinic through its portal and keeps the five-day clock (docs/handover.md, "A
request a patient makes to us"). A person on our team replies to that request,
saying we cannot act on it ourselves and have passed it to the clinic. That reply
is the only message we send, and nothing about it is automated. The clinic validates the request; we
produce the bundle.

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
4. For an amendment, run the scripts in the app's own shell, never the
   care page (`docs/handover.md`, "Amendments" and "Reaching the app's
   shell"). Where the record can change (a contact's name, number or
   address), `npm run ops:amend-contact -w @healdesk/app` corrects it in
   place; the audit row records which fields changed, not what they said.
   Where a record must stay as it was made (a booking request's times and
   service are frozen from creation, and its collected fields once it is
   decided; a conversation's record of what was said; an appointment as the
   calendar holds it), `npm run ops:amend-record -w @healdesk/app` appends
   the practice's words beside it and links the two, so every later export
   carries it (BAA 1.3.0 clause 14(b), 45 CFR 164.526(c)(1)). Both read the
   patient's details from a prompt, never the command line. Name the record
   by the id in the patient's export, and keep the incident's summary in
   ids, as always.
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

Time each step above against the 24-hour clock. The run is recorded in
[policies/training-log.md](./policies/training-log.md) under "Reviews".
