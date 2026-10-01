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
12. [Review log](#review-log-2026-10-01)

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
  and the § 164.514(b) citation.** Add it below 1.2.0 with
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
