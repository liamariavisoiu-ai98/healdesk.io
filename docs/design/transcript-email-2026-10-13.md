# Transcripts are emailed, not stored — 13 October 2026

**Decision (owner, 13 October 2026).** When a call or a web chat ends, its transcript is emailed
to the clinic's address and healdesk keeps no copy of it. The conversation row stays, without
the words: channel, times, outcome, the booking it produced, and when the "I'm an AI assistant,
this call is transcribed" line played.

The spec (`docs/v1-product-spec.md`), BAA 1.4.0 and the DPA say so since the same day; this file
records what was built and what followed.

**Decision (owner, 14 October 2026).** The sealed copy is deleted the moment delivery is
confirmed, not seven days after SES first accepts the email; if it is not delivered it is kept
and sent again until it is, but never past 30 days after it was queued; one SES accepted and
nobody answered for is deleted 72 hours after its last send; the row stays as a receipt without
the words; and there is no archive copy at all. BAA 1.5.0 and the DPA say so since that day
(`docs/counsel/agreement-changes.md` § 15).

## What is built

- `apps/app/src/lib/conversations/transcript-email.ts`. `renderTranscriptEmail()` builds the
  email: a fixed subject that names nobody, the conversation's time in the clinic's zone, each
  turn labelled (Assistant / Caller / Visitor), everything escaped in the HTML, cut with a note
  past 200,000 characters. `sendTranscriptEmail()` sends it classed `may-carry-phi`, never
  throws, and returns what the transport said. Calls and web chats only: the Meta channels are
  refused, because healdesk keeps no Meta message (BAA 1.3.0 clause 11) and an email would be a
  way of keeping one.
