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
- **Quoted, not retyped.** The state-law processor clause and the Payments
  clause are `STATE_LAW_CLAUSE_BODY` and `PAYMENTS_CLAUSE_BODY` from
  `baa.ts`. The state-law text is used with exactly two edits, recorded as
  `DPA_STATE_LAW_EDITS` and pinned by a test: its first words say "Client
  Information" where the BAA says "patient information", and its last
  sentence ("…apply to that information as they apply to PHI") is dropped,
  because here the clauses it names govern Client Information already. The
  notice of a new subcontractor is `subprocessorNoticeClauseBody()`. The
  party, notice address and Delaware law are `AGREEMENT_PARTY`, exported from
  `baa.ts` for this purpose without changing any BAA byte.
- **One calendar clause, chosen as BAA 1.3.0 chooses it.**
  `selectCalendarClause` picks covered, uncovered or not-used from the
  booking system and the Google account kind, under the same clause ids, so a
  location's calendar terms read the same off any acceptance. The words are
  the selector's, with one change: the person a booking is for is a "client"
  (`CALENDAR_PERSON_NOUNS`, two phrases), because a veterinary practice's
  agreement must never call a person a patient. BAA 1.3.0's location
  paragraph follows, as it does there. A test rebuilds the BAA 1.3.0 clause
  from the DPA's, for every booking system and account, word for word.
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
| 1 | Definitions | 1.2.1's, plus "client", "Client Information", "security incident" and "breach" in state-law terms; a veterinary practice's clients are the animals' owners or keepers, never the animals |
| 2 | Practice's status | Replaces practice-status. Veterinary: animals are outside HIPAA. Otherwise: the practice warrants it sends no covered transaction, must say before that changes, and from that notice the assistant pauses until the BAA replaces the DPA, with forwarded calls passing through to the direct line |
| 3 | Practice's instructions | 1.1.0's practice-duties, in state-law terms, plus the practice's own notice and consent duties |
| 4 | Permitted uses | 1.0.0's permitted-uses, narrowed to providing the Services, security and the law. **No aggregation permission** (see § 5) |
| 5 | Where Practice is not a covered entity | BAA 1.3.0's state-law clause, quoted with the two edits |
| 6 | Payments | BAA 1.3.0's, verbatim |
| 7 | What healdesk reads | BAA 1.3.0's data-sources clause in client words |
| 8 | Practice's Google Calendar | BAA 1.3.0's chosen clause (see § 2) |
| 9 | Safeguards | The Security Rule applied as if Client Information were ePHI; 1.2.1's second and third paragraphs (A4's email sentence included) |
| 10 | Minimum necessary, and who receives Client Information | The booking catalogue as a ceiling (not 1.2.1's list: see § 6, gap 4), the animal's name and species for a vet, the opening-line disclosure, no call audio; then disclosure by category |
| 11 | Subcontractors | 1.2.1's flow-down, without the HIPAA citations; Anthropic's retention in 1.2.1's words; the 24-hour notice |
| 12 | Reporting incidents and breaches | 1.2.1's three clocks and report contents, without 45 CFR 164.410 |
| 13 | Clients' requests | The state-law counterpart of patient-rights: access, correction, deletion, and the five-day pass-through |
| 14 | Confidentiality | New; a veterinary paragraph |
| 15 | Not authorised | 1.2.1's four prohibitions; Meta "is not healdesk's subcontractor and is not bound by this agreement" |
| 16 | Assistance and audit | The records-to-HHS clause, made general |
| 17 | Term | Written from the offboarding clock in the code (§ 4), not 1.2.1's "within thirty days" |
| 18 | Liability | 1.2.1's allocation and Terms §§ 13–14, in state-law terms |
| 19 | Notices and law | 1.2.1's, without HIPAA; Delaware; the notice address is the practice's one address |

Not carried: acting-in-your-place (164.504(e)(2)(ii)(H)) and records-to-HHS,
which are HIPAA's; own-use's aggregation permission (§ 5).

## 4. Every sentence that rests on a fact in the code, and where it was read

Read in the code on 6 October 2026, at origin/main d652a0b.

| Sentence (clause) | The code fact | Where |
| --- | --- | --- |
| Destruction "runs once a day" (17) | `offboarding-destroy` runs at hour 4 in the scheduler tick, when the job is switched on | `apps/app/src/lib/scheduler/tick.ts:75` |
| Destroyed "once thirty days have passed … if the export has been delivered … otherwise at the first run after the export is delivered … in any case … once ninety days have passed" (17) | `DESTROY_AFTER_DAYS = 30` sets `destroy_after`; `DESTROY_WITHOUT_EXPORT_AFTER_DAYS = 90`; `dueForDestruction` | `apps/app/src/lib/offboarding/offboarding.ts`; pinned by `apps/app/tests/agreement-kinds.test.ts` |
| The clock starts "when the Services end" (17) | `startOffboarding` on `customer.subscription.deleted`, or an operator's `startOffboarding` | `apps/app/src/lib/billing/events.ts`, `apps/app/src/lib/ops/api.ts` |
| "Within thirty days … deliver … an export … in a usable electronic form" (17) | Terms § 7 promises it; `exportClinic` (`npm run patient-export -- --all`) produces it and ops `markExportDelivered` stamps it | `apps/web/src/app/terms/page.tsx`; `apps/app/src/lib/patient-rights/export.ts`; `apps/app/scripts/patient-export.ts` |
| Calls pass through to the direct line "for as long as the Terms provide" (17) | Terms § 7, `POLICY.forwardingPassThroughDays = 30` | `apps/web/src/lib/legal.ts` |
| Destruction "deletes the conversations, bookings, booking requests and contact details … and the credentials" (17) | `destroyClinicData` deletes reconciliation exceptions, transactions, appointments, conversations, Meta booking drafts, contacts (booking requests go with them by cascade), webhook payloads, provider connections and closures | `offboarding.ts` |
| "no Client Information … except the telephone number of any client who asked to have their information deleted" (17), and the same in (13) | `eraseContact` leaves a `suppressions` row, which destruction keeps. Nothing else that survives destruction holds client data today: `suppress`/`recordAttempt` have no callers, and `consent_records`, `contact_attempts`, `chat_threads`, `usage_events`, `deposit_payments` and `meta_inbound_messages` have no writer yet | `apps/app/src/lib/retention/purge.ts`; `apps/app/src/lib/compliance/contact-policy.ts` |
| "The signed copy … kept for at least six years after it ends" (17) | `retention_eligible_at` is a floor; healdesk_app has no DELETE on `baa_acceptances`; nothing deletes one | `drizzle/0025_baa_retention.sql`; `apps/app/src/lib/agreements/retention.ts` |
| What the assistant asks for (10) | `BOOKING_FIELDS`: the locked four and the five a practice may switch on; `EXCLUDED_FIELDS` has no email | `packages/catalog/src/booking-requirements.ts` |
| The opening line says AI, and on a call that it is transcribed (10) | The fixed disclosure lines | `apps/app/src/lib/compliance/disclosure.ts` |
| Each appointment carries a first name, the service and the time; private; no invitees or reminders (8) | The event builder | `packages/connectors/src/google/event.ts` |
| An email that cannot negotiate encryption "is failed, not sent" (9) | SES configuration set with `TlsPolicy=REQUIRE` | `apps/app/src/lib/reporting/deliver.ts` |
| The notice address is "also the address of Practice's healdesk account" (19) | The checkout intent requires the agreement's signer to be the buying address; provisioning makes that address the clinic's one sign-in | `apps/app/src/lib/checkout/intents.ts` (`checkIntentAgreement`); `apps/app/src/lib/provisioning.ts` (`ensureOwner`) |
| From the covered notice, the assistant is paused until the BAA replaces the DPA (2) | The database refuses a DPA clinic's client data from the write that records `is_covered_entity` as anything but false (`app_clinic_accepts_phi`, drizzle/0051); `app_supersede_agreement` puts the BAA in force; the pause itself is `clinic_settings.ai_paused_at` | `apps/app/drizzle/0051_agreement_kinds.sql`; `apps/app/src/db/schema.ts` |
| Anthropic's 30 days, two years when flagged, no training (11) | BAA 1.2.1's sentence, from Anthropic's own pages read 1 October 2026 (agreement-changes.md § 4); pinned by a test against the 1.2.1 rendering | `packages/catalog/src/baa.ts` |
| 24 hours' notice by email, with the right to object (11) | `SUBPROCESSOR_NOTICE_HOURS = 24` | `packages/catalog/src/subprocessor-notice.ts` |

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
   next daily run, not on a calendar day.
7. **Meta is "not healdesk's subcontractor and not bound by this
   agreement"**, not "signs no business associate agreement": the DPA is not
   about BAAs, and Meta does publish data-processing terms for some products.
8. **Not every BAA sentence survives.** HIPAA citations, the accounting of
   disclosures and acting-in-your-place are HIPAA's; the DPA neither claims
   them nor denies them.
9. **The supersede function allows DPA→BAA and BAA→BAA only.** DPA→DPA (a
   newer DPA re-accepted) is refused until a DPA 1.1.0 exists to decide it;
   that fails closed.

## 6. Gaps found between the code, the plan and the text

1. **Thirty days to destroy (BAA 1.2.1 and 1.3.0).** The BAA promises
   destruction "within thirty days of termination"; the code destroys at
   thirty days only once the export has been delivered, and otherwise at
   ninety, and only when the `offboarding-destroy` job is switched on (it is
   seeded off). The DPA states the code's clock. The BAA still needs the same
   correction (agreement-changes.md § 12.11, item 8), and the job must be on
   before the first clinic's offboarding.
2. **Retention during the term.** BAA 1.2.1 (A5) says healdesk "keeps
   transcripts and conversation records for 90 days, which Practice may
   shorten in its portal". Since main's 0048 the code agrees on the number:
   `clinics.retention_record_days` defaults to 90, and every clinic left at
   the old 730 was moved to 90. What is still untrue: nothing in the
   application can shorten either setting (no portal control, no ops
   operation), and the `retention-purge` job is seeded off, so nothing is
   deleted at 90 days either. The DPA states no period during the term, only
   "no call audio is kept at all", although the spec wants a stated period
   for data handled as PHI. Before the release the owner decides: state "90
   days" once the purge runs for live clinics (and "which Practice may
   shorten" only once the portal control exists), regenerating the hashes,
   or release without a period.
3. **Deletion on request has no operator path.** `eraseContact` exists and is
   tested, but no script or ops operation runs it, and it leaves a client's
   half-finished Meta booking draft (`meta_booking_drafts`) in place. The
   DPA's clause 13 and the state-law clause promise deletion within ten
   business days; before release, give the operator a script like
   `patient-export` and have it delete the draft.
4. **BAA 1.2.1's minimum-necessary list is narrower than the booking
   catalogue** (§ 5, item 4).
5. **`chat_threads` is not destroyed.** It has no writer yet, but package B
   will write it, keyed by a SHA-256 of the sender's platform id; for
   WhatsApp that id is a telephone number, and a digest of a telephone
   number can be reversed by trying every number. `destroyClinicData` must
   delete it before package B ships, or clause 17's "no Client Information
   except" becomes false.
6. **The calendar election names only the BAA.** `calendar-election/1.0.0`
   says it takes the place of the calendar clause "of the Business Associate
   Agreement", and its last sentence defines "this agreement" as that BAA.
   The DPA's calendar clause, like BAA 1.3.0's, sends a change of booking
   system or a second location to a calendar election. Before the DPA's
   release the election has to name the DPA too, or have a DPA version.
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
- [ ] The calendar election able to amend a DPA (gap 6).
- [ ] Gaps 2, 3 and 5 resolved, or the text changed to match.
- [ ] `offboarding-destroy` and `retention-purge` switched on for live
      clinics (gap 1).
- [ ] Go-live admits a released DPA (gap 11): the migration, the TypeScript
      checks and the tests that take a vet and a "No" practice live.
- [ ] The covered-entity notice has code behind it. Clause 2 promises that
      from the practice's notice the assistant pauses until the BAA is
      signed, with forwarded calls passing to the direct line. Nothing
      implements that yet: build it as one audited operator action, in this
      order: pause (`ai_paused_at`), record `is_covered_entity`, send the
      re-sign link, then `supersedeAgreement`. Or change clause 2 to match.
- [ ] Destruction works for a practice with a confirmed booking request.
      `destroyClinicData`, `eraseContact` and the purge delete appointments
      before booking requests, and a confirmed request's
      `appointment_id ON DELETE SET NULL` collides with its shape CHECK and
      its no-rewrite trigger, so the delete fails. This breaks clause 13's
      and clause 17's promises, and the BAA's identical ones.
- [ ] Decide whether the DPA carries BAA 1.3.0's fuller state-law clause:
      the specified business purposes, the data categories, the service
      provider designation, the deletion deadlines, immediate breach notice
      and the assessment right. Today it quotes only the shared paragraph,
      whose generic purposes 11 CCR § 7051(a)(2) does not accept, for exactly
      the practices that clause exists for.
- [ ] The Terms read for a DPA practice (A6, "Data Agreement"): §§ 1, 7, 9,
      11, 12, 14 and 19, Privacy § 12 and `/data-deletion` name only the BAA
      today, and a vet's clients are called patients.
- [ ] `/subprocessors` and `/trust` say the same notice period as the
      agreements in force (gap 14).
