# Decisions and open risks: healdesk v1 legal position (launch step 1.14)

> **Adopted by the owner on 1 October 2026 without external counsel review.
> Residual risks are listed in the Review log. Not legal advice.**

One page. What was decided, what stays open, who owns each open risk, how it
is mitigated, and what would force a lawyer's engagement. Detail and sources
are in the three files this folder holds; `README.md` says what the folder is.

## The company in one paragraph

healdesk is an AI assistant for US cash-pay elective clinics. Inbound only:
calls the clinic forwards (voice on Retell), chat on the clinic's site, and
Instagram, Messenger and WhatsApp messages. It books into the clinic's own
Google Calendar and can send a deposit link through the clinic's own gateway.
It never contacts a patient first, sends no SMS and keeps no call audio. The
seller is **Viixi FZC** (Sharjah Publishing City Free Zone, UAE), trading as
healdesk, signing a business associate agreement with each clinic at
checkout. No clinic has gone live; no real patient data has been processed.

## Decisions taken (1 October 2026)

| Decision | Record |
| --- | --- |
| BAA 1.2.0 published without external counsel and replaced by 1.2.1 the same day for five accuracy fixes (A1–A5); 1.0.0 withdrawn. Anthropic named with 30-day retention for abuse detection and no training, with the exception for flagged or legally required content Anthropic's own terms carry; callbacks, Cal.com and the direct-booking addendum removed; Google Calendar clause; one liability allocation (excluded where the law allows, capped at twelve months' Fees otherwise, carve-outs for wilful misconduct, gross negligence and non-limitable liability; the clinic indemnifies, breach investigation and notification costs included; a regulator's civil money penalty on healdesk cannot be shifted and the text says so) | [agreement-changes.md](./agreement-changes.md) §§ 1–3 |
| Terms: forwarded calls pass straight through to the clinic's direct line on pause, suspension, allowance exhaustion, failure or exit, and for at least 30 days after exit; never a dead line | agreement-changes.md § 7 |
| First-month guarantee adopted: 14-day refund kept; 10 s / 60 s / 5 s; one refund per practice; annual plans one month at the annual per-month price; claim-based, 30 days, account owner; our records plus any carrier record; vendor failures are ours; force majeure does not apply; sole remedy for a miss in month one, outside § 13 | [guarantee-and-refund.md](./guarantee-and-refund.md) |
| Opening lines fixed ("representative" → handover, call back within a day; web chat the same); live transfer off by default | [state-disclosure.md](./state-disclosure.md) |
| Only compliance claim on the site: "we sign a business associate agreement and handle patient data under it"; never "HIPAA compliant" (confirmed by grep this session: no such claim renders) | `apps/web` |
| BAA 1.2.2 released on 9 October 2026 without external counsel, replacing 1.2.1 before any clinic signed it: the subcontractor list given on written request (no public `/subprocessors` page); hello@healdesk.io as the only email address, the notice address included; breach, security-incident and improper-use reports "without unreasonable delay and in no case later than 60 calendar days" (the spec's wording; the 24-hour target stays internal). The go-live floor moved to 1.2.2 | agreement-changes.md § 13 |

Decisions taken in this review by reasoning, for the owner to confirm:
the tightened guarantee text and the one setup-fee exception; the one Meta
rule (no appointment details, no treatment names, no promotions, phone number
on request); Google Calendar event contents and read scope; 30-day
destruction kept; the 15-day subprocessor notice sent now; 1.0.0 signers
re-accept 1.2.0 before go-live; a state-law clause in BAA 1.2.1 instead of a
separate DPA; a written AI notice template for clinics; the closing line and
the three words "run by our service providers" (recommended, not adopted).

**Narrowed on 6 October 2026: no separate DPA.** The funnel plan (Part L)
gives a veterinary practice, and a practice HIPAA reaches only if covered
that answers "No", the healdesk Data Protection Agreement instead of the BAA,
once the owner releases it ([dpa.md](./dpa.md), drafted as `dpa/1.0.0`). The
owner released it on 20 October 2026, without external counsel
([agreement-changes.md](./agreement-changes.md) § 18). The 1
October decision still holds for every other practice that signs the BAA
while not covered, and the state-law clause stays in BAA 1.3.0 for them;
dpa.md § 7 records the narrowing.

## Open risks, ranked by exposure

| # | Risk | Owner | Mitigation in place | Trigger that forces a lawyer |
| --- | --- | --- | --- | --- |
| 1 | **Meta may not allow the product on Messenger and Instagram.** Developer Policies § 5.6.5 (3 Feb 2026): "Don't use Messenger and/or Instagram Messaging features … to facilitate direct conversations between people and healthcare providers or to send or collect any patient data obtained from healthcare providers." WhatsApp's policy (23 Sep 2026) bars health-related information where regulations require heightened handling, requires human escalation paths, and lists "Medical and healthcare products" among things a business may not promote; Meta's platform terms say it "is not a business associate" and WhatsApp "is not HIPAA-compliant". The AI-Providers bar does not reach a clinic-specific booking assistant | Owner | Channels scoped non-clinical; no treatment names, no appointment details, no promotions on Meta; phone number given on request (the WhatsApp escalation path); App Review submission to describe appointment scheduling for a business, with the clinical-content boundary shown; ask Meta Developer Support in writing before submitting; do not sell the Meta SKU on its own until the permissions are granted; terms § 9 lets the clinic switch the channels off | App Review rejection or any policy enforcement; a clinic buying Meta only. Sources: https://developers.facebook.com/devpolicy/ ; https://whatsappbusiness.com/policy/ ; https://www.facebook.com/legal/Meta-Terms-for-WhatsApp-Business-Platform |
| 2 | **BAA 1.2.1 corrected the five accuracy defects found in 1.2.0** (agreement-changes.md A1–A5) the same day, before any clinic signed; the terms, the subprocessor page and the incident procedure carry the same corrections. What remains is the drafted-not-shipped material: the Payments clause and the state-law clause for clinics outside HIPAA, now in the unreleased BAA 1.3.0 draft (agreement-changes.md § 12), and the Anthropic BAA itself is not yet executed (launch step 0.9), so clause 11 describes an arrangement not yet signed | Owner, engineer | 1.2.1 published and frozen; 1.2.0 frozen for anything signed against it; no real patient data flows until the BAA chain is complete | Sign the Anthropic BAA before the first real clinic signs; an OCR inquiry; a clinic counsel's redline |
| 3 | **The one-way indemnity, liability exclusion and no insurance** may be resisted or, in a dispute, not fully enforced. The DPA carries the same allocation, and its status warranty brings a practice's own misstatement of its status inside the indemnity; a practice outside HIPAA has less regulatory reason to accept it ([dpa.md](./dpa.md) § 8) | Owner | Carve-outs for gross negligence and wilful misconduct; express reach to alleged negligence (Delaware's clear-statement rule); the CMP sentence; the BAA, the DPA and the terms say the same thing | First clinic redline (negotiate; a mutual cap is the usual landing); the first DPA practice's redline; any claim |
| 4 | **Call transcription consent where the announcement must itself be recorded** (Washington RCW 9.73.030(3), Connecticut § 52-570d(a)) with no audio kept; **California § 631 after *Ambriz*** turns on a vendor's capability to use content | Owner, engineer | Disclosure first on every call; transcript carries it with a timestamp; the fixed disclosure audio asset retained; vendor no-use contracts kept by version; three-word addition recommended | First clinic in Washington or Connecticut before voice goes live; a CIPA demand letter |
| 5 | **A UAE business associate.** HIPAA binds it wherever it sits, but OCR enforcement abroad, enforcement of a Delaware judgment in the UAE, service of process (the UAE is not in the Hague Service Convention), the UAE data law's reach (Federal Decree-Law 45/2021 applies to a controller or processor located in the State processing data of subjects outside it, with exclusions for health data under other legislation; executive regulations' status unverified), and whether the SPC licence lists software and marketing services, are all unsettled. For the DPA: that law's exclusion for health data governed by other legislation may not reach a veterinary client's data or a non-covered practice's, which no US health statute governs as it governs PHI, so the UAE law may reach DPA data more squarely than PHI (not read this session; [dpa.md](./dpa.md) § 8) | Owner | PHI hosted in AWS us-east-1; every PHI vendor is US; Delaware law and courts; the prepared answer in agreement-changes.md § 3 (clause 18) and this row; recommended: appoint the Delaware registered agent as agent for service of process; owner reads the licence for the activity list; DPA client data is held on the same US infrastructure as PHI | A clinic's counsel requiring a US contracting entity or a certificate of insurance; a DPA practice's counsel asking where the data and the contracting party sit; a UAE Data Office inquiry or issuance of the executive regulations; the licence not covering the activities |
| 6 | **Texas TRAIGA § 552.051(f) and Utah's regulated-occupation rule** may reach a booking assistant and want a written, plain-language disclosure the spoken line is not; Utah wants it before any written exchange, which a DM cannot do. Veterinary medicine is a licensed occupation too, so the Utah rule may reach a veterinary practice under the DPA as it reaches a clinic | Owner | Duty sits with the clinic (terms § 8); written notice template given to every clinic; Messenger greeting and Instagram ice-breaker text set to the disclosure | First Texas or Utah clinic, a DPA practice (veterinary included) as much as a BAA one |
| 7 | **PHI on Meta by design.** For a covered clinic, an identified person's booking request is PHI even with no treatment named, and Meta signs nothing | Owner | Patient's choice of channel after a first-line warning; minimum necessary; no clinical content, no appointment details; clinic accepts by connecting; covered clinics can leave Meta off or run request-only | A covered clinic's counsel objects; HHS guidance on social messaging |
| 8 | **The guarantee as advertised** (FTC Act § 5; 16 CFR 239.3): conditions must be clear where the claim is made; the headline must not say "money-back" | Owner, engineer | Identical block in full on `/pricing` and in § 5; 7-day notice of recorded misses; refunds to the payment method; the thresholds were set before latency was measured | A complaint or chargeback pattern; measured latency showing the 10-second line is routinely missed |
| 9 | **"The practice team will get back to you within a day"** is a promise made on the clinic's behalf | Owner | Proposed terms § 8 handover duty; portal view of open handovers; "pass your details to" wording recommended | Patient complaints; a state AG letter |
| 10 | **Clinics outside HIPAA** fall under state consumer-health-data laws (Washington, Nevada, Connecticut) and California's service-provider rules, which 1.2.0 does not carry in terms. From the DPA's release a veterinary practice and a "No" practice sign the Data Protection Agreement ([dpa.md](./dpa.md)), which quotes the same state-law clause, so R5 is its open point too; California's veterinary confidentiality statute (Business and Professions Code § 4857, reported, not read this session) adds a duty the DPA's veterinary paragraph names only in general terms; and many small practices may fall below the California statute's thresholds, which makes its terms harmless but unnecessary | Owner | State-law clause drafted for 1.2.1, carried in the unreleased BAA 1.3.0 draft and quoted by the unreleased DPA; reading the California statute and regulation it rests on is part of 1.3.0's release audit (agreement-changes.md § 12.6, R5), and of the DPA's release | First non-covered clinic, or first DPA practice, in Washington, Nevada or Connecticut; the first California veterinary practice; a consumer request under one of those laws |
| 11 | **Facts still blank or unverified:** the Security Official's name (must be filled before any agreement is signed); Retell's region and subprocessor list; Stripe's no-BAA position from Stripe itself; the transcript retention period the spec requires | Owner | Named actions in agreement-changes.md § 4 and A5 | None needed; these are actions, not legal questions |
| 12 | **A calendar outside Google's business associate agreement, by the practice's direction** (BAA 1.3.0 draft, the uncovered calendar clause; owner decisions 2 and Q3, 5 October 2026). A practice on a personal Gmail calendar, or a Workspace whose administrator has not accepted Google's BAA, may still have the assistant add bookings there: a first name, the service and the time. Google's own page says "Customers who have not signed a BAA with Google must not use PHI in Google Workspace or Cloud Identity services" and "Third-party applications including add-ons are not included in the Included Functionality covered by the BAA" (https://knowledge.workspace.google.com/admin/compliance/hipaa-compliance-with-google-workspace-and-cloud-identity, read 6 Oct 2026; Calendar itself is Included Functionality, https://workspace.google.com/terms/2015/1/hipaa_functionality/, read the same day); the clause makes the practice answerable for the disclosure, including any notification, and is open to declared covered entities too. Whether an OCR investigator or a court would accept a practice-directed disclosure into an uncovered account as the practice's own act, rather than healdesk's, is untested | Owner | The practice answers the account question itself before signing and sees the consequence in the clause; the clause limits what is sent (no telephone number, email address or anything clinical) and where; the practice can withdraw at any time; a covered practice can choose Workspace with Google's BAA, or a system that runs manual booking; `hd` proves only a managed account, so the covered clause states it rests on the practice's word (agreement-changes.md § 12.4) | Any OCR inquiry or complaint touching a calendar; a covered clinic's counsel objecting; the release audit of 1.3.0 |
| 13 | **24 hours' notice before a new PHI subcontractor** (BAA 1.3.0 draft and the funnel's DPA; owner decision, 6 October 2026). The usual notice is fifteen to thirty days, and 1.2.1 and 1.2.2 give fifteen; a day leaves a practice little time to object, so the objection right it keeps is weaker. The public `/subprocessors` page is gone (owner, 9 October 2026); any public page that still states a notice period has to match the version in force at the release (agreement-changes.md § 12.11, item 10) | Owner | The internal register (`docs/hipaa-compliance.md`), given to a signed practice on written request to hello@healdesk.io (1.2.2's clause 11 and the drafts' shared sentence); the right to terminate without penalty on a reasonable objection is kept; 1.2.1 and 1.2.2 signers keep fifteen days; a new PHI subcontractor is rare and can be announced earlier than the minimum | A clinic counsel's redline on the notice period; any objection received after a notice |
| 14 | **Breach notice "without unreasonable delay and in no case later than 60 calendar days"** (BAA 1.2.2, and the 1.3.0 and DPA drafts; owner, 9 October 2026, following the product spec). Sixty days is the most 45 CFR 164.410(b) allows, and a practice's own sixty-day clock to notify patients may run from healdesk's discovery where healdesk is its agent (164.404(a)(2)), so a report near the limit could leave the practice no time; 1.2.1's five days were written to avoid that. For a DPA practice, Cal. Civ. Code 1798.82(b) asks a business holding data it does not own to notify the owner "immediately following discovery", which the text alone no longer promises (agreement-changes.md § 13) | Owner | The internal 24-hour target in the incident console and `docs/incident-response.md`, unchanged and unpublished; "without unreasonable delay" binds before the outer limit; the statute binds healdesk directly whatever the text says | A clinic counsel's redline on the deadline; a breach at a practice whose own notice deadline is shorter than the time healdesk took; the DPA's release audit |

