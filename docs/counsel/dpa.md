# The healdesk Data Protection Agreement (dpa/1.0.0)

> **Drafted 6 October 2026. Not released, not offered, not legal advice.**
> The owner releases it at launch (Gate A) by setting `approvedByCounsel` to
> true on `DPA_TEMPLATES[0]` in `packages/catalog/src/dpa.ts`, after reading
> [`docs/dpa-v1.0.0.txt`](../dpa-v1.0.0.txt), once the rest of § 9's checklist
> is done: the flag alone does not let a DPA practice go live (gap 11).
> Drafted by an AI assistant, as the rest of this folder was; the primary
> sources are linked so anyone can check the reading.
>
> **Counsel, 6 October 2026:** the owner sent counsel the DPA's clauses, the
> plan-start and refund terms and the notice a practice gives if it starts
> billing insurance, and recorded that counsel "approved them all to go ahead
> and implement" (the launch open-items page). One wording change followed,
> from the adversarial review of the same day: the veterinary variant no
> longer states that every signer is a veterinary practice, because the
> specialty is "Veterinary & Pet Spas" and a grooming spa signs it too.
>
> **Since then.** The BAA's pre-release audit (agreement-changes.md § 12.14)
> gave the DPA the fuller state-law clause, and on 7 October 2026 the
> funnel's pre-release text followed, as § 12.14 "The funnel's DPA" lists it
> (§ 5, items 10 to 15): "calendar election" defined and its own election form
> drafted; the 24-hour incident and breach rule; "without penalty" given its
> effect; the instructions, requests and assistance clauses reconciled with
> the shared clause; and a correction the record cannot take appended and
> linked, as BAA 1.3.0's is (PT-17). On 12 October 2026 the two sentences
> that kept a deleted client's telephone number changed with the code (BAA
> 1.3.0 release gates 6 and 7; gap 15). Counsel's approval covered the
> clauses as they stood on 6 October, not these edits, which the owner reads
> in `docs/dpa-v1.0.0.txt` before the release.

## 1. What it is, and who signs it

A practice HIPAA does not cover signs the Data Protection Agreement instead
of the business associate agreement (the v1 spec, "Who is what"; plan Part L):

