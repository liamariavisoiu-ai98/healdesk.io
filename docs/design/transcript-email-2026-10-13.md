# Transcripts are emailed, not stored — 13 October 2026

**Decision (owner, 13 October 2026).** When a call or a web chat ends, its transcript is emailed
to the clinic's address and healdesk keeps no copy of it. The conversation row stays, without
the words: channel, times, outcome, the booking it produced, and when the "I'm an AI assistant,
this call is transcribed" line played.

The spec (`docs/v1-product-spec.md`) and the agreements still describe a stored, searchable
transcript. Until they change, this file records what was built against the decision and what
has to follow it. The spec wins on what the product is (`CLAUDE.md`), so the spec doc has to be
edited and re-exported; the export in this repository is never edited by hand.

## What is built

- `apps/app/src/lib/conversations/transcript-email.ts`. `renderTranscriptEmail()` builds the
  email: a fixed subject that names nobody, the conversation's time in the clinic's zone, each
  turn labelled (Assistant / Caller / Visitor), everything escaped in the HTML, cut with a note
  past 200,000 characters. `sendTranscriptEmail()` sends it classed `may-carry-phi`, never
  throws, and returns what the transport said. Calls and web chats only: the Meta channels are
  refused, because healdesk keeps no Meta message (BAA 1.3.0 clause 11) and an email would be a
  way of keeping one.
- **The outbox** (owner, 13 October 2026: "if a send fails, it still can recover the transcript
  or retry until it works"). `lib/conversations/transcript-outbox.ts` and `drizzle/0069`:
  - the conversation's own transaction queues the transcript, sealed under the KMS key with the
    clinic's lock label, in `transcript_emails` (forced row-level security, the BAA gate on
    insert, one row per conversation), and sends it straight after commit;
  - a failed send is tried again after 1, 2, 5, 10 and 30 minutes, then hourly; ops hears on
    the third failure (`transcript_undelivered`, ids and SES's reason only), and again if a copy
    is deleted unsent;
  - SES's events reach `/api/webhooks/ses` through a signed SNS topic (`infra/aws/ses.tf`): a
    delivery is recorded, a hard bounce, rejection, complaint or rendering failure marks the
    transcript bounced and it is sent again an hour later;
  - the database deletes nothing itself but holds the clock: `destroy_after` is seven days after
    the first accepted send (or after queueing, if it never went), set by trigger from the
    database's clock, and no later send moves it. The `transcript-emails` job, every minute
    from the `billing-minute` queue with the hourly tick as its backstop, deletes each row on
    its day. It ships switched on because it carries that deletion;
  - `resendTranscript` (the ops operation of the same name) sends it again while the copy lasts;
  - the copy goes with its conversation (foreign key) and with the clinic's destruction
    (`destroyClinicData`, `app_mark_clinic_destroyed`).
- **The archive copy** (owner: "a copy of the transcript always sent in bcc to
  hello@healdesk.io"). Built as a blind copy to one mailbox, `HEALDESK_TRANSCRIPT_ARCHIVE_TO`
  (Terraform `transcript_archive_to`), sent only when `HEALDESK_TRANSCRIPT_ARCHIVE_BAA=signed`
  (`transcript_archive_baa_signed = true`). It is off: hello@healdesk.io is on a provider with
  no business associate agreement (`packages/catalog/src/sender-identity.ts`), and a transcript
  sent there would be a disclosure no agreement covers. It turns on for a mailbox held under one,
  for example a Google Workspace address once Google's BAA is accepted.
- `getTransport()` (`lib/reporting/deliver.ts`) sends the `may-carry-phi` class through SES
  whenever SES is set up for it (`HEALDESK_SES_CONFIGURATION_SET`), while every other email stays
  on Resend, which also refuses a blind copy. SES refuses to send unless the configuration set's
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

## What has to change to match

| Where | Today it says | Change |
| --- | --- | --- |
| Spec, voice section ("the working transcript lives in Healdesk under the clinic's retention policy") | Stored | Emailed to the clinic, not kept |
| Spec, Portal map, Conversations ("Every call, chat and DM, searchable, with the transcript … Export available") | A searchable transcript screen | The conversation list without the words; the transcript is in the clinic's inbox |
| Spec, "What data actually moves" (call transcript and chat transcripts "Healdesk database at rest") | At rest with healdesk | In transit through SES to the clinic; nothing at rest |
| Spec, retention (90 days, shortenable to 30 or 7; a second factor and an access log before a transcript opens) | Stored transcripts | No transcript to keep, open or log; the conversation row keeps its own 90-day clock |
| Spec, support chat ("finding a transcript") | Support finds one | Support cannot: there is none |
| BAA 1.3.0 clause on permitted uses, item e ("keep transcripts and records of those conversations … show them … export, correct or delete them") | Keeps transcripts | Emails each transcript to Practice once, keeps the records without the words |
| BAA 1.3.0 "patient information involved" ("kept as transcripts with no call audio") | Kept | Transmitted to Practice, not kept |
| BAA 1.3.0 clause 11 ("Anything else a person chooses to say … is kept only in the transcript"; "healdesk keeps each conversation, with its transcript, for 90 days"; "Practice may shorten the period for transcripts") | Kept 90 days, shortenable | The conversation record for 90 days; the transcript not at all |
| DPA 1.0.0, the same three places (lines 171, 182, 371-378 of `docs/dpa-v1.0.0.txt`) | Kept | As the BAA |
| Portal, Settings, "Keep transcripts for" (`apps/app/src/app/c/[slug]/settings/SettingsCards.tsx`) | A setting with no effect now | Remove it with the spec change; the purge's transcript clock and `transcript_uri` go with it |
| `docs/hipaa-risk-analysis.md`, the transcripts row ("Object storage referenced by URI") | Stored | Emailed through SES; nothing stored |

A new agreement version (BAA 1.4.0, DPA 1.1.0) is cheapest now, while no clinic has signed.

## Risks the decision accepts, and the ones to settle

- **A transcript that never goes is lost after seven days.** The outbox retries for that long
  and ops hears at the third failure and at the deletion; after that there is no copy to send,
  and the clinic has to be told by a person.
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
  and can carry a transcript. The old Synthflow route still writes one; the Retell endpoint must
  store no transcript in its raw payloads.