- **The outbox** (owner, 13 October 2026: "if a send fails, it still can recover the transcript
  or retry until it works"; 14 October 2026: deleted once delivered). `lib/conversations/transcript-outbox.ts`,
  `drizzle/0069` and `drizzle/0072`:
  - the conversation's own transaction queues the transcript, sealed under the KMS key with the
    clinic's lock label, in `transcript_emails` (forced row-level security, the BAA gate on
    insert, one row per conversation), and sends it straight after commit;
  - a failed send is tried again after 1, 2, 5, 10 and 30 minutes, then hourly; ops hears on
    the third failure (`transcript_undelivered`, ids and SES's reason only);
  - SES's events reach `/api/webhooks/ses` through a signed SNS topic (`infra/aws/ses.tf`). A
    Delivery for the message id the row records deletes the copy in the same transaction:
    `sealed` NULL, status `delivered`, `delivered_at` from the database's clock. A hard bounce,
    rejection, complaint or rendering failure marks the transcript bounced, sent again an hour
    later, and ops hears once. A transient bounce or a delay is not an answer;
  - the database holds the clocks (0072): `destroy_after` is `created_at` plus 30 days, set by
    trigger and never moved; `sent_at` is the database's time of each accepted send. The
    `transcript-emails` job, every minute from the `billing-minute` queue with the hourly tick as
    its backstop, deletes every copy still held past its 30 days (status `expired`, ops told by
    ids) and every sent copy with no answer 72 hours after `sent_at` (status `unconfirmed`, ops
    told once), whatever its switch, which governs sending only. Nothing past its cap is sent
    again;
  - a CHECK holds `sealed` NULL exactly when the status is `delivered`, `expired` or
    `unconfirmed`, and the trigger lets a copy change only while an open chat stays open or to
    NULL as its row becomes a receipt, never back; a receipt never changes;
  - the receipt (conversation, attempts, `sent_at`, `delivered_at`, SES's message id, status,
    SES's scrubbed reason) says whether each transcript reached the clinic. The read-only ops
    operation `transcriptDeliveries` returns counts by status and the newest 50 receipts over
    `sinceDays` (default 30), never words or an address; apps/web's ops client does not call it
    yet;
  - `resendTranscript` sends it again while a copy exists (pending, bounced, or sent awaiting
    SES's answer), and answers `gone` for a receipt;
  - the row, copy or receipt, goes with its conversation (foreign key) and with the clinic's
    destruction (`destroyClinicData`, `app_mark_clinic_destroyed`).
- **No archive copy** (owner, 14 October 2026). The blind copy to one mailbox that 13 October
  built, and kept off, is removed: no `bcc` option, no `DeliveryTarget.bcc`, no BccAddresses on
  the SES send, and `HEALDESK_TRANSCRIPT_ARCHIVE_TO` and `HEALDESK_TRANSCRIPT_ARCHIVE_BAA` are
  read nowhere. The Terraform variables that set them (`transcript_archive_to`,
  `transcript_archive_baa_signed`) are removed from `infra/aws` separately.
- `getTransport()` (`lib/reporting/deliver.ts`) sends the `may-carry-phi` class through SES
  whenever SES is set up for it (`HEALDESK_SES_CONFIGURATION_SET`), while every other email stays
  on Resend. SES refuses to send unless the configuration set's
  `TlsPolicy` is `REQUIRE`, so a receiving server that will not negotiate TLS gets nothing.
- `infra/aws`: `enable_ses = true` (the configuration set, the domain identity and its DKIM
  records, the task role's send rights, the events topic and its subscription). The transcript
  bucket stays off and is superseded.
- The old Synthflow call ingest no longer stores the vendor's transcript link
  (`conversations.transcript_uri` is written as null).
- Tests: `apps/app/tests/transcript-email.test.ts`, `transcript-outbox.test.ts` (database),
  `ses-events.test.ts`, routing cases in `tests/resend-routing.test.ts`, and the Terraform runs.

## What is not built

- **The SES sandbox.** The account has to be taken out of it (infra/aws/README.md, First run)
  before a transcript can reach a clinic.

## What changed to match (13 October 2026)

| Where | Now |
| --- | --- |
| Spec doc | Edited and re-exported (`docs/v1-product-spec.md`): the voice section, the Conversations screen, the support chat, "What data actually moves", the retention list and the access log say the transcript is emailed and not kept |
| BAA | 1.4.0 released as the current version, replacing 1.3.0 outright (`drizzle/0070`, `docs/baa-v1.4.0.txt`, counsel log §14): clauses 4, 11 and 14. 1.3.0's text and hashes are untouched |
| DPA 1.0.0 | Edited in place, still unreleased: clauses 5, 10 and 13, goldens regenerated |
| Portal Settings | "Keep transcripts for" removed; the column stays because the purge reads it, and an old value only deletes sooner |
| Website | Terms, Privacy and data deletion pages, the homepage FAQ, the demo brief and the vendor register (`LEGAL_VERSION` 2026-10-13.3) |
| `docs/hipaa-risk-analysis.md`, `docs/hipaa-compliance.md` | The transcripts rows |
| The outbox's deletion | Runs whatever the `transcript-emails` switch says, since the agreement promises it |

## What changed to match (14 October 2026)

| Where | Now |
| --- | --- |
| Outbox | `drizzle/0072`: the copy deleted with SES's Delivery event, 30 days from queueing at most, 72 hours after a send nothing answered; the receipt; `transcriptDeliveries`; the archive copy removed |
| BAA | 1.5.0 released as the current version, replacing 1.4.0 outright (`drizzle/0073`, `docs/baa-v1.5.0.txt`, counsel log § 15): clauses 11 and 14. 1.4.0's text and hashes are untouched |
| DPA 1.0.0 | Edited in place, still unreleased: clauses 10 and 13, goldens regenerated |
| Website | Terms, Privacy and data deletion pages, the homepage FAQ and the vendor register (`LEGAL_VERSION` 2026-10-14.1) |
| The transcript email | Says healdesk's copy goes once the clinic's mail server confirms receipt |
| Still to change | The spec doc (`docs/v1-product-spec.md` is its export); apps/web's ops client for `transcriptDeliveries`; the Terraform archive variables |

## Risks the decision accepts, and the ones to settle

- **A transcript that never goes is lost after 30 days.** The outbox retries for that long
  and ops hears at the third failure, at a bounce and at the deletion; after that there is no
  copy to send, and the clinic has to be told by a person.
- **No resend after delivery.** The copy goes the moment the clinic's server accepts the email,
  so a clinic that loses it afterwards cannot be sent it again. Delivery is the receiving
  server's acceptance, not a person reading it: a server that accepts and then quarantines the
  message counts as delivered.
- **SES's events are load-bearing.** If the SNS topic stops reaching `/api/webhooks/ses`,
  nothing is deleted on delivery, but no copy outlives 72 hours after its send, and ops hears
  once per transcript (`unconfirmed`).
- **The clinic's inbox becomes the record.** One shared address, often with no business associate
  agreement of the clinic's own with its mail provider. healdesk can no longer delete a
  transcript after 90 days, correct it, or include it in an export or a patient's access
  request: those move to the clinic. Counsel should confirm the agreements can say so.
- **Replies.** The email comes from hello@healdesk.io, which has no business associate agreement
  behind it, so it asks not to be replied to. A clinic that replies anyway sends the transcript
  there. Settle it with a reply-to address that is covered, or by accepting the risk in writing.
- **The call-announcement record.** For Washington and Connecticut the record that the
  "this call is transcribed" line was given was to be the transcript line and its timestamp
  (`docs/counsel/state-disclosure.md`, R1). Without a stored transcript it is
  `conversations.disclosure_played_at` and the fixed audio asset the line is played from. Put
  this to counsel with R1.
- **Raw vendor payloads.** `webhook_events.raw_payload` keeps a vendor's payload for 30 days
  and can carry a transcript. The old Synthflow route still writes one, which BAA 1.4.0's and 1.5.0's "keeps
  no other copy" does not allow: it must go before any real call (it serves no clinic in v1). The
  Retell endpoint writes no `webhook_events` row at all.