| Practice | Paper | Why |
| --- | --- | --- |
| Veterinary (`non-hipaa`) | DPA, without being asked the covered-entity question | HIPAA protects information about *individuals*; an animal is not one (45 CFR 160.103, https://www.law.cornell.edu/cfr/text/45/160.103, not re-read this session; the reasoning is the one `packages/catalog/src/specialties.ts` already records) |
| Med spa, hair restoration, massage and chiropractic (`hipaa-if-covered`) answering **No** | DPA | Not a covered entity by its own answer, which the DPA records as a warranty |
| The same answering **Yes** or **Not sure** | BAA | "Not sure" signs the BAA (spec) |
| Plastic surgery, fertility, dental, GLP-1 (`hipaa`) | BAA, whatever the answer | |

`agreementKindFor` (`packages/catalog/src/agreement-kind.ts`) is the one
function that decides, and it reads the DPA template's release flag at call
time. Until the release, a "No" signs the BAA, as it always has, and a
veterinary practice cannot buy (`specialtyOffered`).

The DPA is not a weaker paper. The spec says a DPA practice's client data "is
controlled exactly as PHI", so the DPA applies the HIPAA Security Rule's
safeguards to it, keeps the BAA's reporting clocks, flow-down and
destruction, and adds the processor terms state law asks for.

## 2. How it is built

- **The same machine as the BAA, run separately.** A preamble and a library
  of clauses with pure, total predicates, assembled in a fixed order and
  numbered (`renderDpa`, `prepareDpa`, `hashDpaText`). A parallel assembler
  rather than the BAA's renderer, so that nothing about the DPA can move a BAA
  golden hash; `apps/app/tests/baa-golden.test.ts` is unchanged and passes.
- **Quoted, not retyped.** The state-law processor clause is
  `stateLawClauseBody({ subject: "Client Information", sync })` from
  `baa.ts`: the fuller clause BAA 1.3.0 carries, in this document's words
  (no PHI and no patient, this document's headings for the clauses it names,
  the CMIA sentence, and its calendar purposes and data following the
  booking sync), as the BAA's pre-release redraft settled on 6 October 2026
  (`DPA_STATE_LAW_EDITS` and the two-edit quotation are gone). The Payments
  clause is `PAYMENTS_CLAUSE_BODY`, word for word. The notice of a new
  subcontractor is `subprocessorNoticeClauseBody()`. The party, notice
  address and Delaware law are `AGREEMENT_PARTY`, exported from `baa.ts` for
  this purpose without changing any BAA byte.
- **One calendar clause, chosen as BAA 1.3.0 chooses it.**
  `selectCalendarClause` picks covered, uncovered or not-used from the
  booking system and the Google account kind, under the same clause ids, so a
  location's calendar terms read the same off any acceptance. Its heading is
  "Google Calendar", as 1.3.0's is. The words are the selector's, with one
  change: the person a booking is for is a "client" (`CALENDAR_PERSON_NOUNS`:
  "about the client", and "who may not be the client the appointment is
  for"), because a veterinary practice's agreement must never call a person
  a patient. The one exception is the word the event itself carries when the
  first name cannot be used, quoted as `event.ts` writes it for every
  practice (`CALENDAR_EVENT_FALLBACK_QUOTED`, `"Patient"`): printing anything
  else would misdescribe the event. BAA 1.3.0's location paragraph follows,
  as it does there. A test rebuilds the BAA 1.3.0 clause from the DPA's, for
  every booking system and account, word for word.
- **Its own calendar election.** The location paragraph sends a second
  location, and a change of booking system or account kind, to a calendar
  election; `calendar-election/1.0.0` names only the BAA. The DPA's form is
  `calendar-election-dpa/1.0.0` (`packages/catalog/src/dpa-calendar-election.ts`),
  built from calendar-terms.ts's exported pieces with the clause in the
  DPA's words (`dpaCalendarClauseBody`) and without the location paragraph,
  unreleased, frozen by `dpa-calendar-election.test.ts` and printed in
  Appendix B of the review file. `calendarElectionFor(agreementVersion)`
  picks the form by the agreement's kind (§ 6, gap 6).
- **Variables.** Legal name, signatory, title, email, date, the specialty
  (which chooses the status clause and gives the legal descriptor in the
  preamble), the booking system and the Google account kind. Plan, price,
  channels, retention and the practice's state are not variables; a test
  renders with them added and gets the same hash, and finds no plan name,
  price or package word in any variant.
- **A render guard.** `validate` refuses a specialty HIPAA always reaches, an
  unknown booking system or account kind; `renderDpa` refuses a missing name,
  signatory, email or date.
- **Two status variants, one release flag.** `status-veterinary` and
  `status-not-covered`; exactly one renders. 22 clauses are registered and
  19 render.

## 3. Clause by clause, against BAA 1.2.1

| # | DPA clause | Against 1.2.1 |
| --- | --- | --- |
| — | Preamble | 1.2.1's layout; "HEALDESK DATA PROTECTION AGREEMENT", "Version 1.0.0"; says HIPAA does not apply and the PHI safeguards do; the practice named with its legal descriptor ("a veterinary practice or pet spa") |
| 1 | Definitions | 1.2.1's, plus "client", "Client Information" and "security incident" in state-law terms; a "breach" that includes anything a state breach-notification law treats as a breach of security, and "calendar election", in BAA 1.3.0's words, an accepted one part of the agreement; the agreement prevails over the Terms on Client Information and on termination, the Services and the Fees, as 1.3.0's does. A veterinary practice's clients are the animals' owners or keepers, never the animals |
| 2 | Practice's status | Replaces practice-status. Veterinary: animals are outside HIPAA. Otherwise: the practice warrants it sends no covered transaction, must say before that changes, and from that notice the assistant pauses until the BAA replaces the DPA, with forwarded calls passing through to the direct line |
| 3 | Practice's instructions | Reconciled with clause 5 (§ 5, item 10): what the instructions are, and the notices and consents, are clause 5's; this clause keeps the unlawful-instruction notice, a client's limits and withdrawn permissions, and the lawful-instruction promise |
| 4 | Permitted uses | 1.0.0's permitted-uses, narrowed to providing the Services, security and the law. **No aggregation permission** (see § 5) |
| 5 | Where Practice is not a covered entity | BAA 1.3.0's state-law clause, `stateLawClauseBody` in this document's words |
| 6 | Payments | BAA 1.3.0's, verbatim |
| 7 | What healdesk reads | BAA 1.3.0's data-sources clause in client words; calendar access only as the calendar clause, or a calendar election, gives it |
| 8 | Google Calendar | BAA 1.3.0's chosen clause (see § 2) |
| 9 | Safeguards | The Security Rule applied as if Client Information were ePHI; 1.2.1's second and third paragraphs (A4's email sentence included) |
| 10 | Minimum necessary, and who receives Client Information | The booking catalogue as a ceiling (not 1.2.1's list: see § 6, gap 4), the animal's name and species for a vet, the opening-line disclosure, no call audio; then disclosure by category, the calendar as its clause or an election describes |
| 11 | Subcontractors | 1.2.1's flow-down, without the HIPAA citations; Anthropic's retention in 1.2.1's words; the 24-hour notice |
| 12 | Reporting incidents and breaches | BAA 1.3.0's one rule, without its HIPAA citations: immediately following discovery and within 24 hours, for all three; the law-enforcement delay; each notice itself the written report, added to promptly, with what Practice needs for its own notices |
| 13 | Clients' requests | Reconciled with clause 5: the ten-business-day help with any client's request stays, deletion is clause 5's item c, and a request made to healdesk itself, any request, is answered only in healdesk's reply (1.3.0, PT-24); a correction is made in healdesk's copy where the record can be changed, and otherwise appended and linked, as in 1.3.0's clause 14(b) (PT-17) |
| 14 | Confidentiality | New; a veterinary paragraph |
| 15 | Not authorised | 1.2.1's four prohibitions; Meta "is not healdesk's subcontractor and is not bound by this agreement" |
| 16 | Assistance and audit | The records-to-HHS clause, made general; reconciled with clause 5: the state privacy laws' help is clause 5's, every other law's stays here |
| 17 | Term | Written from the offboarding clock in the code (§ 4), not 1.2.1's "within thirty days"; terminating under the Subcontractors clause is "without penalty": the Services end that day, no Fees after, a refund of Fees paid for later time |
| 18 | Liability | 1.2.1's allocation and Terms §§ 13–14, in state-law terms; the Term clause's refund outside the exclusion and the indemnity, as 1.3.0's |
| 19 | Notices and law | 1.2.1's, without HIPAA; Delaware; the notice address is the practice's one address; an accepted calendar election is part of the entire agreement |

Not carried: acting-in-your-place (164.504(e)(2)(ii)(H)) and records-to-HHS,
which are HIPAA's; own-use's aggregation permission (§ 5).

## 4. Every sentence that rests on a fact in the code, and where it was read

Read in the code on 6 October 2026, at origin/main d652a0b.

| Sentence (clause) | The code fact | Where |
| --- | --- | --- |
| Destruction "runs once a day" (17) | `offboarding-destroy` runs every hour in the scheduler tick, when the job is switched on, and every run destroys a clinic on this rule once it is due, a day before each limit in the next row: more often than the text says and never later than it, since the job keeps BAA 1.3.0's words for both agreements (the calendar session's decision, 7 October 2026; the text is left as it is; drizzle/0058) | `apps/app/src/lib/scheduler/tick.ts`; `destroyDueClinics` in `apps/app/src/lib/offboarding/offboarding.ts` |
| Destroyed "once thirty days have passed … if the export has been delivered … otherwise at the first run after the export is delivered … in any case … once ninety days have passed" (17) | `app_start_offboarding()` stamps `destroy_after` thirty days after the start, by the database's clock, and `DESTROY_AFTER_DAYS = 30` states that period; `DESTROY_WITHOUT_EXPORT_AFTER_DAYS = 90`. Since 7 October 2026 the rule is per agreement: `DESTRUCTION_RULES` maps `dpa/1.0.0` (and BAA 1.3.0) to this one, and `destructionPlan` and `dueForDestruction` apply it; `app_destruction_due()` is the same rule as the database's floor. A clinic is due a day before each limit: at day 29 once the export has been delivered (`THIRTY_DAY_LIMIT_DUE_DAYS`), at the delivery when that is later, and at day 89 without one (`NINETY_DAY_LIMIT_DUE_DAYS`), so the hourly run destroys it before either passes. BAA 1.2.1 and earlier get their own thirty days | `apps/app/drizzle/0058_destruction_clock.sql`; `apps/app/src/lib/offboarding/offboarding.ts`; pinned by `apps/app/tests/destruction-clock.test.ts` and `apps/app/tests/agreement-kinds.test.ts`, the stamp's thirty days to `DESTROY_AFTER_DAYS` by `apps/app/tests/incidents-and-offboarding.test.ts` and `apps/app/tests/booking-request-destruction.test.ts` |
| The clock starts "when the Services end" (17) | `startOffboarding` on `customer.subscription.deleted`, at the subscription's own `ended_at` (else the event's `created`), which `app_start_offboarding()` takes up to a week back; or an operator's `startOffboarding`, at the moment of the call (7 October 2026, drizzle/0058) | `apps/app/src/lib/billing/events.ts`, `apps/app/src/lib/ops/api.ts` |
| "Within thirty days … deliver … an export … in a usable electronic form" (17) | Terms § 7 promises it; `exportClinic` (`npm run patient-export -- --all`) produces it and stamps nothing; the operator's record of the handover (ops `markExportDelivered`, refused until a bundle has been produced since offboarding started) stamps `export_delivered_at` through `app_mark_export_delivered()`, the column's only writer | `apps/web/src/app/terms/page.tsx`; `apps/app/src/lib/patient-rights/export.ts`; `apps/app/scripts/patient-export.ts`; `apps/app/src/lib/ops/api.ts`; drizzle/0058 |
| Calls pass through to the direct line "for as long as the Terms provide" (17) | Terms § 7, `POLICY.forwardingPassThroughDays = 30` | `apps/web/src/lib/legal.ts` |
| Destruction "deletes the conversations, bookings, booking requests and contact details … and the credentials" (17) | `destroyClinicData` deletes reconciliation exceptions, transactions, booking requests (first, through `app_destroy_booking_requests()`, drizzle/0054, once the clinic is due by its agreement's rule and the database's clock, `app_destruction_due()`, drizzle/0058), appointments, conversations, the keyed hashes of who messaged the practice and of the messages handled (`chat_threads`, `meta_inbound_messages`), Meta booking drafts, contacts, webhook payloads, provider connections and closures, and, since 7 October 2026, suppressions, consent records and contact attempts (`app_destroy_contact_evidence()`), and `app_mark_clinic_destroyed()` refuses to record the destruction while any of them is left | `offboarding.ts`; drizzle/0054, drizzle/0058 |
| "After it, healdesk holds no Client Information for Practice" (17); a deletion keeps "a record of the request that holds no telephone number, email address or name", and its keyed references only for the backup window (13) | Since 12 October 2026 `eraseContact` writes no `suppressions` row, and the operator's erase path (`erasePerson`) deletes the client's own suppressions, consent records and contact attempts with the rest; the request is recorded in `erasure_requests` with no number, address or name, and its `restore_refs` (keyed HMACs of the numbers, addresses and messaging threads the deletion found, never the details) are emptied 35 days after the deletion (`BACKUP_RETENTION_DAYS`) by the hourly `erasure-expiry` sweep and read only by `reapplyErasures` after a restore. Destruction deletes suppressions, consent records and contact attempts (drizzle/0058), the deletion records (0061) and the amendments (0062) with the rest. Nothing else that survives destruction holds client data: `usage_events` keep keyed references to calls that no longer exist, and `deposit_payments` keep no payer details | `apps/app/src/lib/patient-rights/erasure.ts`, `apps/app/src/lib/retention/purge.ts`, `apps/app/src/lib/offboarding/offboarding.ts`; drizzle/0058, 0061, 0062; pinned by `apps/app/tests/person-erasure.test.ts` and `tests/booking-request-destruction.test.ts` |
| "The signed copy … kept for at least six years after it ends" (17) | `retention_eligible_at` is a floor; healdesk_app has no DELETE on `baa_acceptances`; nothing deletes one | `drizzle/0025_baa_retention.sql`; `apps/app/src/lib/agreements/retention.ts` |
| What the assistant asks for (10) | `BOOKING_FIELDS`: the locked four and the five a practice may switch on; `EXCLUDED_FIELDS` has no email | `packages/catalog/src/booking-requirements.ts` |
| The opening line says AI, and on a call that it is transcribed (10) | The fixed disclosure lines | `apps/app/src/lib/compliance/disclosure.ts` |
| Each appointment carries a first name, the service and the time; private; no invitees or reminders (8) | The event builder | `packages/connectors/src/google/event.ts` |
| An email that cannot negotiate encryption "is failed, not sent" (9) | SES configuration set with `TlsPolicy=REQUIRE` | `apps/app/src/lib/reporting/deliver.ts` |
| The notice address is "also the address of Practice's healdesk account" (19) | The checkout intent requires the agreement's signer to be the buying address; provisioning makes that address the clinic's one sign-in | `apps/app/src/lib/checkout/intents.ts` (`checkIntentAgreement`); `apps/app/src/lib/provisioning.ts` (`ensureOwner`) |
| From the covered notice, the assistant is paused until the BAA replaces the DPA (2) | The database refuses a DPA clinic's client data from the write that records `is_covered_entity` as anything but false (`app_clinic_accepts_phi`, drizzle/0051); `app_supersede_agreement` puts the BAA in force; the pause itself is `clinic_settings.ai_paused_at` | `apps/app/drizzle/0051_agreement_kinds.sql`; `apps/app/src/db/schema.ts` |
| Anthropic's 30 days, two years when flagged, no training (11) | BAA 1.2.1's sentence, from Anthropic's own pages read 1 October 2026 (agreement-changes.md § 4); pinned by a test against the 1.2.1 rendering | `packages/catalog/src/baa.ts` |
| 24 hours' notice by email, with the right to object (11) | `SUBPROCESSOR_NOTICE_HOURS = 24` | `packages/catalog/src/subprocessor-notice.ts` |

