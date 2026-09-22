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
covered-entity question) are outside HIPAA and inside the FTC Health Breach
Notification Rule: individuals within 60 days of discovery, the FTC within 10
business days if 500+ people are affected, and media where 500+ in a state. The
console adds `ftc_notify_by` to a breach at such a clinic. The BAA clock still
applies — we promised it contractually regardless of regime.

## Who decides

The Security Official classifies, within one business day of the report, using
the four-factor assessment for anything that might be a breach: the nature of the
PHI, who received it, whether it was actually viewed, and the extent of
mitigation. Write the assessment into the incident's summary in ids and
categories; never paste patient data into it.

## The procedure

1. **Contain.** Rotate the credential, disable the connection, switch the
   agent off in Synthflow, or revoke the session — whichever stops the thing
   continuing. Do this before anything else.
2. **Open the incident** in the console (class, summary in ids, discovery time,
   conversation id if there is one). The deadline appears on the row.
3. **Preserve.** Do not delete the webhook payload, the recording reference or
   the audit rows involved. The retention purge skips nothing on its own; if
   the evidence is inside its window, note the ids in the incident and, if
   needed, extend the clinic's retention window for the period.
4. **Investigate** from the audit log first: it records every read and write of
   PHI with actor and ids. `exportPatient()` produces the accounting of
   disclosures for one person; `security_events` holds the identity-plane
   trail (who signed in, from where).
5. **Notify the clinic** by the deadline, by email to the report recipients
   and by phone to the owner, with: what happened, which patients (by count,
   with ids in a secure attachment if they ask), what we did, what we
   recommend they do, and a contact. Record `notified_at` and how.
6. **Help the clinic notify** its patients and HHS if it decides it must. The
   cost of that notification is the clinic's, whoever caused the breach
   (terms §14, BAA Liability clause), and there is no insurance on our side to
   offer against it; help means people and information, not money.
7. **Resolve** with what changed so it cannot recur, and re-read
   [hipaa-risk-analysis.md](./hipaa-risk-analysis.md); a real incident almost
   always moves a row in its threat table.

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
offboarding; see `docs/handover.md` → Offboarding.

## The human response to a complaint

The monitored inbox is the privacy address in `apps/web/src/lib/legal.ts`. First
reply within two business days, from a person, saying what we are looking at and
when they will hear back. Pull the conversation by id, read the transcript in
the vendor console (not in email), and answer with what happened and what
changed. If the finding is that the agent behaved as designed and the caller
disliked it, say so plainly.

## Tabletop

Run this once before the first production clinic, and once a year:

> Scenario: the agent read back the next appointment time to a caller who gave
> the wrong name, and the caller was not the patient.

Time each step above against the five-calendar-day clock. The run is recorded
in [policies/training-log.md](./policies/training-log.md) under "Reviews".
