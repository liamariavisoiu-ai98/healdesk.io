# The BAA, the terms and the privacy page for v1 (launch step 1.11)

> **Adopted by the owner on 1 October 2026 without external counsel review.
> Residual risks are listed in the Review log. Not legal advice.**
>
> BAA 1.2.0 (`packages/catalog/src/baa.ts`, rendered in
> `docs/baa-v1.2.0.txt`) is the version offered at checkout from 1 October
> 2026. The terms (`apps/web/src/app/terms/page.tsx`) were rewritten the same
> day. This file records what was decided and why, checks 1.2.0 against the
> regulation it claims to satisfy, and lists what the next version (1.2.1)
> must fix. Where a document disagrees with `docs/v1-product-spec.md` about
> what the product does, the spec wins.

## Contents

1. [What was decided and shipped](#1-what-was-decided-and-shipped)
2. [BAA 1.2.0 against 45 CFR 164.504(e) and 164.314(a)](#2-baa-120-against-45-cfr-164504e-and-164314a)
3. [BAA 1.2.0 clause by clause: decision, basis, and what 1.2.1 fixes](#3-baa-120-clause-by-clause)
4. [Subprocessors, verified](#4-subprocessors-verified)
5. [Google Calendar](#5-google-calendar)
6. [Meta and Stripe: the one rule, and its basis](#6-meta-and-stripe-the-one-rule-and-its-basis)
7. [Terms of service](#7-terms-of-service)
8. [Privacy page](#8-privacy-page)
9. [Clinics outside HIPAA: state-law terms instead of a separate DPA](#9-clinics-outside-hipaa)
10. [Existing signers and subprocessor notice](#10-existing-signers-and-subprocessor-notice)
11. [How a change ships (for the engineer)](#11-how-a-change-ships-for-the-engineer)
12. [BAA 1.3.0 (draft): calendar terms, the Q8 clauses and 24 hours' notice](#12-baa-130-draft-calendar-terms-the-q8-clauses-and-24-hours-notice)
13. [Review log](#review-log-2026-10-01)

---

## 1. What was decided and shipped

Owner's decisions of 1 October 2026, now in code:

| Decision | Where |
| --- | --- |
| BAA 1.2.0 published, approved by the owner without external counsel, then replaced the same day by 1.2.1 carrying the five fixes in § 3 (A1–A5); 1.0.0 no longer offered | `BAA_TEMPLATES[0]` is 1.2.1, `approvedByCounsel: true` with the doc comment recording the basis; `docs/baa-v1.2.1.txt` |
| Anthropic retention stated with the exception its own terms carry: 30 days, except flagged or legally required content, which may be kept up to two years | 1.2.1 clause 11; terms § 9; `/subprocessors` |
| Anthropic named as the model provider; 30-day retention for abuse detection and security stated; no training | 1.2.0 clause 11; terms § 9 |
| Callbacks, the Cal.com write, the direct-booking addendum and the reactivation gate removed; Google Calendar clause added, unconditional | 1.2.0 clauses 4, 5, 8; terms § 2 and § 8 "Bookings" |
| One liability allocation: healdesk's liability excluded where the law allows, capped at twelve months' Fees otherwise, not reaching wilful misconduct, gross negligence or non-limitable liability; the clinic indemnifies, breach investigation and notification costs included; a regulator's civil money penalty on healdesk cannot be shifted and the text says so | 1.2.0 clause 16; terms §§ 13–14 |
| Forwarded calls pass straight through to the clinic's direct line on pause, suspension, allowance exhaustion, failure or exit; never a dead line; pass-through for at least 30 days after the service ends or until forwarding is removed | Terms §§ 2, 6, 7, 8; `POLICY.forwardingPassThroughDays` |
| The first-month guarantee adopted | Terms § 5; [guarantee-and-refund.md](./guarantee-and-refund.md) |
| Opening lines fixed; live transfer off by default | `disclosure.ts`; [state-disclosure.md](./state-disclosure.md) |
| Assent label: "I agree to the Business Associate Agreement" | `BAA_ASSENT_LABEL` |

Decisions taken in this review by reasoning, for the owner to confirm:
the one Meta rule (§ 6), the Google Calendar event contents and read scope
(§ 5), 30-day destruction kept (§ 3 clause 15), the 15-day subprocessor
notice sent now (§ 10), re-acceptance of 1.2.0 by any 1.0.0 signer before
go-live (§ 10), a state-law terms clause in 1.2.1 instead of a separate DPA
(§ 9), and the 1.2.1 fixes listed in § 3.

---

## 2. BAA 1.2.0 against 45 CFR 164.504(e) and 164.314(a)

Checked against the regulatory text at
https://www.law.cornell.edu/cfr/text/45/164.504 and
https://www.law.cornell.edu/cfr/text/45/164.314 (read 1 Oct 2026), and
https://www.law.cornell.edu/cfr/text/45/164.410 for the breach clock. Clause
numbers are those of the rendered 1.2.0.

| Requirement | Where 1.2.0 meets it | Note |
| --- | --- | --- |
| (e)(2)(i) establish permitted and required uses and disclosures; not beyond what the covered entity could do, except management/administration and data aggregation | Cl. 3; cl. 6 | Met |
| (e)(2)(ii)(A) no use or disclosure other than as permitted or required by law | Cl. 3 ("and as required by law") | Met |
| (B) appropriate safeguards; comply with Subpart C for ePHI | Cl. 8, first paragraph | Met. Second paragraph has a wording defect (finding A4) |
| (C) report uses or disclosures not provided for, including breaches of unsecured PHI per § 164.410 | Cl. 10(a), (b); report contents track § 164.410(c) | Met. Five calendar days is inside the 60 § 164.410(b) allows |
| (D) subcontractors agree to the same restrictions and conditions (§ 164.502(e)(1)(ii)) | Cl. 11, first paragraph | Met |
| (E) access, § 164.524 | Cl. 12(a) | Met; ten business days to produce is inside the covered entity's 30 |
| (F) amendment, § 164.526 | Cl. 12(b) | Met |
| (G) accounting of disclosures, § 164.528 | Cl. 12(c); six-year record in cl. 15 | Met |
| (H) comply with Subpart E when carrying out a covered-entity obligation | Cl. 13 | Met |
| (I) books and records to the Secretary | Cl. 17 | Met |
| (J) return or destroy at termination; extend protections where infeasible | Cl. 15, second paragraph (30 days) | Met |
| (e)(2)(iii) covered entity may terminate for a material violation | Cl. 15, first paragraph (30-day cure; at once where cure is impossible) | Met |
| (e)(4) management and administration; disclosures only if required by law or with assurances | Cl. 6, first paragraph, which cites it | Met |
| (e)(5) same requirements flow to subcontractor contracts | Cl. 11 cites § 164.504(e)(5) | Met |
| § 164.314(a)(2)(i)(A)–(C) Security Rule compliance, subcontractor flow-down, security-incident reporting | Cl. 8; cl. 11; cl. 10(c) | Met. The "unsuccessful attempts reported once, here" device is the usual one |
| Omnibus-era: no sale of PHI, no marketing use, minimum necessary (§ 164.502(b)) | Cl. 14; cl. 9 | Met |

Every element is present. The defects found are in accuracy of fact, not
in the regulatory skeleton; they are listed in § 3 and the Review log.

---

## 3. BAA 1.2.0 clause by clause

The 1.2.0 preamble names Viixi FZC, its form and the Delaware notice
address, and drops the 1.1.0 "ACCEPTED FOR HEALDESK BY [NAME, TITLE]"
placeholder. healdesk's assent is shown by offering the text, provisioning
against it and sending the executed copy; § 164.504(e) requires a written
arrangement, not a countersignature. Low risk, noted.

| # | Clause | Decision and basis | 1.2.1 fix (A = accuracy finding) |
| --- | --- | --- | --- |
| 1 | Definitions | Kept from 1.1.0. Terms "as in force on the effective date" | None |
| 2 | Practice's status | The clinic determines and warrants its status; healdesk applies the same safeguards either way; the document is a data-protection agreement where the clinic is not covered. Basis: a vendor that "confirms" its customer's legal status owns the error (`counsel-audit.md` § 1). Go-live is refused while status is undetermined (migration 0032) | **A1.** "the FTC Health Breach Notification Rule may apply to Practice" is doubtful. 16 CFR 318.2 reaches vendors of personal health records ("managed, shared, and controlled by or primarily for the individual"), PHR related entities and their service providers; a clinic's booking records are none of these (https://www.law.cornell.edu/cfr/text/16/318.2). Replace with "state breach-notification and consumer-health-privacy laws may apply to both parties" |
| 3 | Permitted uses | 1.0.0 object, unchanged | None |
| 4 | What healdesk reads | New body: no credentials to any practice-management or point-of-sale system; the only PHI is what patients give and the calendar access. The "Revenue figures" sentence is gone (v1 may not claim revenue) | None |
| 5 | Practice's Google Calendar | New, unconditional. OAuth under the clinic's own Google agreement; token held encrypted; the event carries a first name, the service and the time, never a phone number or email; nothing moved or cancelled that healdesk did not create; the clinic acknowledges Google's BAA covers Calendar only where its Workspace admin accepted it. Basis: § 5 below | **A2.** "reads … the events on the booking calendar Practice chooses" describes the Google scope (`calendar.events.owned` reaches every event on a calendar the user owns), not the minimum necessary. Reword: "reads when that calendar is free or busy and the appointments healdesk itself created; Google's permission model gives it access to the other events on that calendar, and it does not read or store them". Engineering rule in § 11 |
| 6 | Own use and aggregation | Kept. Permits de-identified aggregate statistics; no training | Cite the de-identification standard: "de-identified under 45 CFR 164.514(b)" |
| 7 | Practice's duties | Kept | Add the direct-line duty? No: it is in terms § 8 and is not a PHI term |
| 8 | Safeguards | Kept with the callback sentence removed; the one exception is the call a patient placed; no calls, no SMS | **A4.** "will not transmit PHI over a channel that cannot negotiate encryption — email included" contradicts itself and the design: PHI email goes only through SES with `TlsPolicy=REQUIRE`, which fails delivery when the receiving server will not negotiate TLS (risk analysis T13). Delete "— email included" or say "an email whose receiving server will not negotiate encryption is failed, not sent". Also say that the list of individuals in a breach report goes by secure transfer, not in the email (`incident-response.md` step 5 already does this) |
| 9 | Minimum necessary | Kept and extended: the callback-slip set; no history, medication or diagnosis; no card numbers; the fixed opening disclosure | None |
| 10 | Reporting | Kept: five business days for improper use and security incidents, five calendar days for a breach, § 164.410(c) contents; cost allocation deferred to cl. 16 | None |
| 11 | Subcontractors | Names Anthropic, states the 30 days, the purpose, "cannot run with shorter retention", no training. Basis: spec "Five rules", third rule, and Anthropic's published terms (§ 4) | **A3.** "retains conversation content for 30 days … and then deletes it" overstates. Anthropic's own pages say content flagged by its automated trust-and-safety systems, or that the law requires it to keep, may be retained for up to two years, "even with ZDR or HIPAA arrangements in place". Add: "except content Anthropic's automated trust-and-safety systems flag or the law requires it to keep, which it may retain for up to two years". The same sentence is in terms § 9 and must change there too |
| 12 | Patient rights | 1.0.0 object | None |
| 13 | Acting in your place | 1.0.0 object | "sending messages in Practice's name" is accurate for replies. Optional: "replying in Practice's name" |
| 14 | Not authorised | New object: no training; no PHI to any advertising or analytics platform; Meta named, with the scoping ("handles no clinical content, confirms no appointment details"); no clinical advice; no sale | Consistent with the one rule in § 6. Privacy § 12 and `disclosure.ts` must align (§ 8, § 11) |
| 15 | Term and destruction | Kept: 30 days to return or destroy, export on request before then, infeasibility language, six-year survival of the signed copy and the accounting record. Decision: 30 days stands. Basis: feasible with the purge job and the `--all` export; inside industry norms; matches terms § 7 | Say what happens if an export is requested on day 29: destruction follows delivery of the export |
| 16 | Liability | The owner's allocation (§ 1). Basis: between commercial parties Delaware enforces clear exculpation and indemnity, and an indemnity reaching the indemnitee's own negligence must say so expressly, which it does; gross negligence and wilful misconduct are carved out because courts will not enforce exculpation of them; the civil-money-penalty sentence states what HIPAA makes true anyway (a business associate is directly liable to OCR) | None in text. Residual: clinic counsel will resist the one-way indemnity and the absence of insurance; that is a commercial negotiation, not a drafting defect (Review log R2) |
| 17 | Records to HHS | 1.0.0 object | None |
| 18 | Notices, law | Kept: Delaware law and courts; HIPAA-compatible construction; "replaces any earlier version … from the effective date forward" | Consider appointing the Delaware registered agent as agent for service of process (Review log R3) |
| — | Missing | Transcript retention period. The spec requires transcripts to live "under a stated retention period"; no document states it, and the clinic's retention window exists in code | **A5.** Add to 1.2.1: "healdesk keeps transcripts and conversation records for [N] days, which Practice may shorten in its portal; the Term clause governs after termination". N is an open owner decision |
| — | Missing | Payments | Add a one-sentence Payments clause (§ 6 text): amount, generic descriptor, opaque reference; no service name or clinical detail, including metadata and statement descriptor; no card numbers |

---

## 4. Subprocessors, verified

From `apps/web/src/lib/subprocessors.ts`, the spec, and the vendors' own
pages read on 1 October 2026.

| Vendor | Role | PHI? | Agreement | Verified this session |
| --- | --- | --- | --- | --- |
| Anthropic | Language model, every channel | Yes | HIPAA readiness enabled from the Claude Console by executing Anthropic's standard BAA; **pending** | https://platform.claude.com/docs/en/manage-claude/api-and-data-retention : "Conversation content … is not retained by default; the exception is Covered Models, which require 30-day retention"; "Retained data is never used for model training without your express permission"; ZDR is not available to a HIPAA-ready organisation; HIPAA readiness is organisation-wide, so a separate organisation is needed for non-HIPAA work (matches the two-org design); "Even with ZDR or HIPAA arrangements in place, Anthropic may retain data where required by law or where it has been flagged by Anthropic's automated trust and safety systems … for up to 2 years" (finding A3); **"Do not include PHI in JSON schema definitions"** for structured outputs and `strict` tools, because compiled schemas are cached without PHI protections (engineering rule, § 11). https://support.claude.com/en/articles/15455031-covered-models-under-a-business-associate-agreement-baa (1 Jul 2026): "HIPAA-ready API" with standard retention is an Eligible Service; Covered Models "require 30-day data retention on every platform". https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data (1 Jul 2026): deletion "within 30 days", except by agreement, "to enforce our Usage Policy", or by law; Usage Policy violations "up to 2 years" |
| Retell | Voice telephony and speech | Yes | BAA and DPA self-signed at click-agreements.retellai.com, "no additional fee"; **pending** | https://docs.retellai.com/general/compliance : per-agent retention "from 1 day up to 2 years for transcripts, recordings, and logs"; per-agent storage choice ("everything, exclude PII, or basic attributes only"); hosted on AWS, **region not disclosed**; subprocessor list only on request to support@retellai.com. Action: ask for the list and the region in writing, and confirm the executed BAA names telephony and speech providers |
| AWS | Hosting, keys, storage, SES for any PHI email | Yes | Accepted 22 Sep 2026 in AWS Artifact | Not re-checked; `docs/policies/aws-hipaa-account.md` |
| Database provider | Postgres | Yes | Not chosen: AWS RDS under the AWS agreement, or Neon Scale under its own BAA | If Neon: a new row and the 15-day notice (§ 10) |
| Meta | Instagram, Messenger, WhatsApp | Scoped to carry nothing clinical | None, ever | https://www.facebook.com/legal/Meta-Terms-for-WhatsApp-Business-Platform (23 Sep 2026): "Meta is not a business associate or subcontractor (as those terms are defined in HIPAA)" and "the WhatsApp Business Platform is not HIPAA-compliant". https://developers.facebook.com/devpolicy/ (3 Feb 2026) § 5.6.5, quoted in `brief.md`. https://whatsappbusiness.com/policy/ (23 Sep 2026): no telemedicine or health-related information "if applicable regulations prohibit distribution of such information to systems that do not meet heightened requirements"; automation allowed in the 24-hour window with "prompt, clear, and direct escalation paths" including a phone number; "Medical and healthcare products" among goods businesses may not buy, sell, promote or facilitate |
| Stripe | Clinic billing; deposits through the clinic's own gateway | Scoped to an amount, a generic descriptor and an opaque reference | None, any tier | **Not located on stripe.com this session**; secondary sources agree Stripe does not sign BAAs and Stripe Identity's own docs exclude PHI. Action: written confirmation from Stripe support before the first deposit link; the design does not depend on the answer |
| Google (the clinic's calendar) | The clinic's own system | Yes | The clinic's own Workspace agreement with Google | Not healdesk's subprocessor (§ 5). Not re-verified |
| Resend | Transactional email declared `phiClass: "none"` | No | Not needed | Unchanged |
| Synthflow | Marketing demo call only | No | Not needed | Never a patient call. Remove from every product document |

Retired: Cal.com, Synthflow as a product vendor, Twilio, Supabase.

---

## 5. Google Calendar

**Decided.** Writing a booking into the clinic's own Google Calendar is a
disclosure to the covered entity through the covered entity's own vendor.
Google holds the data for the clinic under the clinic's agreement, not for
healdesk, so Google is not healdesk's subcontractor and no notice or BAA
flow-down applies to it; a covered clinic needs its own Google Workspace
BAA, and the spec's "Google's BAA excludes third-party apps" is why 1.2.0
clause 5 says healdesk's access is governed by the clinic's agreement with
healdesk. The OAuth token is a credential to a system holding PHI, so the
clause says healdesk holds it, encrypted.

**Event contents.** First name, service asked about, time. No telephone
number, no email address, no notes from the conversation. The number stays
in the healdesk portal's Bookings screen, where staff read it under a second
factor. This is the minimum a receptionist needs on the calendar itself.

**Read scope.** Finding A2: the clause should state what healdesk reads
(free or busy; its own events), not what Google's scope permits. Preferred
design, for the engineer: request `calendar.events.freebusy` for
availability and write into a healdesk-created secondary calendar
(`calendar.app.created`) that the clinic overlays, so the app never has
access to other patients' events at all. If the clinic insists on its
primary calendar, `calendar.events.owned` is needed and the clause must
describe the access honestly.

**The direct-booking addendum** is retired. Its allocation now lives in
terms § 8 "Bookings": appointments the agent writes are the clinic's
bookings as if its staff had made them; the clinic keeps availability true
and collects flagged deposits; healdesk books only into that calendar, only
at a time it showed as free. The allocation is a commercial term accepted
at checkout like every other term; the "Auto-confirm bookings" switch is
configuration, and the allocation holds whether it is on or off (off makes
every booking a request staff approve, where the allocation is even
clearer). No separate acceptance is needed.

---

## 6. Meta and Stripe: the one rule, and its basis

**The one Meta rule** (decided in this review; consistent with BAA 1.2.0
clause 14, terms § 9 and the spec):

On Instagram, Messenger and WhatsApp the assistant (1) replies only inside
the conversation the patient opened and inside Meta's 24-hour window,
enforced by the adapter; (2) answers from the clinic's public menu, prices,
hours and policies without repeating a treatment name; (3) takes the
callback-slip details and writes the booking into the calendar; (4) sends
the clinic's hosted payment link where deposits are on; (5) states no
appointment date, time or practitioner and no treatment name in any Meta
message, and tells the patient the practice's own confirmation will follow;
(6) sends no clinical content, and clinical content the patient sends is
detected on arrival and never stored, echoed or summarised, with the
patient moved to a call or the clinic's secure route in one plain sentence;
(7) gives the practice's phone number whenever asked for a person, which is
one of the escalation paths the WhatsApp policy requires; (8) mentions no
promotions on these channels, because the WhatsApp policy bars promoting
"medical and healthcare products" and the line between a treatment and a
product is not one to test in a DM.

What the rule does for each document: BAA 1.2.0 clause 14 ("handles no
clinical content, confirms no appointment details") stands; terms § 9 ("can
book and can send your own payment link, and never sends clinical content
or a treatment name") stands; `disclosure.ts` `META_CHANNEL_PROHIBITIONS`
must drop "anything about payment" and keep the rest; privacy § 12 must say
the same (§ 8). The engineer owns the last two.

**The basis, stated honestly.** For a HIPAA-covered clinic, the fact that an
identified person asked a provider for an appointment is PHI even with no
treatment named (the spec's own test: "do not assume a callback slip is
exempt because it feels administrative"). Meta signs nothing. The product's
position is therefore not that no PHI touches Meta; it is that the patient
chose the channel and was warned in the first line, that what healdesk puts
on the channel is the minimum necessary and never clinical, and that
nothing a patient already sent to Meta can be unsent. HHS has accepted the
patient's choice of an unencrypted channel after a warning for email
(Omnibus Rule preamble, 78 Fed. Reg. 5566, 5634 (25 Jan 2013); not re-read
this session). It has never said so for a platform that also serves the
provider's side. This is an accepted risk, recorded in `brief.md` as risk
7, and the BAA puts the acceptance on the clinic by its choice to connect
the channel. A covered clinic whose counsel objects can leave the Meta
channels off or run "Auto-confirm bookings" off, in which case the Meta bot
takes a request and states nothing.

**Stripe and the clinic's gateway.** The HIPAA statute exempts a financial
institution's payment processing: "this part … shall not apply to the
entity with respect to such activities, including … the use or disclosure
of information by the entity for authorizing, processing, clearing,
settling, billing, transferring, reconciling or collecting, a payment for,
or related to, health plan premiums or health care" (42 U.S.C. § 1320d-8,
https://www.law.cornell.edu/uscode/text/42/1320d-8). That is Stripe's
exemption, not healdesk's. healdesk's basis is different and stronger: the
disclosure to the processor is a disclosure for "payment" that a covered
entity may make without authorisation (45 CFR 164.506(c)), HHS's Privacy
Rule preamble says a financial institution processing a consumer's payment
card transaction is not acting on the covered entity's behalf and needs no
business associate contract (65 Fed. Reg. 82462 (28 Dec 2000),
https://www.govinfo.gov/content/pkg/FR-2000-12-28/pdf/00-32678.pdf;
pinpoint not re-read this session), and what healdesk sends carries no
clinical fact at all. Decision: rely on these three together; keep the
design that nothing clinical reaches a payment artifact, in the description,
the statement descriptor or metadata. Proposed 1.2.1 clause:

> "**Payments.** Where Practice takes deposits, healdesk creates a payment
> link through Practice's own payment processor. The link and the payment
> carry an amount, a generic description and a reference number, and no
> service name or clinical detail, including in metadata and the statement
> descriptor. healdesk never takes card numbers."

---

## 7. Terms of service

As shipped on 1 October 2026, read this session.

| § | Status | Note |
| --- | --- | --- |
| 2 | Done | Names website chat, auto-confirm and manual booking mode, booked value and the "no revenue" sentence, the fixed disclosure on every channel, and the pass-through to the direct line whenever the agent is not answering |
| 3 | Open | Setup-fee exception from `guarantee-and-refund.md` decision 5, if the owner confirms |
| 5 | Done | Refund window, guarantee block, no-stacking and the § 13 / § 19 carve-outs. The block itself is to be tightened per `guarantee-and-refund.md` |
| 6 | Done | Dunning to the owner and billing contact, never the public inbox; pass-through on suspension; "portal" |
| 7 | Done | Pass-through for at least 30 days after the end or until forwarding is removed; access to Google Calendar, Meta accounts and the gateway revoked; export before destruction on the BAA's schedule (now 30 days) |
| 8 | Done, one gap | Inbound only; Bookings (the former addendum allocation); call forwarding and the direct line; own notices; roles. **Gap:** a handover duty: "When a caller or visitor asks for a person, the agent takes their details and alerts the contact you named; you get back to them by the end of the next business day, as the agent tells them you will." Without it the opening line promises something nobody is bound to (state-disclosure.md decision 1) |
| 9 | Done, one fix | BAA controls; liability allocated the same way; the model paragraph; the Meta paragraph matches the one rule. **Fix:** the model paragraph's "keeps that content for 30 days … and then deletes it" needs the flagged-content exception (finding A3) |
| 12 | Done | Guarantee carve-out; booked value disclaimer |
| 13 | Done | Exclusion, cap, carve-outs for wilful misconduct, gross negligence, indemnity and non-limitable liability; guarantee not limited; no insurance stated |
| 14 | Done | One-way indemnity reaching alleged negligence; investigation and notification costs; defence mechanics |
| 19 | Done | Force majeure excludes payment and the guarantee |
| 20 | Done | Entity line; registered address blank until known |

---

## 8. Privacy page

Statements to fix, for the engineer (page not owned by this review):

| Current | Why it is wrong or unproven | Replace with |
| --- | --- | --- |
| § 9 "a signed agreement with every vendor that touches it" | Retell, Anthropic and the database provider are unsigned today; Meta and Stripe are in the patient's path and never sign | "an agreement with every vendor that holds patient information, signed before any patient information reaches it; Meta and Stripe sign none, so the product keeps clinical content away from them" |
| § 9 "United States infrastructure" | Retell's region is undisclosed | Keep only once Retell confirms the region in writing |
| § 9 "encryption … in transit" | A phone call is not end-to-end encrypted; a Meta message is outside our control | Add the telephone and Meta exceptions, as the BAA does |
| § 9 "no patient information over email" | Risk analysis T13 is still an open design decision | Keep only once decided |
| § 12 "to book an appointment or send the clinic's own payment link" | Must match the one rule | Add "and never states a time, service or practitioner there" |
| § 12 "visible only to that clinic's own team in its portal" | Operators can reach data under audit | "visible to that clinic's team in its portal, and to healdesk staff only as the clinic's agreement allows" |
| § 11 "Creates and changes the events it books" | True to the spec, not built | Keep behind the page's own "true before the first clinic connects" gate |
| § 1 "It does not cover patients" | §§ 11–13 describe patient data | Add "except as sections 11 to 13 say about the product" |
| `/subprocessors` Anthropic row: "Under the BAA Anthropic keeps inputs for 30 days" on a row that also covers the marketing demo | The demo runs in a separate, non-HIPAA organisation; and the row lacks the flagged-content exception | Split the row; add the exception (finding A3) |

Bump `LEGAL_VERSION` and `LEGAL_LAST_UPDATED` with any change.

---

## 9. Clinics outside HIPAA

Many cash-pay practices are not covered entities. For them BAA 1.2.0 is, by
clause 2, "a data-protection agreement on the same terms". Decision: no
separate DPA. Instead, 1.2.1 adds one clause carrying the specific terms
state law requires of a processor or service provider, because "the same
terms" does not supply them:

> "**Where Practice is not a covered entity.** healdesk processes patient
> information only on Practice's documented instructions, which are the
> Terms and Practice's portal settings, and for no other purpose. It does
> not sell or share it, does not retain, use or disclose it outside the
> direct business relationship with Practice or for any purpose other than
> providing the Services, and does not combine it with information from any
> other source except as the Services require. healdesk will give Practice
> the information it needs to answer a consumer's access, deletion or
> correction request within ten business days; will tell Practice if it can
> no longer meet these obligations; will let Practice take reasonable steps
> to stop and remedy any unauthorised use; and will provide, on request,
> the documents Practice reasonably needs to verify compliance. The
> reporting, subcontractor, security and return-or-destroy clauses of this
> agreement apply to that information as they apply to PHI."

Basis: the California service-provider contract requirements (Cal. Civ.
Code § 1798.140(ag) and 11 CCR § 7051; statute text not re-read this
session, so the clause must be checked against it before 1.2.1 publishes),
the Washington My Health My Data Act's processor-contract requirement (RCW
19.373.060) and consent exception for a service the consumer requested
(RCW 19.373.030, read 1 Oct 2026,
https://app.leg.wa.gov/RCW/default.aspx?cite=19.373.030), and the Nevada and
Connecticut consumer-health-data laws modelled on Washington's. The FTC
Health Breach Notification Rule reference is dropped (finding A1); state
breach-notification statutes apply instead, and under them an entity that
maintains data for an owner must notify the owner, which the five-day clock
already does.

Trigger to engage a lawyer: the first clinic outside HIPAA in Washington,
Nevada or Connecticut, or a consumer request under one of those laws.

**Narrowed on 6 October 2026.** The funnel plan (Part L) gives a veterinary
practice, and a practice HIPAA reaches only if covered that answers "No", a
separate Data Protection Agreement once the owner releases it
([dpa.md](./dpa.md); `dpa/1.0.0` in `packages/catalog/src/dpa.ts`). It quotes
the clause above with two edits a document without PHI needs. The decision
above still holds for every practice that signs the BAA while not covered.

---

## 10. Existing signers and subprocessor notice

**1.0.0 signers.** No clinic has gone live and no real patient data has been
processed. Decision: 1.0.0 is no longer offered; any account that accepted
1.0.0 re-accepts 1.2.0 in the portal (or by the agreement link in an email)
before provisioning, and go-live refuses an account whose bound agreement is
a superseded version. Until re-acceptance, 1.0.0 governs that account,
including its sentence making healdesk bear notification costs, which is
one more reason to require re-acceptance before any PHI flows. The 1.2.0
notices clause then replaces the earlier version "from the effective date
forward".

**The 1.0.0 assent label.** Every 1.0.0 acceptance recorded "… and confirm
the consent warranty above" with no warranty in the document. The surplus
words do not negate assent to the text that was displayed and hashed; the
risk is confusion, not invalidity, and it is moot once each signer
re-accepts 1.2.0 under the corrected label.

**Subprocessor notice.** Both BAA versions promise fifteen days' notice
before a subcontractor handles PHI. Retell, Anthropic and the database
provider are new relative to any signer from the Synthflow period. Decision:
send the notice now to every signed account, naming all three (and Neon if
chosen). Go-live is more than fifteen days away, so the notice costs
nothing and removes the argument.

---

## 11. How a change ships (for the engineer)

- **Never edit a released clause object.** 1.2.0 reuses 1.1.0 and 1.0.0
  objects by lookup; a new wording is a new object in a new version. The
  golden hash for 1.2.0 (`apps/app/tests/baa-golden.test.ts`) must keep
  reproducing.
- **1.2.1 carries findings A1–A5, the Payments clause, the state-law clause,
  and the § 164.514(b) citation.** (As shipped on 1 October 2026, 1.2.1
  carries A1–A5 only. The other three are in the 1.3.0 draft; see § 12.6.)
  Add it below 1.2.0 with
  `approvedByCounsel: false` until the owner approves it the same way, then
  move it to `[0]`. Publish it before the first real clinic signs if at all
  possible; A3 is a misstatement of a vendor's terms in a signed document.
- **The two signing paths change together** (`apps/app/src/lib/agreements.ts`
  and `apps/web/src/components/checkout/AgreementStep.tsx`).
- **Calendar scopes.** Request `calendar.events.freebusy` and prefer a
  healdesk-created secondary calendar (§ 5). If `calendar.events.owned` is
  used, read only free/busy and healdesk's own events, and log nothing
  else.
- **No PHI in tool schemas.** Anthropic's HIPAA page: "Do not include PHI in
  JSON schema definitions" for structured outputs and `strict` tools. Tool
  schemas must be static; patient data goes in message content only.
- **`disclosure.ts`**: drop "Anything about payment" from
  `META_CHANNEL_PROHIBITIONS`; keep the rest.
- **Bump `LEGAL_VERSION` and `LEGAL_LAST_UPDATED`** with any terms or privacy
  change.

---

## 12. BAA 1.3.0 (draft): calendar terms, the Q8 clauses and 24 hours' notice

> **Drafted 6 October 2026. Not released, not offered, not legal advice.**
> `packages/catalog/src/baa.ts` registers 1.3.0 at `BAA_TEMPLATES[1]` with
> `approvedByCounsel: false`. Checkout does not offer it, and signing refuses
> it because `validateSignRequest` accepts only `BAA_TEMPLATES[0]`.
> Provisioning does not check it: its approval gate reads
> `currentBaaTemplate()`, not the bound acceptance's version, until plan C15
> changes that, and C15 must land before the release. The full text is
> rendered in `docs/baa-v1.3.0-draft-calendar-clauses.txt`. The owner decided
> on 5 October 2026 (answer Q2) that Claude releases 1.3.0 and the calendar
> election after its own adversarial audit of the full text, with no counsel
> gate: against 45 CFR 164.504(e), the code's actual behaviour, the spec, the
> terms and the privacy page. The audit's findings are to be recorded here,
> and the owner is told the release was made without counsel.

### 12.1 Why a new version

1.2.1's Google Calendar clause is unconditional: it tells every practice that
healdesk connects its Google Calendar and adds appointments to it. That is
untrue for a practice whose booking system does not read Google Calendar,
which the spec puts in manual booking mode with nothing connected, and the
clause does not say who answers for a calendar Google's business associate
agreement does not cover. A personal Gmail calendar never is (spec, "Vendor
position, vendor by vendor": "a consumer Gmail calendar has no route to
coverage").

1.3.0 asks two questions at checkout, and the answers choose the clause. The
decisions behind it are the owner's:

- 5 October 2026, decision 2: a practice may direct healdesk to write into a
  calendar Google's agreement does not cover, and answers for that disclosure.
- 5 October 2026, decision 3: calendar terms are per location, changed by an
  append-only calendar election (§ 12.9).
- Q3: a practice that declared itself a covered entity may use the uncovered
  clause like any other, so no calendar clause is keyed to covered-entity
  status.
- Q8: 1.3.0 also carries the three additions § 11 meant for 1.2.1 (§ 12.6).
- 6 October 2026: 24 hours' notice before a new subcontractor handles PHI
  (§ 12.7), and the calendar-list permission is requested, so a practice
  chooses which of its calendars healdesk books into.

### 12.2 How the clause is chosen

The booking system the practice names gives the sync, which is never a
selection of its own (`bookingSyncFor`, `packages/catalog/src/booking-systems.ts`):

| Booking system | Reads Google Calendar for conflicts? | Source | Sync |
| --- | --- | --- | --- |
| Google Calendar only | Yes | Spec table | Live |
| Calendly | Yes | Spec table | Live |
| Cal.com | Yes | Spec table | Live |
| HighLevel | Yes, once the clinic turns on that Google calendar as a conflict calendar | Spec table (commit a45cd9a). HighLevel's "Setting Up Linked Calendars & Conflict Calendars", https://help.gohighlevel.com/support/solutions/articles/155000002374, read 6 Oct 2026: "Events from third-party calendars added as conflict calendars are synced to the system, blocking your availability for the event's duration", and "The availability is blocked only if the event is marked as 'BUSY'". healdesk writes every event opaque, which is busy (`packages/connectors/src/google/event.ts`). The checkout card states the setting | Live |
| Mindbody | No | Spec table: one direction only, Mindbody to Google | Manual |
| Boulevard | Unverified | Spec: "Treat as no until confirmed in writing" | Manual |
| Something else | Unverified | Nobody has checked it | Manual |
| No booking system yet | Yes | The assistant books into the calendar the practice connects | Live |

Zenoti, PatientNow, Acuity and Vagaro are not v1 booking systems. On the
phase-two platform list they are "unverified", and so manual, until a vendor
confirms in writing (owner, Q4).

The kind of Google account then splits a live system in two:

| Sync | Google account | Clause |
| --- | --- | --- |
| Live | Workspace, administrator has accepted Google's BAA | `google-calendar-covered` |
| Live | Workspace without it, or not sure | `google-calendar-uncovered` |
| Live | Personal | `google-calendar-uncovered` |
| Manual | Any (kept in case the system changes) | `google-calendar-not-used` |

`hd` in Google's ID token proves only that an account is managed, never that
its administrator accepted Google's agreement, so the covered clause rests on
the practice's statement and says so.

### 12.3 Clause by clause against 1.2.1

Numbers are the rendered sample's (a live system, a covered account).

| # | Clause | Against 1.2.1 |
| --- | --- | --- |
| — | Preamble | 1.2.1's, with "Version 1.3.0 — executed electronically". Nothing in it marks a draft, so releasing it moves no hash |
| 1–3 | Definitions, practice status, permitted uses | 1.2.1's objects, by lookup |
| 4 | Where Practice is not a covered entity (`state-law`) | **New** (§ 12.6) |
| 5 | What healdesk reads (`data-sources-none`) | New object. The first sentence is 1.2.1's, naming the system when it has a name. Only a live system's variant ends "together with the calendar access the Google Calendar clause describes"; a manual one ends "during a call or chat." The phase-two `data-sources-verified` is unchanged |
| 6 | Practice's Google Calendar | **Replaces** `google-calendar` with three clauses, exactly one of which renders (§ 12.4) |
| 7 | Payments (`payments`) | **New** (§ 12.6) |
| 8 | Own use and data aggregation (`own-use`) | New object citing 45 CFR 164.514(b) (§ 12.6) |
| 9–12 | Practice's duties, safeguards, minimum necessary, reporting | 1.2.1's |
| 13 | Subcontractors | New object: 24 hours' notice (§ 12.7). The flow-down and Anthropic paragraphs are 1.2.1's word for word |
| 14–20 | Patient rights, acting in your place, not authorised, term, liability, records, notices and law | 1.2.1's |

Twenty-three clauses are registered and twenty render: one of the two
data-sources clauses and one of the three calendar clauses.

### 12.4 The three calendar clauses

All three are headed "Practice's Google Calendar", so a practice's clause
never changes its name. Their bodies live once, in
`packages/catalog/src/calendar-terms.ts`; the BAA appends a last paragraph
saying the clause governs the location set up at signing, and that a calendar
election takes its place for any other location or after a change.

- **Covered.** Practice connects its own calendar by OAuth under its own
  agreement with Google, and has told healdesk the account belongs to its
  Workspace organisation whose administrator accepted Google's BAA; healdesk
  cannot check that and relies on the statement, and adds nothing to a
  calendar outside a Workspace or Cloud Identity organisation. Practice
  acknowledges that Google's BAA does not extend to applications it
  authorises.
- **Uncovered.** The same connection, on an account Practice says no Google
  BAA covers. Practice directs healdesk to add appointments anyway, knowing
  Google holds them outside any BAA; the disclosure is made at Practice's
  direction into an account Practice controls, and Practice is responsible
  for it, including any notification it triggers. healdesk's responsibility
  is limited to sending only the stated details, only to that calendar, and
  safeguarding them until they are sent. Practice may withdraw the direction
  at any time; healdesk then adds nothing more and the assistant takes
  requests.
- **Not used.** healdesk does not connect to the calendar, reads nothing
  from it and writes nothing to it; the assistant takes every booking as a
  request staff confirm in their own system. A change of system, or a wish to
  book into Google, means recording a calendar election first.

Every promise in the covered and uncovered clauses, and in the two Q8
clauses that say what healdesk does (§ 12.6), has to be kept before release:
by code, or, where no code can keep it, by an operating process written
down. On 6 October 2026:

| Promise | Kept by | Built? |
| --- | --- | --- |
| Reads the names of the calendars the account owns, free or busy for the one calendar, and its own events; reads no other event | `packages/connectors/src/google/adapter.ts`: the calendar list asks `minAccessRole=owner`; free/busy asks only for the chosen calendar; `verify()` lists events with a filter no event matches and asks for no event fields | Yes (plan C1) |
| An event carries a first name, the service as the practice's list names it, and the time; private, no invitees, no reminders; nothing moved, edited or cancelled that healdesk did not create | `packages/connectors/src/google/event.ts`; the adapter refuses to cancel an event without healdesk's marker | Yes (C1) |
| The token is held encrypted and used for nothing else | The sealed credential envelope (`apps/app/src/lib/connections/store.ts`) | Envelope yes; Google rows from C7–C8 |
| Use stops when the agreement ends; the token is deleted on a disconnect through healdesk, when healdesk finds access removed at Google, and at destruction | Plan § 4.12 and § 9: `eraseCredentials`, `markCalendarBroken`, `sweepCalendarTerms`, destruction | No (C7, C8, C10) |
| Covered: nothing added to a calendar outside a Workspace or Cloud Identity organisation | Reconciliation at connect (plan § 4.11) and `app_calendar_write_permitted` (§ 11.6). Both look only at the connected account (its `hd`) and the terms, never at whose calendar is chosen. The calendar list asks `minAccessRole=owner` with no organisation filter (`CALENDAR_LIST_QUERY` in the adapter), and Google lists as `owner` a calendar another account has shared in with "make changes and manage sharing", which may belong to a personal account or another domain (§ 12.11, item 7) | No (C6, C8; the chosen calendar's organisation is not checked anywhere yet) |
| Uncovered: withdrawal stops further writes; not used: nothing connected | The start route refuses not-used terms; a not-used election erases any connection (plan § 2.6, § 4.12) | No (C7, C8) |
| Payments: a payment link through Practice's own processor, carrying an amount, a generic description and a reference number, and no service name or clinical detail, metadata and statement descriptor included | Nothing yet. Deposit links are package D, which is paused; on a call the assistant states a deposit and never sends a link ("there is none", `depositLine` in `apps/app/src/lib/voice/tools.ts`) | No (package D; § 12.11, item 9) |
| Payments: healdesk never takes card numbers | Nothing in `apps/app` asks for, parses or stores a card number, and 1.2.1's minimum-necessary clause says the same. One a patient volunteers would sit in the conversation transcript like any other words; the audit weighs that against "never takes" | Yes, by absence |
| State law: processes patient information only on Practice's documented instructions ("the Terms and Practice's portal settings") and for no other purpose; does not sell or share it, use it outside the relationship, or combine it with other sources beyond what the Services require | Nothing in the code sells, shares or combines it. The portal the instructions name is not built yet (the funnel session builds it), and the own-use clause's permissions sit beside this one (§ 12.11, items 3 and 11) | By design, until the audit confirms |
| State law: gives Practice what it needs for a consumer's access, deletion or correction request within ten business days | Operator tools in `apps/app/src/lib/patient-rights/export.ts`: `exportPatient` (access) and `amendContact` (correction). Nothing deletes one person's records on request | Partly (no deletion) |
| State law: tells Practice if healdesk can no longer meet these obligations; lets it stop and remedy unauthorised use; provides compliance documents on request | Operating processes, none written down | No (a written process) |

The release audit checks each row against the code. No clause promises a
revocation at Google: revoking ends every grant that Google user gave the
project, including one another of the practice's locations may still be
using, so the code revokes only an unused grant and the clause promises the
deletion it always performs.

### 12.5 Where the drafted text departs from the plan's sentences, and why

The plan (5 October 2026, revision 2) gave the clause sentences exactly. These
departures were forced by later decisions or by the facts, and each is in
the golden hashes from this draft:

1. **Which calendar.** The plan said "healdesk uses the main calendar of the
   Google account Practice connects". The owner included the calendar-list
   permission on 6 October 2026, so a practice may choose any calendar the
   account owns, and that sentence would be false for one that does. Now:
   "healdesk uses one calendar of the Google account Practice connects, which
   is that account's main calendar unless Practice chooses another calendar
   the account owns."
2. **What healdesk reads** gains "the names of the calendars that account
   owns, so that Practice can choose one", which the calendar list reads.
3. **What Google's permissions reach.** The plan said Google's permission
   gives access to "the other events on that calendar". Google's own scope
   page (https://developers.google.com/identity/protocols/oauth2/scopes, read
   6 October 2026) describes `calendar.events.owned` as "See, create, change,
   and delete events on Google calendars you own", every one of them, and
   `calendar.events.freebusy` as "See the availability on Google calendars
   you have access to". Now: "Google's permission model also gives healdesk
   access to the other events on the calendars that account owns, and to
   when the other calendars it can see are free or busy; healdesk does not
   read or store them." 1.2.1, which is signed, keeps its narrower sentence.
4. **The calendar election's first section** gains a last sentence, `In the
   clause below, "this agreement" means that Business Associate Agreement.`
   The clause it carries says "this agreement" throughout, as it does in the
   BAA, and an election is not an agreement of its own.
5. **The election's layout** puts PRACTICE, LOCATION and AGREEMENT on lines
   of their own with the value indented beneath, as the BAA's preamble does,
   instead of the plan's two columns, so that a long name wraps inside 78
   columns through the shared `wrap()`.
6. **The Google Calendar disclosure** says which calendar and what Google's
   permission reaches as items 1–3 do, and "When your assistant offers a
   patient times … and, on a call, spoken to the caller by … Retell" where
   the plan said "offers a caller times". Web chat will offer times too,
   reaching no recipient but Anthropic; worded this way, version 1 stays true
   when it does, instead of forcing every connected practice to reconnect.
7. **A booking system that names no product.** The not-used clause omits the
   name for "Something else" ("its booking system does not read …"), and the
   agreement names no system for "Google Calendar only" or "No booking
   system yet". Otherwise the data-sources clause would say healdesk holds no
   credentials to "Google Calendar only", which is false (it holds the
   calendar's OAuth token), or to "Something else". The render guard (§ 12.8)
   enforces it. The manual-booking notice takes the answer's label, as agreed
   with the funnel, and reads "Your booking system" for an answer that names
   no product, whether it is given that answer's label, its id or null.
8. **Copy the plan did not word.** The descriptions under the three Google
   account answers (the plan gave titles only) are worded to hold for a
   manual system too, where the answer is only kept, so none says bookings
   will go anywhere. HighLevel's card note: "In HighLevel, turn on the Google
   Calendar your assistant books into as a conflict calendar. HighLevel then
   stops offering any time your assistant has booked." Its link is carried in
   a field the agreed shape did not list, `setupHelpUrl`.
9. **The notes beside the clauses** (`packages/catalog/src/baa-explainer.ts`).
   The covered and uncovered notes also name the calendar-list read ("healdesk
   reads the names of your calendars, so you can choose the one it books
   into, and when that calendar is free or busy"), which plan § 2.5's notes
   predate; the not-used note is the plan's. The data-sources note is
   reworded, as § 2.5 asked, to hold for 1.2.1 and 1.3.0 alike. The
   subcontractors note is not: its notice period is the point of it. 1.2.1's
   note, which the live checkout shows, stays word for word ("fifteen days'
   notice"), and 1.3.0 has its own (`BAA_CLAUSE_EXPLAINERS_BY_VERSION`): at
   least 24 hours, by email, and an objection that has to come before the
   change takes effect. `clauseExplainer(version, id)` picks between them.
10. **The selections builder's inputs.** The agreed call is unchanged; two
    things are added. `bookingSystem` may be null, for a template before
    1.3.0 signed from today's picker, and an optional `platformId` carries
    the phase-two platform id that picker sends, which only a template
    before 1.3.0 reads (§ 12.8).

### 12.6 The three Q8 additions

§ 3 and § 11 recorded these as 1.2.1 material; 1.2.1 shipped on 1 October 2026
with findings A1–A5 only. Two had wording, reused word for word; one had
only a note, and was drafted.

- **Payments (clause 7), reused from § 6:** "Where Practice takes deposits,
  healdesk creates a payment link through Practice's own payment processor.
  The link and the payment carry an amount, a generic description and a
  reference number, and no service name or clinical detail, including in
  metadata and the statement descriptor. healdesk never takes card numbers."
  Heading "Payments". Unconditional: deposits are a portal switch, not a
  checkout answer, and the clause limits itself ("where Practice takes
  deposits"). Placed after the calendar clause, since both describe what
  healdesk sends into a system the practice contracts for itself. Basis as
  § 6.
- **State law (clause 4), reused from § 9:** the processor terms, heading
  "Where Practice is not a covered entity". Unconditional, for the reason
  1.0.0's patient-rights clause is: practice-status already makes the
  document a data-protection agreement on the same terms where Practice is
  not covered, and a buyer's status answer should not decide whether the
  state-law terms are in it at all. Placed after permitted uses, which it
  qualifies. **Risk R5 is still open**: the clause was drafted without
  re-reading Cal. Civ. Code § 1798.140(ag) and 11 CCR § 7051. The release
  audit reads both and adjusts the text before release (§ 12.11).
- **45 CFR 164.514(b) (clause 8), drafted from § 3's note** ("Cite the
  de-identification standard"): "healdesk may combine Practice's PHI with
  that of other practices only to produce aggregate statistics about the
  Services, de-identified under 45 CFR 164.514(b) (for example, what
  fraction of after-hours calls are answered)." This is 1.1.0's sentence with
  "de-identified, aggregate" reordered to carry the citation. The rest of the
  clause is 1.1.0's word for word, in a new object because 1.2.1's is signed.

The Payments and state-law texts are exported once
(`PAYMENTS_CLAUSE_BODY`, `STATE_LAW_CLAUSE_BODY` in `baa.ts`) for the funnel's
data protection agreement, which the funnel plan (Part L) says shares them.
The state-law text's last sentence names PHI, so a document without PHI has
to word that sentence for itself.

### 12.7 24 hours' notice of a new subcontractor

The owner decided on 6 October 2026 that the next agreement versions give 24
hours' notice by email before a new subcontractor handles protected
information, keeping the right to object
(`docs/design/funnel-portal-contracts-2026-10-06.md` § 6). The sentence lives
once, in `packages/catalog/src/subprocessor-notice.ts`, worded for both
documents that carry it, the BAA and the funnel's DPA:

> "healdesk keeps a current list of its subcontractors at
> healdesk.io/subprocessors and will give Practice at least 24 hours' notice
> by email before adding one that will handle the information this agreement
> protects. If Practice objects on reasonable grounds before the change
> takes effect, Practice may terminate this agreement without penalty."

1.2.1 keeps its fifteen days for anyone who signs it. The Term clause's "the
subcontractor-objection right above" still points at clause 13. The signing
screen's note beside the subcontractors clause names each version's own
period (§ 12.5, item 9). The public register (`/subprocessors`) and `/trust`
still promise every customer at least fifteen days
(`POLICY.subprocessorNoticeDays`), which the release has to reconcile
(§ 12.11, item 10). A day is far shorter than the usual fifteen to thirty,
which weakens the objection right; that is risk 13 in `brief.md`.

### 12.8 The render guard and the one selections builder

- **Render guard.** 1.3.0 carries `validate`, which `renderBaa` calls before
  choosing any clause. It refuses a document without a known booking system,
  without a known Google account kind, or whose `connectedPlatform` is not
  exactly that booking system's name. The clause predicates default a
  missing answer to the most restrictive one, which is right for a predicate
  and wrong for a signature: a practice that was never asked would sign
  "manual booking, no agreement with Google" without having said either.
  Earlier templates have no guard, so nothing about them changes.
- **One builder.** `buildBaaSelections` (`packages/catalog/src/baa-selections.ts`)
  is what both signing paths are to call (`signAgreement` from plan C3, and
  the funnel's AgreementStep), so that the displayed and the stored render
  cannot drift. Neither calls it yet. For a version before 1.3.0 it names a
  phase-two platform exactly as both paths do today: the one in
  `platformId`, the platform id today's picker sends, which covers every
  entry of `platforms`, Zenoti, PatientNow, Acuity and Vagaro included, though
  no booking system maps to them; or, without one, the booking system's
  `phaseTwoPlatformId`. A test renders 1.2.1 and 1.2.0 through the builder for
  every platform and for every booking system, and finds the bytes today's
  paths produce. For 1.3.0 it names the booking system, passes the two
  answers and ignores `platformId`. The sync is derived inside the
  agreement, never passed, so the browser cannot choose "live" for a one-way
  system.
- **Release overlap.** `BAA_RELEASE_OVERLAP` is empty, and nothing reads it
  yet: `validateSignRequest` is to read it from plan C3. At release it keeps
  1.2.1 signable for 72 hours, across the two deploys, and it is emptied once
  both production deployments are verified.

Signing (`apps/app/src/lib/agreements.ts`) and provisioning are unchanged by
this draft.

### 12.9 The calendar election and the Google Calendar disclosure

- **Calendar election, `calendar-election/1.0.0`** (draft,
  `approvedByCounsel: false`). One location's calendar terms, accepted after
  the agreement: for a second location, for a change of booking system or
  account kind, and for a practice that signed before 1.3.0. Three sections:
  what the election does (it takes the place of the agreement's calendar
  clause for that location, and supplements an agreement that does not
  provide for elections), the calendar clause itself without the location
  paragraph, and acceptance by a named person confirming authority. The
  server is to re-render and hash it and store version, hash and text, never
  accepting a hash from the browser (plan C7). Until it is released, only a
  demo clinic's election is to count (plan A10, enforced from C6 and C7).
- **Google Calendar disclosure, `google-calendar-disclosure/1`.** To be
  shown directly above an unticked box and the Google sign-in button (plan
  § 4.2, C8); nothing shows it yet. It says what healdesk reads and adds,
  that the free times it reads go to Anthropic and, on a call, Retell "under
  business associate agreements with healdesk that are signed before any
  patient's information is processed" (both are pending on the register,
  which `apps/web/src/lib/google-disclosure.test.ts` ties to this wording),
  how to disconnect, and Google's Limited Use statement as privacy § 11
  makes it. A new recipient of the times makes a new version that earlier
  acceptances do not cover. The practice's name is put into it verbatim,
  whatever characters it holds (a `replaceAll` with a string would have
  expanded `$&` and its kin in a name).

### 12.10 Checked against 45 CFR 164.504(e) and 164.314(a)

1.3.0 keeps every clause § 2 found meeting each element, unchanged or as a
superset: the subcontractors clause keeps its flow-down paragraph word for
word, and the own-use clause keeps its 164.504(e)(4) paragraph. In the
rendered sample's numbering:

| Element | 1.3.0 clause |
| --- | --- |
| (e)(2)(i) permitted uses; management and administration; aggregation | 3; 8 |
| (e)(2)(ii)(A) no other use or disclosure | 3 |
| (B) safeguards and Subpart C | 10 |
| (C) reporting, including § 164.410 | 12(a), 12(b) |
| (D) subcontractors | 13 |
| (E)–(G) access, amendment, accounting | 14 |
| (H) acting for the covered entity | 15 |
| (I) books and records | 19 |
| (J) return or destroy | 17 |
| (e)(2)(iii) termination for material violation | 17 |
| (e)(4), (e)(5) | 8; 13 |
| § 164.314(a)(2)(i)(A)–(C) | 10; 13; 12(c) |
| Minimum necessary; no sale or marketing use | 11; 16 |

The calendar, payments and state-law clauses add obligations; none removes
one. This is a check of the skeleton, not the release audit.

### 12.11 Left for the release audit

Noticed while drafting and left as the plan worded them:

1. The uncovered clause for "Workspace without it, or not sure" ends "so no
   business associate agreement between Practice and Google covers that
   calendar". If Practice does not know, that may be untrue in fact; consider
   "so the parties treat that calendar as one no business associate agreement
   between Practice and Google covers".
2. The not-used clause's "records a calendar election for that location"
   comes before the BAA's location paragraph introduces the location;
   consider "for the location".
3. The state-law clause limits use to "providing the Services", while the
   own-use clause permits management, administration and de-identified
   aggregation; for a practice that is not a covered entity the two can be
   read against each other. Settle it together with R5 and item 11.
4. The data-sources clause says the only patient information healdesk
   receives is what patients give it in a call or chat. Check it against the
   deposit webhook when deposits are built: if the processor sends healdesk
   the payer's name or email, the sentence needs the Payments clause carved
   out.
5. Every row of § 12.4's table must read "Yes" against the code, or against
   a written process where no code can keep the promise. A row that cannot
   is resolved before release by changing the code, the clause or the site
   copy.
6. The 24-hour notice (risk 13) and the uncovered clause's exposure (risk 12)
   are owner decisions; the audit confirms the text says what was decided,
   not whether it was wise.

Found in review of this draft (6 October 2026), each to be resolved before
release by changing the code, the clause or the site copy:

7. **The covered clause and the calendar picker.** The covered clause says
   healdesk "adds nothing to a calendar whose Google account does not belong
   to a Google Workspace or Cloud Identity organisation", and plan § 4.11
   checks only the connected account's `hd`. The calendar list asks
   `minAccessRole=owner` and nothing else, and Google's calendarList reference
   defines "owner" as a permission level ("The user can read and modify
   events and access control lists"), which a calendar another account shares
   in with "make changes and manage sharing" also has. That account may be a
   personal one or another domain's. Make the promise true in code: for a
   managed account, ask the list with `showOwnOrganizationOnly=true` ("only
   entries for calendars from the organization … only applicable to Google
   Workspace users") in the adapter and C8's picker, or keep covered terms to
   the primary calendar; and verify the chosen calendar again when it is
   chosen. Otherwise narrow the clause to the connected account's
   organisation, and record what remains as a `brief.md` risk.
8. **Thirty days to return or destroy.** 1.3.0 reuses 1.2.1's Term clause:
   "Within thirty days of termination healdesk will return or destroy all
   PHI it holds for Practice". The code destroys at thirty days only once the
   export has been delivered, and otherwise after ninety
   (`DESTROY_AFTER_DAYS`, `DESTROY_WITHOUT_EXPORT_AFTER_DAYS` and
   `dueForDestruction` in `apps/app/src/lib/offboarding/offboarding.ts`). The
   funnel's design flags the same gap for this version
   (`docs/design/funnel-onboarding-portal-2026-10-06.md`, Part L, on main).
9. **The Payments clause describes a link nothing creates.** "Where Practice
   takes deposits, healdesk creates a payment link through Practice's own
   payment processor." No code does: deposit links are package D, which is
   paused, and on a call the assistant states a deposit and never sends a
   link (`depositLine`, `apps/app/src/lib/voice/tools.ts`: "there is none").
   Either package D ships first, or the clause says healdesk "may" create one
   and keeps its limits on what a link carries.
10. **The public notice period.** `/subprocessors` and `/trust` tell every
    customer that a new vendor handling patient information is announced at
    least `POLICY.subprocessorNoticeDays` days ahead, which is 15
    (`apps/web/src/lib/legal.ts`), while 1.3.0 gives 24 hours. The site copy
    has to say which customers get which period, or the clause and the site
    have to agree.
11. **The state-law clause's own references.** It applies "the reporting,
    subcontractor, security and return-or-destroy clauses of this agreement"
    to non-PHI patient information. 1.3.0 has no clause by either of the last
    two names: its headings are "Safeguards", "Reporting breaches and
    security incidents", "Subcontractors" and "Term, termination, and what
    happens to the information", so "security" could be read as clause 10 or
    clause 12, and "return-or-destroy" matches no heading. Its "Practice's
    portal settings" name a portal that is not built yet. The wording is
    § 9's, reused as the owner's answer to Q8 asked; the audit decides
    whether to name the clauses by their headings, which moves the golden
    hashes before release.
12. **The notes on the signing screen.** AgreementStep looks notes up in
    `BAA_CLAUSE_EXPLAINERS` by clause id, which gives 1.2.1's subcontractors
    note ("fifteen days' notice"). Before 1.3.0 is offered it has to look
    them up through `clauseExplainer(template.version, id)`, or a 1.3.0 buyer
    reads fifteen days beside a clause that gives 24 hours.
13. **The gates that are not built yet.** Signing refuses 1.3.0 today only
    because `validateSignRequest` accepts `BAA_TEMPLATES[0]` alone. Plan C3
    makes it accept a version in `BAA_RELEASE_OVERLAP`, and plan C15 makes
    provisioning's approval gate read the bound acceptance's version instead
    of `currentBaaTemplate()`. Both must land before the release.

### 12.12 Golden hashes

Frozen from this draft in `apps/app/tests/baa-golden.test.ts` and
`packages/catalog/src/google-calendar-disclosure.test.ts`. An edit before
release regenerates them in the same commit and is noted here; after
release they never move.

| Document and variant | SHA-256 |
| --- | --- |
| 1.3.0 covered_estimated (the sample) | `770462be01a012ff4221f5a5aabed7503dcb710c5437925d0652d9dde1247d16` |
| 1.3.0 notcovered_estimated | `16b86e85dfc65a421d7e319534c2f8d18b8fbdc9307cb2269fc6d9d0715915f9` |
| 1.3.0 unknown_estimated | `70f8f05cafa4784b2c2107a1d3099a20c8c1b789a66bcc4339886e054fde9ae6` |
| 1.3.0 covered_verified_boulevard | `7361318a1050ceac11a9c0718a6f357d5595f1de85c7cabaa86270fa18cf28db` |
| 1.3.0 uncovered_nobaa | `cb845bcaa7b1e8c542fbef66d20ac4b7428242b0a0e08eba9a344c53582a6071` |
| 1.3.0 uncovered_personal | `25d848c43076aebc26f2273325abd11943cb6311e0e42a93978f143b06aa29f5` |
| 1.3.0 notused_mindbody | `53a9d5482e16a12abf346ae33821659d2707b8290365dfd29420f60abb85840a` |
| 1.3.0 notused_other | `0752e2848c767633bc3e2418911f91d82810d957ce0dc07225bb3cf24d4bd7d9` |
| 1.3.0 live_calcom | `d725371aeab66183b4b54f821d0b0a53878f30c4e013bf26200ac72c7cc08720` |
| 1.3.0 live_highlevel_personal | `144acc18c9e0cd1d08ed33ac160d67ac7d4a8197e3a93b9d8cb2a77141c9fc9d` |
| 1.3.0 live_calendly_nobaa | `f2d0aed20eb500a1e5c3c278048e0a8a1b7854c5cb8628abe69777c8e7b67da3` |
| calendar-election/1.0.0 sample | `d047b3894a46da62c737b2058e7dfedd1134c7c0f8be4517962c6e43b91be8be` |
| google-calendar-disclosure/1 | `a33d569240d4a87171888b0340bcff155a6a69a9097a333dc9a7ef8c3497a83a` |

---

## Review log (2026-10-01)

Adversarial pass on the 1 October draft, then on BAA 1.2.0 and the terms as
shipped the same day. Finding → fix applied.

- **The draft asked twenty-one questions of counsel that reasoning or a
  primary source could settle.** → Each is now a decision with its basis
  (§§ 1, 3, 5, 6, 9, 10) or an open risk with a trigger (below).
- **A3. The Anthropic retention sentence in 1.2.0 clause 11 and terms § 9
  overstates deletion.** Anthropic's published terms allow retention of
  flagged content for up to two years even under HIPAA arrangements. → 1.2.1
  wording given; terms § 9 and `/subprocessors` flagged to the engineer.
  Until fixed, this is a known inaccuracy in a signed agreement (risk R1).
- **A2. Clause 5 describes the Google scope, not the minimum necessary.** →
  Wording and a scope design given (§ 5, § 11).
- **A1. The FTC Health Breach Notification Rule is cited as possibly
  applying to a clinic.** 16 CFR 318.2 does not reach a clinic's booking
  records or healdesk as its vendor. → Replace with state breach and
  consumer-health laws; `docs/incident-response.md` carries the same error
  and is flagged to the lead.
- **A4. Clause 8's "email included" contradicts the SES design and the
  clause's own fail-closed sentence.** → Wording given.
- **A5. No document states the transcript retention period the spec
  requires.** → 1.2.1 clause with an owner decision for the number.
- **Payments had no clause in the BAA and the § 1179 reasoning was
  misattributed.** § 1179 exempts the processor, not healdesk. → Basis
  restated on § 164.506(c), the HHS preamble and the no-clinical-fact
  design; clause proposed.
- **Four documents disagreed about Meta.** → One rule (§ 6) consistent with
  1.2.0 and the terms; `disclosure.ts` and privacy § 12 flagged. The HIPAA
  position on Meta is stated as an accepted risk, not as compliance.
- **The direct-booking addendum's binding mechanism was an open question.**
  → Allocation in terms § 8, accepted at checkout; the switch is
  configuration.
- **The draft said Google might be healdesk's subcontractor.** → Decided
  not: the clinic's own vendor, under the clinic's own agreement; the BAA
  says so.
- **The "15-day notice" and "1.0.0 signer" questions.** → Decided (§ 10).
- **The opening line's "within a day" has no counterpart duty in the
  terms.** → § 8 handover duty proposed (§ 7).
- **Residual risks.** **R1** BAA 1.2.0 is in force with findings A1–A5
  unfixed; the most consequential is A3. Trigger: publish 1.2.1 before the
  first real clinic signs; if a clinic has already signed 1.2.0, send the
  corrected sentence as a notice under the subcontractors clause. **R2**
  The one-way indemnity, the exclusion and the absence of insurance will be
  resisted by some clinics' counsel; enforceability between commercial
  parties is likely but unconfirmed by a lawyer. Trigger: the first redline
  (negotiate: a mutual cap is the usual landing), or any claim (engage a
  lawyer). **R3** Service of process on a UAE entity: the UAE is not a
  party to the Hague Service Convention, so a clinic suing in Delaware must
  serve by letters rogatory unless an agent is appointed. Recommended:
  appoint the Delaware registered agent as agent for service; the owner
  decides, because it makes healdesk easier to sue as well as easier to
  contract with. **R4** The HIPAA position on Meta (§ 6) is an accepted
  risk. Trigger: a covered clinic's counsel objects (offer Meta off or
  request-only), or HHS guidance on social messaging. **R5** The state-law
  clause (§ 9) was drafted without re-reading the California statute.
  Trigger: before 1.2.1 publishes, read Cal. Civ. Code § 1798.140(ag) and
  11 CCR § 7051 and adjust. **R6** Retell's region and subprocessors are
  undisclosed; the privacy page's "United States infrastructure" depends on
  them. Trigger: before the Retell BAA is signed, get both in writing.
