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
  past 200,000 characters. `emailTranscriptToClinic()` sends it to the addresses it is given,
  classed `may-carry-phi`. It writes nothing to the database. A failed send is logged and raises
  the ops alert `transcript_undelivered` with the conversation's and the clinic's ids and SES's
  reason, never the words. Calls and web chats only: the Meta channels are refused, because
  healdesk keeps no Meta message (BAA 1.3.0 clause 11) and an email would be a way of keeping one.
- `getTransport()` (`lib/reporting/deliver.ts`) sends the `may-carry-phi` class through SES
  whenever SES is set up for it (`HEALDESK_SES_CONFIGURATION_SET`), while every other email stays
  on Resend. SES refuses to send unless the configuration set's `TlsPolicy` is `REQUIRE`, so a
  receiving server that will not negotiate TLS gets nothing. Without SES the PHI class is refused,
  as before.
- `infra/aws`: `enable_ses = true` (the configuration set, the domain identity and its DKIM
  records, the task role's send rights). The transcript bucket stays off and is superseded.
- The old Synthflow call ingest no longer stores the vendor's transcript link
  (`conversations.transcript_uri` is written as null).
- Tests: `apps/app/tests/transcript-email.test.ts`, and routing cases in
  `tests/resend-routing.test.ts`.

## What is not built

- **No caller yet.** The Retell voice endpoint and the web chat's API are not built; each calls
  `emailTranscriptToClinic()` when its conversation ends, with the addresses read from
  `billingRecipients()` inside the tenant context and the send made outside the transaction.
- **The SES sandbox.** The account has to be taken out of it (infra/aws/README.md, First run,
  step 9) before a transcript can reach a clinic.

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

- **A failed send loses the transcript.** There is no stored copy to send again. Ops hears of
  each one (`transcript_undelivered`); the clinic has to be told.
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