Added on 7 October 2026, read at origin/main c926414:

| Sentence (clause) | The code fact | Where |
| --- | --- | --- |
| Notice "immediately following discovery … and in any case within 24 hours", for a use or disclosure not permitted, a breach and a security incident (12) | The runbook works to 24 hours for all three, for every clinic. The console's `notifyDeadline` gives a not-covered clinic's breach a day ("immediately"), but improper use or disclosure and a security incident five business days, for every clinic; gate 5 (another branch) makes it 24 hours for every class and clinic, after which the text and the code agree. Until then the text is the stricter, and the runbook keeps it | `docs/incident-response.md`; `apps/app/src/lib/incidents/incidents.ts` |
| The notice goes "by email to Practice's address in the Notices clause" (12) | The practice's one address: the signer's, which the checkout intent requires to be the buying address and provisioning makes the account's sign-in | as clause 19, above |
| "in its reply to the client, tell them that healdesk cannot act on it" (13) | v1 is inbound only: no code path contacts a person after a conversation ends (CLAUDE.md, "Product rules"), so the reply is the one moment to say it; passing the request on is an operator's step | the product rules in the root CLAUDE.md |
| "delete it as the clause headed … provides" (13); ten business days, raw copies, backups within 35 days (5, item c) | The care page's "Delete a person" (ops `erasePerson`, through the signed envelope) runs `eraseContact` and also deletes the client's raw payloads (`webhook_events`), the drafts and `chat_threads` of their own messaging threads (a thread that also booked for someone else keeps what it sent for others, counted in the reply), and their suppressions, consent records and contact attempts, in one transaction; it records the request with its ten-business-day deadline and shows each subcontractor step (Retell's, done in its console) outstanding until the operator records it. Backups age out at the host's 35 days (gate 18) | `apps/app/src/lib/patient-rights/erasure.ts`; `apps/app/src/lib/ops/api.ts`; agreement-changes.md § 12.14, gate 6 |
| "It will correct that information as Practice directs"; "Where the record can be changed, healdesk corrects its own copy"; where it "must stay as it was made, such as a booking request or the record of a conversation, healdesk appends the correction to it and links the two"; "Every later use and export of that record then carries the correction" (13) | Since 12 October 2026: the care page's "Amendments" corrects a contact in place (ops `amendContact`, recording which fields changed) and appends a correction to a booking request or a conversation (ops `amendRecord`) in `record_amendments`, append-only, linked by a foreign key that keeps it on a record of the same clinic, and removed only with that record (erasure, the purge, destruction). `exportPatient` and `exportClinic` carry each beside its record, and the desk's view of a booking request says how many there are (never their words: it opens without a passkey). A booking request still never changes in place (0039's trigger) | `apps/app/src/lib/patient-rights/amendments.ts`, `apps/app/src/lib/patient-rights/export.ts`; `apps/app/drizzle/0062_record_amendments.sql`, pinned by `apps/app/tests/record-amendments.test.ts`; agreement-changes.md § 12.14, gate 8 |
| Terminating under the Subcontractors clause: "the Services end on the same day, no Fees accrue … and healdesk refunds" (17) | Nothing automates it: Package C's refund actions answer "not_available" on main, so an operator refunds through Stripe and cancels the subscription the same day, which starts offboarding (`customer.subscription.deleted`) | `apps/app/src/lib/billing/stripe-actions.ts`; `apps/app/src/lib/billing/events.ts` |
| "Calendar election" and the form that names this agreement (1, 8, 19) | `calendar-election-dpa/1.0.0` exists as text, unreleased. Nothing can record an election of either kind: the election rows and their writer are plan C6 and C7, not on main | `packages/catalog/src/dpa-calendar-election.ts`; docs/design/google-calendar-2026-10-05.md |

## 5. Choices made in drafting

1. **The status clause has two variants with their own ids**, so the stored
   `appliedClauses` say which one a practice signed, as the calendar
   clauses do.
2. **"Client" throughout, for every DPA practice.** The vet variant must
   never call a person a patient, and one word in both variants keeps them
   one document. A test asserts that no DPA variant contains "patient".
3. **No aggregation permission.** BAA 1.3.0's own-use clause permits
   de-identified aggregate statistics while the state-law clause it carries
   forbids combining the information with other sources (agreement-changes.md
   § 12.11, item 3). The DPA carries the state-law clause, so it does not
   carry the permission, rather than ship a known contradiction.
4. **The minimum-necessary list is the booking catalogue, not 1.2.1's list.**
   1.2.1 says the assistant collects "a name, a telephone number or email
   address, the service asked about and a preferred time — and no more", but
   the catalogue also lets a practice ask whether the caller has been before,
   whether it is a consultation or a treatment, and a preferred practitioner,
   and excludes email. The DPA states the catalogue as a ceiling.
5. **No retention period during the term.** See § 6, gap 2: whether to
   state one is now the owner's decision, the code's default being 90 days.
6. **The Term clause describes the clock as the daily job runs it** ("once
   thirty days have passed", "the first run after"), because `destroy_after`
   is an instant thirty days after the end and destruction happens at the
   next daily run, not on a calendar day. Since 7 October 2026 the job runs
   every hour and a clinic is due a day before each limit, so the words
   state the latest it destroys; they are left as they are.
7. **Meta is "not healdesk's subcontractor and not bound by this
   agreement"**, not "signs no business associate agreement": the DPA is not
   about BAAs, and Meta does publish data-processing terms for some products.
8. **Not every BAA sentence survives.** HIPAA citations, the accounting of
   disclosures and acting-in-your-place are HIPAA's; the DPA neither claims
   them nor denies them.
9. **The supersede function allows DPA→BAA and BAA→BAA only.** DPA→DPA (a
   newer DPA re-accepted) is refused until a DPA 1.1.0 exists to decide it;
   that fails closed.
10. **Overlaps with the shared clause: one statement of each duty, the more
    protective kept** (7 October 2026; § 12.14 "The funnel's DPA"). The
    shared clause cannot be edited from here (it is `baa.ts`'s, frozen with
    BAA 1.3.0), so the reconciling is done on this side: where the shared
    clause states a duty at least as protectively, this document's own
    sentence goes; where this document's is broader, it stays and the
    shared clause's narrower one is then subsumed, the shared clause's
    precedence sentence making the more protective govern wherever the two
    still touch. Merged:
    - *Instructions (3).* "Practice decides … through the Terms and the
      settings … which are its instructions" went: the shared clause's
      "this agreement and the settings Practice chooses in its portal,
      within the purposes below" is narrower in both ways (this agreement,
      not the healdesk-written Terms; bounded by purposes), and clause 3
      now points to it. "Is responsible for any notice the law requires …
      and any consent" went: the shared clause's covenant to "make sure its
      own notices, consents and any consumer health data privacy policy
      cover the processing" is a duty to act, not an allocation. Kept: the
      unlawful-instruction notice and the limits and withdrawn permissions
      (the shared clause has neither), and "will not ask healdesk to use or
      disclose … in a way the law would not permit Practice itself to",
      which reaches every law where the shared clause's "will not instruct
      healdesk to process … in a way those laws forbid" reaches the state
      privacy laws only.
    - *Requests (13).* The help with a request stays: it reaches every
      client's request to see, correct or delete, where item b reaches
      requests under the state privacy laws only, on the same ten business
      days. "Will correct or delete … as Practice directs" became "correct …
      as Practice directs, and delete it as the clause headed 'Where
      Practice is not a covered entity' provides": item c is the more
      protective deletion duty (ten business days, raw copies, backups
      within 35 days, subcontractors, only a record of the request kept).
      The shared clause sends "a request made to healdesk directly" here,
      but clause 13 covered only "such a request": it now covers any
      request about a client's information. The telephone-number sentence
      was left for gates 6 and 7 (§ 6, gap 15), and changed with them on
      12 October 2026.
    - *Assistance (16).* "The reasonable help it needs … under the laws
      that apply" restated, more loosely, what items b and d and the
      assessment paragraph say for the state privacy laws (by appropriate
      measures, insofar as possible, each request within ten business days;
      what an assessment needs; documents and assessments on request). For
      those laws clause 16 now points to the shared clause; for every other
      law (breach notification, medical and veterinary confidentiality) it
      keeps its own help, the written questions about the whole agreement
      and the records to a regulator, none of which the shared clause says.
    Not reconciled, being outside the three clauses § 12.14 names:
    permitted uses (4) against the shared purposes, confidentiality (14)
    against its item a, and the subcontractor flow-down (11) against its
    subcontractor paragraph. Each is consistent with the shared clause, and
    the precedence sentence governs meanwhile (§ 6, gap 16).
11. **"Without penalty" is given the whole of 1.3.0's effect**, which takes
    three sentences there and here: the Term clause's (the Services end the
    same day, no Fees after, Fees for later time refunded), the Liability
    clause's (the refund outside the exclusion and the indemnity), and the
    Definitions clause's (this agreement prevails over the Terms on
    termination and the Fees, so the Terms' "not refundable except where
    these terms … say otherwise" cannot take it back). 1.3.0 also refunds a
    termination for healdesk's violation; the DPA's termination for a
    material breach was left as it was, a commercial term for the owner
    (§ 6, gap 17).
12. **The 24-hour rule is 1.3.0's, in this document's words**: no 45 CFR
    citations, "the law that applies" for the law-enforcement delay (Cal.
    Civ. Code 1798.82(c) provides one), and a client, not a patient, as the
    person a breach report identifies. A state-law breach of security is a
    "breach" by definition, as in 1.3.0 (ICD-33), so the shared clause's
    item f and clause 12 are one rule.
13. **Inbound only, in the requests clause.** "Tell the client it has done
    so", after passing a request on within five business days, promised a
    contact v1 never makes; it now says so in healdesk's reply, as 1.3.0
    does (PT-24). Not in § 12.14's list; changed because the sentence was
    untrue of the product.
14. **Calendar elections, where the DPA's own text speaks of the calendar.**
    With the term defined and a form drafted, the data-sources clause (7)
    and the recipient list (10) say the calendar access is the calendar
    clause's or an election's, as 1.3.0's do, rather than become untrue the
    day a manual-booking practice's second location records one.
15. **Corrections, in the requests clause** (7 October 2026, from review).
    "It will correct that information as Practice directs", read alone,
    promised to change a booking request in place, which 0039's trigger
    refuses. BAA 1.3.0's audit found the same promise in its clause 14(b) and
    fixed it (PT-17). The DPA now says it in 1.3.0's words: corrected in
    healdesk's copy where the record can be changed, and otherwise appended
    to the record and linked to it, every later use and export then carrying
    the correction. It says "correction" where 1.3.0 says "amendment",
    because a client asks to correct, and cites no 45 CFR. The reconciled
    sentence before it is unchanged; the telephone-number sentence after it
    changed with gates 6 and 7 (§ 6, gap 15). 1.3.0 rests the appending on 45 CFR 164.526(c)(1), which is
    HIPAA's; whether an appended correction meets a state privacy law's right
    to correct, where one applies, is a question for counsel (gap 22).

## 6. Gaps found between the code, the plan and the text

1. **Thirty days to destroy (BAA 1.2.1 and 1.3.0).** The BAA promises
   destruction "within thirty days of termination"; the code destroys at
   thirty days only once the export has been delivered, and otherwise at
   ninety, and only when the `offboarding-destroy` job is switched on (it is
   seeded off). The DPA states the code's clock. The BAA still needs the same
   correction (agreement-changes.md § 12.11, item 8), and the job must be on
   before the first clinic's offboarding. (7 October 2026: drizzle/0058 keeps
   each agreement's own rule, so a clinic on BAA 1.2.1 or earlier is destroyed
   before its thirty days are up whatever the export, and 1.3.0 takes this
   document's rule. The job must still be switched on.) The purge is no
   longer behind its switch for a DPA practice: since 12 October 2026 a
   clinic on the DPA or BAA 1.3.0 or later is purged every night whatever
   the `retention-purge` switch says (gate 9).
2. **Retention during the term: resolved** (12 October 2026). BAA 1.2.1
   (A5) says healdesk "keeps transcripts and conversation records for 90
   days, which Practice may shorten in its portal", and 1.3.0's clause 11
   states each period. The DPA stated none during the term, only "no call
   audio is kept at all", while a DPA practice was purged nightly at 90 days
   (gate 9; `purgeIsPromised`). Clause 10, "Minimum necessary", now states
   the purge's periods in 1.3.0's terms: a conversation with its transcript,
   and an appointment record, 90 days after it took place or its time; a
   booking request 90 days after the latest of its dates; a client's contact
   details while any of those is kept and in any case 90 days after they were
   last recorded or changed; backup copies within 35 days of a deletion; and
   the Term clause for after the Services end. Where 1.3.0 says "Practice may
   shorten these periods in its portal", the DPA says what the portal does:
   "Practice may shorten the period for transcripts in its portal". The
   portal's Settings has that control, 90, 30 or 7 days
   (`clinic_settings.transcript_retention_days`), and the purge reads it: it
   shortens the transcript clock, never lengthens it past the clinic's own,
   and reaches no other record. No portal control shortens the other
   periods, so 1.3.0's "these periods" says more than the portal does; that
   is reported for the BAA's owner. `docs/dpa-v1.0.0.txt` and the golden
   hashes were regenerated; no BAA hash moved.
3. **Deletion on request: resolved** (12 October 2026, BAA 1.3.0 release gate
   6). `eraseContact` had no caller. The care page's "Delete a person" (ops
   `erasePerson`) now runs it and deletes what it did not reach: the
   client's raw payloads, the drafts and messaging threads that are theirs
   alone, and their suppressions, consent records and contact attempts. A
   booking request goes only with the client it names. It records the request without the client and shows each
   subcontractor step outstanding until recorded, with the ten-business-day
   deadline; docs/handover.md has the runbook.