## Actions for the lead outside this folder

1. `docs/incident-response.md` and BAA clause 2 cite the FTC Health Breach
   Notification Rule for non-covered clinics; 16 CFR 318.2 does not reach a
   clinic's booking records. Replace with state breach-notification law.
2. Terms § 9 and `/subprocessors`: add the flagged-content exception to the
   Anthropic sentence (A3).
3. `GUARANTEE_TEXT`: carry the eight tightening changes; render the block on
   `/pricing`; nothing about the guarantee there until it renders.
4. `disclosure.ts`: drop "Anything about payment" from the Meta prohibitions.
5. Fill the Security Official's name before the first agreement is signed.

## Review log (2026-10-01)

- The draft brief listed twenty-one questions "for counsel" and answered
  none. → Replaced by a register: decisions with their records, and eleven
  open risks each with an owner, a mitigation and a trigger.
- Question 1 (Meta) was correct and stays the largest risk; two facts were
  added from the vendor's own pages read this session (the "not a business
  associate" sentence and the "Medical and healthcare products" line).
- Question 2 (replace 1.0.0) is decided; the replacement has defects of its
  own, now ranked second.
- Question 4 (UAE entity) gained the service-of-process point and the PDPL
  scope article; the licence check is an owner action, not a legal question.
- Question 9 (§ 1179) was mis-framed: the exemption belongs to the
  processor; healdesk's basis is § 164.506(c) and the HHS preamble.
- Residual risk of this register itself: it was written by the same AI
  assistant that drafted the documents it reviews. The primary sources are
  linked so that anyone can check the reading; the places where a source
  could not be reached are marked in the files.