4. **BAA 1.2.1's minimum-necessary list is narrower than the booking
   catalogue** (§ 5, item 4).
5. **`chat_threads` at destruction: resolved.** Package B (the Stripe build,
   on main since 249e3a9) writes it, keyed by a hash of the sender's platform
   id, which for WhatsApp is a telephone number (0050 made it a keyed
   `identifierRef()` HMAC, since a plain digest of a number can be reversed
   by trying every number). `destroyClinicData` now deletes it and
   `meta_inbound_messages`, and `app_mark_clinic_destroyed()` refuses to
   record a destruction while either holds a row (drizzle/0054), so clause
   17's "no Client Information except" holds for both.
6. **The calendar election: the DPA's form exists, and nothing can record
   it yet.** `calendar-election/1.0.0` takes the place of the calendar
   clause "of the Business Associate Agreement" and calls the person a
   booking is for a patient, so it cannot be handed to a DPA practice. The
   DPA's own form, `calendar-election-dpa/1.0.0`, is now drafted beside it
   (§ 2), unreleased, and `calendarElectionFor(agreementVersion)` /
   `prepareCalendarElectionFor` pick the form by the agreement's kind. What
   remains: the owner releases the form with the DPA (it is in Appendix B of
   the review file); and the election rows and their writer (the calendar
   session's plan C6 and C7, C18 in the portal) take the form through
   `calendarElectionFor`, never `currentCalendarElection()` alone, and count
   a draft only for a demo clinic. Until both, a DPA practice cannot give a
   second location calendar terms or change a location's booking system or
   account kind, which is the refusal § 12.14 asks for, and it holds today
   because nothing can: no election can be recorded (C6/C7 are not on
   main), `addLocation` answers "not_available", `createLocationClinic` is a
   stub behind `LOCATION_CLINICS_READY = false`, and nothing writes a
   location's booking system. Whoever lands C7, C18, Package C's
   `addLocation` or the real `createLocationClinic` keeps that refusal for a
   DPA organisation until the form is released.
7. **The Payments clause describes a link nothing creates** (package D;
   agreement-changes.md § 12.11, item 9). Inherited from the quote.
8. **The state-law clause names "Practice's portal settings"**, a portal not
   built yet (Gate A includes the portal, M3).
9. **Signing, the PDF and the copy email: built, and refused until the
   release.** `validateSignRequest` and `signAgreement`
   (`apps/app/src/lib/agreements.ts`) sign a DPA through
   `prepareDpaAgreement`: rendered by `prepareDpa`, stored as `dpa/1.0.0`
   (so the generated `agreement_kind` is `dpa`) with the DPA's own variables
   and, beside them, `isCoveredEntity: false`, the platform sent and the
   variant. It meets the BAA path's refusals by field, its displayed-hash
   comparison and `signableDpaTemplate`, the BAA's released-templates-only
   rule for the DPA's one version. The PDF (`lib/agreements/pdf.ts`) and the
   copy email (`lib/email/agreement-copy.ts`) name the document by the kind
   its version carries (`healdesk-dpa-1.0.0-<date>.pdf`, "Your signed data
   protection agreement for …"); a BAA's copy keeps its bytes. In apps/web
   the agreement step has the DPA's entry (`dpaAgreementCopy`, whose preview
   a test holds byte for byte against the server's render for every DPA
   practice, booking system and account kind) and `/api/agreement` forwards
   it. While `approvedByCounsel` is false, every DPA request is refused as it
   was (`apps/app/tests/dpa-signing.test.ts`, which signs with the release
   stood in for and provisions the row once `getDpaTemplate` reports it
   released).
10. **Terms §§ 7, 9 and 14 name only the Business Associate Agreement.** The
    plan's "Data Agreement" definition (A6) is what makes them read for a DPA
    practice; until it lands, Terms § 7's "destroy … when and as the Business
    Associate Agreement says" points a DPA practice at the wrong document.
11. **Go-live refuses every DPA practice today.** Main's 0048 made
    `app_mark_clinic_production` accept only the BAA versions on
    `app_baa_version_acceptable()`'s allow-list, and `goLivePreconditions`
    and the ops card read `isBaaVersionAcceptable()`, which knows only BAA
    templates. A practice bound to `dpa/1.0.0` therefore reads as superseded,
    and the console tells the operator to have it sign the BAA, which
    provisioning and the supersede both refuse for a vet. Releasing the DPA
    needs a migration that leaves 0048's BAA floor intact and accepts a
    released `dpa/*` version where `app_agreement_kind_sufficient` holds,
    with the TypeScript checks to match and tests that take a vet and a "No"
    practice live (TODO in 0051 and in `goLivePreconditions`). The PHI gate
    asks the sufficiency rule on every write already.
12. **The "United States infrastructure" and "no call audio" sentences**
    depend on Retell's region and recording settings, which are unconfirmed
    (agreement-changes.md R6), exactly as in 1.2.1.
13. **The Anthropic sentence describes a business associate agreement that is
    not yet signed** (brief.md risk 2). Gate A's `platform_compliance`
    attestation is what makes it true before the first DPA is signed.
14. **The public notice period.** `/subprocessors` and `/trust` promise every
    customer fifteen days (`POLICY.subprocessorNoticeDays`); the DPA gives
    24 hours, as BAA 1.3.0 does (agreement-changes.md § 12.11, item 10).
15. **The telephone number kept after a deletion** (13, 17): resolved on
    12 October 2026. Both sentences said the number of a client whose
    information was deleted is kept as the record of the request, as
    `eraseContact` kept it in `suppressions`. Gate 6 records the request in
    `erasure_requests` with no number, address or name, and keyed references
    for the 35-day backup window only; gate 7 has destruction take
    everything else. Clause 13 now says what a deletion keeps, in those
    terms, and clause 17 that after destruction healdesk holds no Client
    Information, with no exception. `docs/dpa-v1.0.0.txt` and the golden
    hashes were regenerated with them; no BAA hash moved. The review of the
    same day found two copies the sentence did not cover. "Who asked" was
    free text, screened only for numbers and addresses, so a name could be
    stored in the record and its audit row: it is now one of three, chosen,
    never typed. And the runbook kept the practice's own message, which
    names the client, for the 35 days as the restore fallback: clause 13
    now says so, exactly (that message, those 35 days, only to delete again
    after a restore). 1.3.0's clause 4(c), "keeps only a record of the
    request, for no longer than it needs one", already covers it.
16. **Overlaps not reconciled.** Permitted uses (4), confidentiality (14) and
    the subcontractor flow-down (11) also overlap the shared clause (its
    purposes, its item a, its subcontractor paragraph). § 12.14 named only
    the instructions, requests and assistance clauses; these three agree
    with the shared clause, and its precedence sentence governs where they
    touch. Reconcile them in the same way if counsel prefers one statement
    throughout.
17. **The refund on a termination for healdesk's breach.** BAA 1.3.0 refunds
    a termination for healdesk's violation as well as one on objection
    (HRC-07, an owner flag). The DPA now refunds the objection, which "without
    penalty" promises, and leaves its termination for a material breach
    without a refund term. Recommended for the owner: the same refund, which
    would also say that terminating for breach ends the Services that day.
18. **"Services" and "Fees" are left to the Terms, which define neither**
    (ICD-19, ICD-32 for the BAA). The Term clause's refund and the new
    precedence over the Terms read the words as the Terms use them; BAA
    1.3.0 defines both, and says the Services end when the subscription
    does. Recommended before release: the same definitions here.
19. **The change-in-law termination** points at the Term clause without
    granting the right or saying the Services end (ICD-30 for the BAA).
20. **The data sources list the clients only** (PT-04, ICD-11 for the BAA):
    "the only Client Information healdesk receives is what clients
    themselves give it", where 1.3.0 lists staff entries and the payment
    processor's notice too. True while staff enter nothing and no deposit
    link exists; to be widened before either does.
21. **The incident deadline in the console** (12). The runbook works to 24
    hours for every clinic, but `notifyDeadline` still gives a security
    incident and an improper use or disclosure five business days. Gate 5
    (another branch) brings it to 24 hours for every class; the DPA should
    not be released before it lands.
22. **Correction on request: the code is built** (13; 12 October 2026, BAA
    1.3.0 release gate 8). The care page's "Amendments" appends a
    correction to a booking request or a conversation (`record_amendments`,
    append-only, on a record of the same clinic, removed only with that
    record) and gives `amendContact` its operator path; both exports carry
    each correction beside its record, and the desk's view of a booking
    request says how many there are, never their words. Still open: wherever the portal (M5) shows or exports
    a request or a conversation, the correction must show with it, and
    counsel's view of an appended correction under a state privacy law's
    right to correct. What the gap said before: the clause promises
    a correction as Practice directs: in healdesk's copy where the record can
    be changed, and otherwise appended and linked. `amendContact` corrects a
    contact in place and is tested, but no script or ops operation runs it,
    as with deletion (gap 3). Nothing can append a correction to a booking
    request, whose facts 0039's trigger freezes, or to a conversation's
    record, and no export would carry one. Gate 8 (agreement-changes.md
    § 12.14) builds that amendment record, linked to the booking request or
    conversation it corrects and carried by `exportPatient`, `exportClinic`
    and the portal export. It serves both agreements, since none of those
    reads the agreement's kind. Both agreements say every later use carries
    the correction, not only every export, so wherever the portal shows a
    booking request or a conversation the correction must show with it,
    which gate 8's list does not yet name. The DPA should not be released
    before gate 8 lands and `amendContact` has an operator path. Counsel
    should also say whether an appended correction meets a state privacy
    law's right to correct (§ 5, item 15).

## 7. The 1 October § 9 decision, narrowed

On 1 October 2026 the owner adopted "no separate DPA": a practice outside
HIPAA signs the BAA, which its clause 2 makes "a data-protection agreement on
the same terms", and a state-law clause carries what state law asks of a
processor (agreement-changes.md § 9). The funnel plan of 6 October narrows
that decision rather than reversing it:

- it still holds for every practice that signs a BAA while not covered: a
  `hipaa` specialty that answers "No", and every "No" before the DPA is
  released. The state-law clause stays in BAA 1.3.0 for them;
- it no longer holds for a veterinary practice, to which a BAA names duties
  neither side has, or for a `hipaa-if-covered` practice that answers "No":
  once the DPA is released, both sign the DPA.

## 8. Open questions, by the brief's risk rows

These are recorded in [brief.md](./brief.md) rows 3, 5, 6 and 10, each with
its trigger.

- **Row 3, the one-way indemnity and the exclusion.** The DPA carries the
  same allocation. A practice outside HIPAA has less regulatory reason to
  accept it, and the warranty in the status clause makes the indemnity reach
  the practice's own misstatement of its status. Trigger: the first DPA
  practice's redline.
- **Row 5, a UAE processor.** The UAE's personal data law
  (Federal Decree-Law 45/2021) excludes health data governed by other
  legislation; a veterinary client's data, or a non-covered practice's, may
  not be "health data under other legislation" in the way PHI is, so the
  exclusion that row relies on may not reach DPA data. Not read this session.
  Trigger: the first DPA practice's counsel asking where the data and the
  contracting party sit.
- **Row 6, AI disclosure.** Utah's regulated-occupation rule may reach a
  veterinary practice, a licensed occupation in Utah, as it reaches a
  clinic. Trigger: the first Texas or Utah DPA practice, veterinary
  included.
- **Row 10, practices outside HIPAA.** The state-law clause the DPA quotes
  was drafted without re-reading Cal. Civ. Code § 1798.140(ag) and 11 CCR
  § 7051 (risk R5). California also has a veterinary confidentiality statute
  (Business and Professions Code § 4857,
  https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=BPC&sectionNum=4857,
  reported, not read this session), which the DPA's veterinary paragraph
  addresses only in general terms. Many small practices may fall below the
  California statute's thresholds for a "business", which would make its
  service-provider terms harmless but unnecessary. Triggers: the first DPA
  practice in Washington, Nevada or Connecticut; the first California
  veterinary practice.

## 9. Release checklist (Gate A)

- [ ] The owner reads `docs/dpa-v1.0.0.txt` and sets `approvedByCounsel`
      true on `DPA_TEMPLATES[0]`.
- [ ] Vet readiness: the veterinary urgent set and its fixed reply, the
      emergency referral number (wizard 2.5), vet practice cases, client
      wording (`audienceFor`), and animal clinical content caught at the Meta
      boundary, which clause 15 promises.
- [ ] The animal's name and species in the booking catalogue, if the owner
      wants them collected (the text allows it; nothing asks for them yet).
- [x] The signing path, PDF and copy email for a DPA (gap 9).
- [ ] The calendar election able to amend a DPA (gap 6): the form is
      drafted (`calendar-election-dpa/1.0.0`); its release, and election
      rows that take it through `calendarElectionFor`, remain.
- [x] Gap 2 resolved: the DPA states the purge's periods, and that the
      portal shortens transcripts (12 October 2026). (Gaps 3 and 5 are
      resolved.)
- [x] Corrections have code behind them (gap 22): gate 8's amendment record,
      appended to and linked with the booking request, conversation or
      appointment it corrects and carried by both exports and the desk's
      view; an operator path for `amendContact`, which can also clear a
      field the practice names (12 October 2026). An appointment takes an
      appended correction rather than a rewrite, because it is the booking as
      the practice's calendar holds it; counsel may want "such as a booking
      request or the record of a conversation" to name it.
- [ ] The portal (M5) shows each correction beside every request or
      conversation it shows or exports, and counsel gives a view of an
      appended correction under the state privacy laws (gap 22).
- [ ] `offboarding-destroy` switched on for live clinics (gap 1);
      `retention-purge` runs for a DPA practice whatever its switch (gate 9),
      and is switched on at the release for every other clinic.
- [ ] Go-live admits a released DPA (gap 11): the migration, the TypeScript
      checks and the tests that take a vet and a "No" practice live.
- [ ] The covered-entity notice has code behind it. Clause 2 promises that
      from the practice's notice the assistant pauses until the BAA is
      signed, with forwarded calls passing to the direct line. Nothing
      implements that yet: build it as one audited operator action, in this
      order: pause (`ai_paused_at`), record `is_covered_entity`, send the
      re-sign link, then `supersedeAgreement`. Or change clause 2 to match.
- [x] Destruction works for a practice with a confirmed booking request
      (drizzle/0054_booking_request_destruction, 7 October 2026). A
      confirmed request's `appointment_id ON DELETE SET NULL` collided with
      its shape CHECK and its no-rewrite trigger, so destruction, erasure
      and the purge failed for any practice that had confirmed one. Booking
      requests now go first, through three functions scoped to the
      practice: `app_destroy_booking_requests()` (once offboarding started
      thirty days before by the database's clock), `app_erase_contacts()`
      (a person's own requests, bookings, calls and contact together) and
      `app_purge_booking_requests()` (by dates nothing can move). The
      request's `appointment_id` and `contact_id` are ON DELETE NO ACTION,
      and a deleted request's id and token can never be used again
      (`booking_request_keys`). tests/booking-request-destruction.test.ts
      pins each.
- [x] The DPA carries BAA 1.3.0's fuller state-law clause
      (`stateLawClauseBody`, since the BAA's pre-release redraft, c926414).
- [x] The funnel's pre-release text (agreement-changes.md § 12.14, "The
      funnel's DPA"): "calendar election" defined, the 24-hour rule,
      "without penalty" given its effect, the instructions, requests and
      assistance clauses reconciled, and a correction the record cannot take
      appended and linked (§ 5, items 10 to 15).
- [x] Gates 6 and 7 land, and the telephone-number sentences in clauses 13
      and 17 change with them (gap 15, 12 October 2026).
- [ ] Gate 5 lands (gap 21).
- [ ] The owner decides the refund on a termination for healdesk's breach,
      and the definitions of "Services" and "Fees" (gaps 17, 18).
- [ ] The Terms read for a DPA practice (A6, "Data Agreement"): §§ 1, 7, 9,
      11, 12, 14 and 19, Privacy § 12 and `/data-deletion` name only the BAA
      today, and a vet's clients are called patients.
- [ ] `/subprocessors` and `/trust` say the same notice period as the
      agreements in force (gap 14).
