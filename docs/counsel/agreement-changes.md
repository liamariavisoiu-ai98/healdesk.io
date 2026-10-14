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
>
> **Since 9 October 2026 the version offered is BAA 1.2.2** (§ 13,
> `docs/baa-v1.2.2.txt`), released by the owner without external counsel.
>
> **Since 12 October 2026 the version offered is BAA 1.3.0** (§ 12.15,
> `docs/baa-v1.3.0.txt`), with the calendar election, released by the owner
> without external counsel after Claude's own audit of the full text against
> the code. No clinic had signed 1.2.2, so 1.3.0 replaced it outright: 1.2.2
> is no longer signable.
>
> **Since 13 October 2026 the version offered is BAA 1.4.0** (§ 14,
> `docs/baa-v1.4.0.txt`): 1.3.0 with its transcript passages said as the
> product now works, since the owner decided that day that each call's and
> website chat's transcript is emailed to the practice and not kept.
> Released by the owner on the owner's own instruction, without external
> counsel; § 14.5 recommends that counsel review it. No clinic had signed
> 1.3.0, so 1.4.0 replaced it outright: 1.3.0 is no longer signable, and
> 1.4.0 is the go-live floor.
>
> **Since 14 October 2026 the version offered is BAA 1.5.0** (§ 15,
> `docs/baa-v1.5.0.txt`): 1.4.0 with the transcript's one encrypted copy
> held only until the practice's mail server confirms delivery, and then
> deleted, rather than for seven days after the email first goes; never
> past 30 days, and 72 hours after a send nothing answered. Released by the
> owner on the owner's own instruction, without external counsel; § 15.5
> recommends that counsel review it. No clinic had signed 1.4.0, so 1.5.0
> replaced it outright: 1.4.0 is no longer signable, and 1.5.0 is the
> go-live floor.

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
12. [BAA 1.3.0: calendar terms, the Q8 clauses and 24 hours' notice](#12-baa-130-calendar-terms-the-q8-clauses-and-24-hours-notice) (released 12 October 2026, § 12.15)
13. [BAA 1.2.2: the list on request, one email address, the spec's breach wording](#13-baa-122-the-list-on-request-one-email-address-the-specs-breach-wording)
14. [BAA 1.4.0: the transcript emailed, not kept](#14-baa-140-the-transcript-emailed-not-kept) (released 13 October 2026)
15. [BAA 1.5.0: the transcript's copy deleted once delivery is confirmed](#15-baa-150-the-transcripts-copy-deleted-once-delivery-is-confirmed) (released 14 October 2026)
16. [Review log](#review-log-2026-10-01)

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

## 12. BAA 1.3.0: calendar terms, the Q8 clauses and 24 hours' notice

> **Released 12 October 2026, and offered from that day (§ 12.15). Not legal
> advice.** What follows down to § 12.14 records the draft as it stood
> before the release, in the words of the day it was written; § 12.15 records
> the release, the audit that preceded it and the two sentences it changed.
>
> **Drafted 6 October 2026.**
> `packages/catalog/src/baa.ts` registers 1.3.0 at `BAA_TEMPLATES[1]` with
> `approvedByCounsel: false`. Checkout does not offer it, and signing refuses
> it: `validateSignRequest` and `signAgreement` both settle the version
> through `signableTemplate` (plan C3), which takes only `BAA_TEMPLATES[0]`,
> or a released version inside its `BAA_RELEASE_OVERLAP` window.
> Provisioning refuses a row signed under it too: since plan C15 its approval
> gate reads the bound acceptance's own version (`isBaaVersionAcceptable`),
> where it used to read `currentBaaTemplate()`. The full text is
> rendered in `docs/baa-v1.3.0.txt` (until its release
> `docs/baa-v1.3.0-draft-calendar-clauses.txt`). The owner decided
> on 5 October 2026 (answer Q2) that Claude releases 1.3.0 and the calendar
> election after its own adversarial audit of the full text, with no counsel
> gate: against 45 CFR 164.504(e), the code's actual behaviour, the spec, the
> terms and the privacy page. The audit's findings are to be recorded here,
> and the owner is told the release was made without counsel.
>
> That audit ran on 6 October 2026 and redrafted most clauses (§ 12.14).
> Sections 12.1–12.13 describe the first draft; where they quote its wording,
> § 12.14 and the regenerated text govern, and § 12.14's release gates come
> before the release.

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
data-sources clauses and one of the three calendar clauses. (Since § 12.14,
twenty-two: `data-sources-verified` is no longer registered, and the render
guard refuses verified reporting.)

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
| Reads the names of the calendars on which the account has owner access, free or busy for the calendars it uses, and its own events; reads no other event | `packages/connectors/src/google/adapter.ts`: the calendar list asks `minAccessRole=owner`; free/busy asks only for the chosen calendar; `verify()` lists events with a filter no event matches and asks for no event fields | Yes for one calendar (plan C1); one per provider from C6, C8 and C12 (§ 12.14, gate 2) |
| An event carries the first name the person booking gave (else "Patient"), the service as the practice's list names it (else "Appointment"), and the time; nothing clinical beyond the service's name; private, no invitees, no reminders; nothing moved, edited or cancelled that healdesk did not create | `packages/connectors/src/google/event.ts` (`sanitizeFirstName`, `eventServiceLabel`); the adapter refuses to cancel an event without healdesk's marker | Yes (C1) |
| The token is held encrypted and used for nothing else | The sealed credential envelope (`apps/app/src/lib/connections/store.ts`) | Envelope yes; Google rows from C7–C8 |
| Use stops when the Services end; the token is deleted on a disconnect through healdesk, when healdesk finds access removed at Google, and at destruction | Plan § 4.12 and § 9: `eraseCredentials`, `markCalendarBroken`, `sweepCalendarTerms`, destruction | No (C7, C8, C10) |
| Covered: healdesk checks, when a calendar is chosen and again before each write, that the account belongs to a Workspace or Cloud Identity organisation and that the calendar belongs to that same organisation, and adds nothing to a calendar that fails | Reconciliation at connect (plan § 4.11) and `app_calendar_write_permitted` (§ 11.6) look only at the connected account (its `hd`) and the terms. The calendar list asks `minAccessRole=owner` with no organisation filter (`CALENDAR_LIST_QUERY` in the adapter), and Google lists as `owner` a calendar another account has shared in with "make changes and manage sharing". The owner's decision 4 of 6 October 2026 makes C8 the guardrail (§ 12.14, gate 1) | No (C8) |
| Uncovered: withdrawal stops further writes; not used: nothing connected | The start route refuses not-used terms; a not-used election erases any connection (plan § 2.6, § 4.12) | No (C7, C8) |
| Payments: healdesk may send a link in website chat or on Instagram, Messenger or WhatsApp, through Practice's own processor; on a call none, and the deposit is flagged for staff; a link, and what healdesk sends the processor, carry only an amount, a generic description and a reference number; no payer details kept from the processor's notice | On a call: `depositLine` in `apps/app/src/lib/voice/tools.ts` states the deposit and sends nothing. Links (since 7 October 2026, package D, 249e3a9): `createDepositLink` in `apps/app/src/lib/billing/deposit-link.ts`, through the practice's own Connect account, "Appointment deposit", descriptor suffix DEPOSIT, metadata `{hd, ref}`, every string checked for a treatment name, no processor payload kept; sent only through `apps/app/src/lib/booking/deposit-gate.ts`, never on a call | On a call, yes; links, yes (§ 12.14, gate 10; § 12.15) |
| Payments: healdesk never takes card numbers | Nothing in `apps/app` asks for, parses or stores a card number, and 1.2.1's minimum-necessary clause says the same. One a patient volunteers would sit in the conversation transcript like any other words; the audit weighs that against "never takes" | Yes, by absence |
| State law: processes patient information only on Practice's documented instructions (this agreement and the portal settings) and for purposes a–i; does not sell or share it as 1798.140 defines the words; combines it with other sources only for security and fraud | Nothing in the code sells, shares or combines it across clinics (identifier references are keyed per clinic). The portal the instructions name is not built yet (the funnel session builds it) | By design |
| State law: gives Practice what it needs for a consumer's access, deletion or correction request within ten business days; deletes one person's information within ten business days, raw copies from other services included, and from backups within 35 days after | Operator tools in `apps/app/src/lib/patient-rights/export.ts`: `exportPatient` (access) and `amendContact` (correction), and since 12 October 2026 the operator's `ops:amend-record` and `ops:amend-contact` scripts in apps/app's own shell, which append an amendment beside a booking request, a conversation or an appointment (`record_amendments`) that both exports carry. Since 8 October 2026 a deletion (`apps/app/src/lib/patient-rights/erasure.ts`, run since 12 October 2026 by the `ops:erase-person` script in apps/app's shell, never apps/web) deletes one person, their raw payloads and their own messaging threads included, records the request without their number, and shows each subcontractor step outstanding with its ten-business-day deadline; backups age out at the host's 35 days (gate 18) | Deletion, yes (§ 12.14, gate 6); correction, yes (gate 8) |
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
to word that sentence for itself. (Since § 12.14 the state-law text is the
function `stateLawClauseBody`, which renders either agreement's wording, and
the Payments clause names no patient, so the DPA shares it as it is.)

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

(As drafted on 6 October. On 9 October the first sentence changed in place,
both documents being unreleased: healdesk gives Practice its current list on
Practice's written request to healdesk's email address in the Notices
clause, and the public page is gone; § 13.)

1.2.1 keeps its fifteen days for anyone who signs it. The Term clause's "the
subcontractor-objection right above" still points at clause 13 (since
§ 12.14 it says "under the Subcontractors clause", and the notice also says
where it goes and what it names). The signing
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
  is what both signing paths call, so that the displayed and the stored
  render cannot drift: `signAgreement` since plan C3, and the funnel's
  AgreementStep from its M2. For a version before 1.3.0 it names a
  phase-two platform exactly as both paths did before it: the one in
  `platformId`, the platform id today's picker sends, which covers every
  entry of `platforms`, Zenoti, PatientNow, Acuity and Vagaro included, though
  no booking system maps to them; or, without one, the booking system's
  `phaseTwoPlatformId`. A test renders 1.2.1 and 1.2.0 through the builder for
  every platform and for every booking system, and finds the bytes that
  derivation produces. For 1.3.0 it names the booking system, passes the two
  answers and ignores `platformId`. The sync is derived inside the
  agreement, never passed, so the browser cannot choose "live" for a one-way
  system.
- **Release overlap.** `BAA_RELEASE_OVERLAP` is empty until the release.
  Since plan C3, `signableTemplate` reads it for both `validateSignRequest`
  and `signAgreement`: a version listed there signs only if it was released,
  and only before its deadline, an ISO 8601 instant that carries its own
  offset. At release it keeps 1.2.1 signable for 72 hours, across the two
  deploys, unless the release raises the go-live floor
  (`MIN_ACCEPTABLE_BAA_VERSION`, §10) past 1.2.1, when 1.2.1 is not listed.
  It is emptied once both production deployments are verified.

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
   (Since 7 October 2026 the code keeps each agreement's own rule: 1.2.1 and
   earlier destroy before thirty days are up whatever the export, and the
   ninety days apply only where the agreement states them; drizzle/0058 and
   release gate 7 in §12.14.)
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
13. **The gates on an unreleased version.** Signing refuses 1.3.0 today
    because `signableTemplate` takes `BAA_TEMPLATES[0]`, or a released
    version inside its `BAA_RELEASE_OVERLAP` window, and 1.3.0 is neither.
    Plan C3, which made both signing paths settle the version that way, has
    landed, and so has plan C15, which makes provisioning's approval gate
    read the bound acceptance's own version (`isBaaVersionAcceptable`)
    instead of `currentBaaTemplate()`: a row signed under 1.3.0 provisions
    nothing until the release.

The pre-release audit (§ 12.14) settled these: items 1 (ICD-17), 2
(ICD-25), 3 (ICD-05, SL-01), 4 (ICD-11), 8 (HRC-02) and 11 (PT-29) are fixed
in the text; item 7 is fixed in the text and kept in code by C8 (HRC-04);
item 9 is fixed in the text ("may") with package D a release gate (PT-11);
items 5, 10, 12 and 13 are release gates in § 12.14; item 6 stands as the
owner decided it, and decision 1 of 6 October 2026 confirmed risk 12. Item
12's clause notes are done: apps/web's `agreement-kinds.ts` reads them
through `clauseExplainer(template.version, …)` since the four-step funnel.
The explainer's bullets are not yet read by version; gate 11 now covers
them.

### 12.12 Golden hashes

Frozen in `apps/app/tests/baa-golden.test.ts` and
`packages/catalog/src/google-calendar-disclosure.test.ts`. Each edit before
the release regenerated them in the same commit and is noted here; since the
release of 12 October 2026 (§ 12.15) they never move. The table gives them as
released.

| Document and variant | SHA-256 |
| --- | --- |
| 1.3.0 covered_estimated (the sample) | `d9117482bba644006763a9d613d94ec0a38a3f8888a95b61ad6fbb6f3a68acb3` |
| 1.3.0 notcovered_estimated | `a6ea77cff3246a10df40859b7a71a44d2ea2bf11772942f7f8b00bd937779c06` |
| 1.3.0 unknown_estimated | `43071c322a261d4fe71aa835412f43e058a954ab427c0004304687819fccf488` |
| 1.3.0 uncovered_nobaa | `62655a3bc397c4f3371de8fa46bb51db660bf4224c997c520779be29caabad72` |
| 1.3.0 uncovered_personal | `0ad19a5bcdbe4db23ce702b018662d60875f72ceaed81286b6a20b9910f21992` |
| 1.3.0 notused_mindbody | `e67b1d66265d1fdfbb612460a2222f3ee146fdca49c0246c2af59e25ad072494` |
| 1.3.0 notused_other | `809c0a3bd67a79338d6bb86af1995bfb4324636328e83249f69777c83ff82693` |
| 1.3.0 live_calcom | `0b592d023aceb51924619c8e24e08e92f3a55152d4c8dec3eddf3e1940655365` |
| 1.3.0 live_highlevel_personal | `baaee81c9513280a40310e35a241311f9a6bcaed8b9db685baa0630bf8e1d0e0` |
| 1.3.0 live_calendly_nobaa | `62ca9ad483f57dc46c886ab2ab0d422ae151f7dee3ac18309cc62cce2e894978` |
| calendar-election/1.0.0 sample | `63586893a436803155ee71811ea17a8d71800a0d90ce41e1b3d9c596650a02aa` |
| google-calendar-disclosure/1 | `5b3fa42bf21ce7ab880bb869f16f19d6953f87b576f67b0c431eb8eb273387d5` |

The 1.3.0 hashes were regenerated on 6 October 2026 by the edits in § 12.13,
and again by the pre-release audit's redraft (§ 12.14), which also moved the
election's and the disclosure's: neither has been released, accepted or
shown. The verification of that redraft (7 October) moved the ten 1.3.0
hashes once more, and not the election's or the disclosure's. So did the
booking-request destruction fix the same day (drizzle/0054), by clause 11's
sentences on booking requests and contact details: they said a booking
request was kept with the contact details of the person it concerns, as the
purge did while requests went with their contact by cascade. A confirmed request holds its appointment, so that rule
could not hold beside the appointment's own 90 days, and the purge now
judges a request by its own dates, which nothing moves once it is decided.
The clause says so: a booking request is kept for 90 days after the latest
of when it was made, the time it was confirmed for and its appointment's
time, and a person's contact details while any record of theirs is kept.
`tests/booking-request-destruction.test.ts` holds the purge to the
sentence. 1.3.0 /
covered_verified_boulevard is gone: 1.3.0 refuses verified reporting
(HRC-17), and the golden test asserts the refusal instead. The 1.3.0
covered_outbound hash equals covered_estimated, as in every version since
1.2.0. The owner's decisions of 9 October 2026 moved the ten 1.3.0 hashes
again (§ 13): the shared subcontractor sentence gives the list on request,
the Notices clause names hello@healdesk.io, and the reporting clause carries
the spec's 60-day wording. The election's and the disclosure's did not move.
The release audit of 12 October moved the ten 1.3.0 hashes, by its two
text fixes in clauses 11 and 14(b) (§ 12.15); until then 1.3.0 /
covered_estimated was
`ba71a44659a5b376fb89c22640fc61eb0c6b2e073162156b9bca1a45d9d8ed86`. The
owner's decision on the second read the same day, before anything was
pushed, moved them a last time (§ 12.15, "The second read and the owner's
wording"): clauses 11 and 16 describe the Meta safeguards rather than
promise outcomes, and the last sentence of 14(b) names the exports and
healdesk's screens rather than every later use. Until then 1.3.0 /
covered_estimated was
`2235429b5b23f49ae004ad2d414bfba630e108bdd36f7793dd1712859844d607`. The
release itself moved none: nothing in the text marks a draft.

### 12.13 The owner's choices between two 1.3.0 texts (6 October 2026)

A second session had drafted its own 1.3.0 on 3 October and marked it
released, but it never reached main: production offered only 1.2.1, and
nobody signed it. Two documents cannot share a version, so the owner chose,
clause by clause, what this draft keeps. Each choice below is in the text and
asserted on every variant in `apps/app/tests/baa-golden.test.ts`.

| Clause | Kept |
| --- | --- |
| Practice's Google Calendar | This draft's three clauses, chosen by the practice's answers (§12.4). |
| Where Practice is not a covered entity | Both: the shared §9 paragraph (`STATE_LAW_CLAUSE_BODY`, which the funnel's DPA also carries) inside the other draft's full clause. That clause says when it applies whatever Practice has said about its status, defines "patient information" for that period, names the CCPA, Washington's My Health My Data Act, Nevada's consumer health data law and the Connecticut Data Privacy Act, lists the purposes and the data, sets deletion within ten business days, gives Practice assessment rights, and adds the CMIA sentence. Its pointer to the subcontractor notice reads 24 hours. |
| Payments | This draft's one paragraph (§6). |
| Notice of a new subcontractor | 24 hours (§12.7). |
| Term | 1.2.1's: return or destroy within thirty days, an export on request before then. Added: where an export was asked for and has not been delivered by then, destruction follows its delivery, and in no case later than ninety days after termination. |
| Where healdesk acts in your place | "replying in Practice's name to a patient who writes", not "sending messages in Practice's name": v1 is inbound only. |
| Own use | The other draft's: de-identify under 164.514(b) first, then combine with other practices' de-identified information for aggregate statistics, and never re-identify. Heading "healdesk's own use, and de-identified statistics". |

For the release audit (§12.11): the shared paragraph and the full clause
overlap. Both forbid combining patient information, the paragraph "except as
the Services require" and the clause with two named exceptions. The clause
says it governs where they differ, so the narrower reading holds, but the audit
should decide whether the paragraph's own sentence stays. The go-live floor
(`MIN_ACCEPTABLE_BAA_VERSION`, migration 0048) is 1.2.1 while 1.3.0 is a
draft. Whether releasing 1.3.0 raises it is part of that release.

### 12.14 Pre-release audit, 6 October 2026

> **Not legal advice.** This records the adversarial audit of the full merged
> 1.3.0 text that the owner's answer Q2 makes the condition of its release,
> what it found, what was done with each finding, and what must still happen
> before 1.3.0 is released. 1.3.0 stays at `BAA_TEMPLATES[1]` with
> `approvedByCounsel: false` until every release gate below is closed.

#### Method

Four auditors each read the whole of the merged 1.3.0 text through one lens:

1. **HIPAA**: every element of 45 CFR 164.504(e)(2)–(e)(5), 164.314(a),
   164.410 and the Privacy Rule provisions the clauses cite, read in the
   eCFR;
2. **internal consistency**: every clause against every other, every defined
   term and every cross-reference;
3. **state law**: the processor and service-provider terms of the CCPA and
   11 CCR 7050–7051 (the CPPA's 2026 text), Washington's My Health My Data
   Act, Nevada's NRS 603A, the Connecticut Data Privacy Act, and California's
   CMIA and breach law;
4. **product truth**: every factual sentence against
   `docs/v1-product-spec.md`, the code on main (74dc279) and the public pages.

They read all 45 distinct documents checkout can produce (every booking
system, Google account kind and covered-entity answer) and the three
phase-two renders. A second agent per lens then tried to refute each finding
against the renders and the primary sources. 94 findings were confirmed (6
blockers, 46 major, 42 minor after verification) and none was left uncertain.
Four drafters then redrafted one clause group each (frame, state law, data
and calendar, lifecycle) under the owner's decisions below and the
cross-clause decisions in the redraft brief, and one integrator merged them,
resolved what each draft needed from the others, and rendered every variant
again (every line inside 78 columns, every cross-reference naming a heading
of the same document; now pinned by `packages/catalog/src/baa.test.ts` and
`apps/app/tests/baa-golden.test.ts`).

Primary sources read for the redraft, beyond the audit's: the eCFR API for 45
CFR 160.103, 164.304, 164.314, 164.402, 164.404, 164.410, 164.412, 164.500,
164.501, 164.502, 164.504, 164.506, 164.514, 164.520–164.530 (6 October 2026);
the HHS sample business associate agreement (archived); Conn. Gen. Stat.
chapter 743jj (cga.ct.gov); RCW 19.373.040, .060 and .100 (app.leg.wa.gov);
the CPPA's 2026 approved regulation text (11 CCR 7022, 7050, 7051); Cal. Civ.
Code 56.10 and 1798.82 (leginfo, read through web.archive.org captures of 2
January and 23 September 2026, since leginfo refuses automated access); and
Google's OAuth scopes page.

#### The owner's four decisions (6 October 2026)

Put to the owner in chat at about 18:10 Dubai time as the four blockers the
HIPAA lens had raised (before the verification pass, which confirmed all
four), the owner answered, verbatim:

1. On HRC-01 (a covered practice directing writes into a Google calendar no
   business associate agreement covers): "If the practice decides to do it
   itself, it's their problem and you need to not overthink it from our end.
   So let's keep it as it is."
2. On HRC-02 (destruction promised at 30 days, while the product keeps data
   up to 90 when no export was downloaded, and backups are unmentioned):
   "Ok.", recorded the same evening as: make 1.3.0's Term clause say what the
   product does.
3. On HRC-03 (the infeasibility sentence limits further uses, not
   disclosures): "So what? Implement what you think is best here."
4. On HRC-04 (the covered clause's calendar picker could offer a calendar
   shared in from another account or domain): "Yes, guardrail it."

And: "The rest, do your job". Everything else below is Claude's decision
under that instruction; the commercial ones are flagged for the owner.

#### Counsel's approval, as the owner reported it

The owner reported on 6 October 2026 (open items, "counsel", 12:09 Dubai
time) that counsel reviewed five questions and "approved them all to go ahead
and implement": the DPA's clauses, the plan-start and refund terms, the
notice a practice gives if it starts billing insurance, **the calendar
version of the BAA**, and **the 24-hour subprocessor notice**. That approval
was given before the fuller state-law, own-use, term and acting-in-your-place
texts were merged in (6dc50a7, 15:13 the same day) and before this redraft,
so it covers the calendar clauses and the 24-hour notice as they then stood:
not the merged text, and not this redraft's edits to the calendar clauses
(each calendar per provider, the organisation check, "treat" for a Workspace
nobody has confirmed, what an event carries). The release rests on this
audit and its gates (Q2), not on counsel's approval of the merged text.

#### What changed, in short

Clause by clause, the comment above `CLAUSES_1_3` in
`packages/catalog/src/baa.ts` lists the changes; the regenerated text is
`docs/baa-v1.3.0.txt`. The cross-clause decisions:

- **One breach and incident rule for every practice**: notice immediately
  following discovery and within 24 hours, subject to 164.412's
  law-enforcement delay. The notice is itself the written report, as
  complete as healdesk can then make it, with everything 164.410(c) and
  164.404(c) require (the identification of each individual included),
  supplemented promptly as learned. It also meets Cal. Civ. Code 1798.82(b),
  and "breach" includes a state-law breach of security.
- **Destruction as the product does it** (decision 2), in the rule and words
  the funnel's DPA 1.0.0 states and `dueForDestruction` keeps (redraft brief,
  7 October 2026): the export delivered unasked within 30 days after the
  Services end; destruction 30 days after they end if the export has been
  delivered by then, otherwise as soon as it is delivered, and in any case no
  later than 90 days, whether or not it has been; "delivered", never
  "downloaded". Backups within 35 days after that (`BACKUP_RETENTION_DAYS`),
  the one backup figure the document uses; further uses and disclosures
  limited (decision 3).
- **Termination**: Practice may terminate on determining a material
  violation (164.504(e)(2)(iii)); ending the agreement ends the Services the
  same day, and the Services end when the subscription does, however it
  ends, the pass-through to the direct line after it not continuing them; the
  agreement prevails over the Terms on termination and Fees; the refund on
  termination for healdesk's violation or on objection is outside the
  liability clause's exclusion and Practice's indemnity.
- **Covenants, not statements of fact**, for Anthropic's agreement ("signed
  before any patient's information reaches it") and for where PHI is kept
  (at rest only in the United States, encrypted, and only with subcontractors
  that do the same).
- **The state-law clause** (`stateLawClauseBody`, shared with the funnel's
  DPA) states each thing once; the more protective clause governs; its
  calendar purposes and data follow the booking sync; CMIA moved to clause 3
  for every practice.
- **Headings**: clause 6 is "Google Calendar" (so "the Google Calendar
  clause" names it exactly), clause 5 "What healdesk reads from Practice's
  systems", clause 15 "Where healdesk acts in Practice's place"; clause 20
  says a clause named by words from its heading is the clause whose heading
  contains them. The phase-two `data-sources-verified` is no longer
  registered: 22 clauses, 20 rendering.

§12.13's note that "the clause says it governs where they differ, so the
narrower reading holds" was wrong: the precedence sentence ranked clause 4
against other clauses, never against its own paragraphs (ICD-03, SL-01). The
redraft removes the overlap instead.

#### Verification of the redraft (7 October 2026)

Verifiers then checked the integrated redraft against every finding, all 45
renders and the code on main, and raised one major issue and ten minor ones.
Each is closed below, in the text, a release gate or the DPA switch:

- **The written report had no deadline** (major; HRC-05, HRC-12, PT-16).
  Clause 12 timed the 24-hour notice and later additions, but not the report
  under them, which carries the identification of each individual
  (164.410(c)(1)) and the 164.404(c) items, so it could have come after the
  sixty days 164.410(b) allows. Each notice is now itself the written report,
  as complete as healdesk can then make it, added to promptly. The runbook
  already sends it that way (`incident-response.md`, step 5).
- **Destruction when the export never arrives** (HRC-02, PT-01). Clause 17
  said "within thirty days after termination, or by the day after Practice
  downloads the export if that is later". For a practice that never
  downloads, the second date never comes, so read literally only "within
  thirty days" applied, which the product does not keep. It now states the
  DPA's rule, as the brief of 7 October requires: destruction 30 days after
  the Services end if the export has been delivered by then, otherwise as
  soon as it is delivered, and in any case no later than 90 days, "whether
  or not the export has been delivered". The verifier's own wording
  ("downloaded") was not used, because the brief rules that word out.
- **The refund against clause 18** (HRC-07, SUB-03). Clause 18 excluded all
  liability "arising out of or relating to this agreement", and Practice's
  indemnity reached "the Services". It now says that nothing in it limits
  the refund the Term clause provides, and that the indemnity does not
  extend to a claim for it, as Terms §13 keeps its own refund outside its
  limits.
- **The pass-through kept the Services running** (ICD-19, PT-25). "Services"
  meant everything provided under the Terms, the pass-through after the end
  included, so a practice that left forwarding on could argue that the
  agreement, and with it the export and destruction clocks, never ended.
  Clause 1 now says the Services end when the subscription does, however it
  ends, and that the pass-through after it does not continue them.
  Offboarding starts at that point.
- **The first location** (ICD-26). The location paragraph anchored on "the
  order Practice placed when it accepted this agreement". A 1.2.1 practice
  that accepts 1.3.0 places no order when it does, so no location was
  covered. It now names Practice's first location, the one set up under the
  first order Practice placed for the Services. The election does not carry
  that paragraph, so its hash did not move.
- **The explainer's bullets** (HRC-03, HRC-07, adjacent). "Why you're
  signing this" paraphrased (e)(2)(ii)(J) as "use it only" and (e)(2)(iii)
  as "if we materially breach it": narrower than the regulation and than
  1.3.0's clause 17. `baaExplainerTerms(version)` now gives 1.3.0 "limit its
  use and disclosure" and "if you determine that we have violated a material
  term of it". 1.2.1 keeps its bullets word for word, because its clause
  still says "use" and "materially breaches". Gate 11 has the screen read
  them by version.
- **The erasure's suppression row** (SL-06). Clause 4(c) allows only a
  record of the request, kept no longer than healdesk needs it to keep the
  information deleted and used for nothing else. `eraseContact` keeps the
  telephone number in `suppressions` permanently. The text stays as it is,
  because it is the lawful promise: 11 CCR 7022 allows a record of the
  request only "for the purpose of ensuring that the consumer's personal
  information remains deleted", and Washington's My Health My Data Act has
  no such exception for consumer health data. The code changes instead,
  under gate 6.
- **Booking requests and the purge** (PT-28). A returning person's Meta
  request reuses their contact without touching `updated_at`, so the purge
  would delete it, by cascade, as soon as their older call aged out. Gate 9
  now keeps a contact while a booking request made in the last 90 days
  refers to it.
- **The interim Meta copy** (PT-12). Terms §9, `/trust` and the
  `/subprocessors` Meta row tell every customer today that clinical content
  is caught when it arrives, while `front-door.ts` hands the raw text to the
  model first. Gate 4 now keeps the Meta front door off for every clinic
  until the screen runs, or the copy changes first.
- **The DPA switch** (two issues). Widening `CALENDAR_PERSON_NOUNS` for
  "Patient" would have made the DPA misdescribe the event `event.ts` writes,
  and the DPA does not define "calendar election". Both are covered under
  "The funnel's DPA" below.

The re-run afterwards: every 1.3.0 document renders inside 78 columns, and
every cross-reference resolves (`baa.test.ts`). The frozen 1.2.1, 1.2.0,
1.0.0 and draft hashes did not move, and neither did the election's or the
disclosure's. The ten 1.3.0 hashes and the DPA's eight moved (§ 12.12;
`dpa.test.ts`).

#### All 94 findings

One disposition each: TEXT (fixed in 1.3.0's text), OWNER-KEPT, CODE-MINE
(the calendar build), CODE-ROUTED (another session's code, a release gate)
or PAGE-C19 (a public page changed at release). None was found not to be a
defect. Severity is the verifier's.

| ID | Severity | Disposition | What was done |
| --- | --- | --- | --- |
| HRC-01 | blocker | OWNER-KEPT | The uncovered calendar clause stays open to a covered practice, practice-directed, first name, service and time (decision 1). Clauses 3 and 9 keep the regulation's words, with no calendar carve-out, so a covered practice's direction is its own risk, its cost borne under clause 18 (e, g). Owner-accepted risk (brief.md risk 12). |
| HRC-02 | blocker | TEXT | Clause 17 says what the product does, in the DPA's rule: the export delivered unasked within 30 days after the Services end; destruction at 30 days if it has been delivered by then, otherwise as soon as it is, and never later than 90 days whether or not it has been; backups within 35 days. Offboarding code is a release gate. |
| HRC-03 | blocker | TEXT | Clause 17 limits further uses and disclosures of what cannot be returned or destroyed (164.504(e)(2)(ii)(J)). |
| HRC-04 | blocker | CODE-MINE | Clause 6 (covered) now says healdesk checks, at choice and before every write, that the account is managed and the calendar belongs to its organisation; C8 keeps it (release gate). |
| HRC-05 | major | TEXT | Clause 12's report carries 164.410(c) and the 164.404(c) items: identification of each individual, dates of breach and discovery, steps individuals should take, mitigation, any law-enforcement delay. Each notice is itself that report, as complete as healdesk can then make it, so it is due within the 24 hours (verification, 7 October). |
| HRC-06 | minor | TEXT | Clause 12 states 164.412's law-enforcement delay. |
| HRC-07 | major | TEXT | Clause 17: Practice terminates on determining a material violation; termination ends the Services; no Fees after, and a refund, on termination for violation or objection (owner flag), which clause 18's exclusion and Practice's indemnity do not reach. |
| HRC-08 | minor | TEXT | Clause 3 names the own-use clause as its exception and tracks 164.504(e)(2)(i) ("if done by Practice"). |
| HRC-09 | major | TEXT | Clause 4 rebuilt: one statement each of instructions, purposes, data, retention, combination and sale or share. |
| HRC-10 | major | TEXT | Clause 16's ban stays absolute by recipient, with an express exception for the Meta replies; the accepted risk (R4) is stated in paragraphs of its own. |
| HRC-11 | major | TEXT | Clause 13 states Anthropic's agreement as a covenant: content reaches it only under a BAA signed before any patient's information does. Terms §9 follows at release. |
| HRC-12 | major | TEXT | CMIA undertaking moved to clause 3, for every practice; the one 24-hour rule meets 1798.82(b) whatever the status; 4(f) points to clause 12. |
| HRC-13 | major | TEXT | Clause 10: PHI at rest only in the United States and encrypted, a covenant reaching subcontractors. Retell's region in writing is a release gate (R6). |
| HRC-14 | minor | TEXT | Clause 17: the record of disclosures goes to Practice with the export; healdesk's copy holds references only and is kept as its own practice, not as a duty 164.530(j) puts on it. |
| HRC-15 | minor | TEXT | Clause 11: "asks the person booking for no more than"; anything else said is kept only in that transcript; Meta clinical content not kept. |
| HRC-16 | minor | TEXT | Clause 4's calendar purpose, data and recipient render by the booking sync; a manual practice has them only under an election. |
| HRC-17 | minor | TEXT | The render guard refuses verified reporting; `data-sources-verified` is not registered in 1.3.0. |
| ICD-01 | major | TEXT | Clauses 3 and 9 carry the own-use exception (164.504(e)(2)(i)(A); the HHS sample BAA). |
| ICD-02 | major | OWNER-KEPT | As HRC-01. No reconciling sentence in clause 3 or 9: it would make the agreement authorise what 164.504(e)(2)(i) forbids. |
| ICD-03 | major | TEXT | As HRC-09: instructions are this agreement and the portal settings; purposes specific (11 CCR 7051(a)(2)). |
| ICD-04 | major | TEXT | As HRC-16: manual variants claim no calendar connection, data or send. |
| ICD-05 | major | TEXT | Clause 4 purpose (i): de-identified statistics, used only to measure and improve the Services; clause 8 permits for a non-covered period only what clause 4 permits. |
| ICD-06 | major | TEXT | One end for the data: clause 4 defers to clause 17 (export, 30/90 days, 35-day backups, a subcontractor's retention for its purpose and period only). |
| ICD-07 | major | TEXT | Clause 4(c) excepts what clause 13 lets a subcontractor keep for abuse detection and security, or by law, for that purpose and period only. |
| ICD-09 | minor | TEXT | Clause 4's sentence on the record of disclosures removed; clause 17 is the one statement. |
| ICD-10 | major | TEXT | Payment links are clause 4's purpose (c) and a permitted send, by reference to clause 7. |
| ICD-11 | minor | TEXT | Clause 5 names every source of PHI; clause 4's data list matches it, with no email. |
| ICD-12 | blocker | TEXT | As HRC-11. |
| ICD-13 | major | PAGE-C19 | `/subprocessors` and `/trust` move to 24 hours for 1.3.0, the notice address and the objection timing at release; clause 13 now says where the notice goes and what it names. |
| ICD-14 | major | TEXT | As HRC-10. |
| ICD-16 | minor | TEXT | Clause 18 drops "as section 14 of the Terms provides"; carries §14's indemnitees, triggers and defence paragraph and §13's cap; the carve-out now reaches the exclusion too, as §13's does (owner flag). |
| ICD-17 | major | TEXT | A Workspace nobody has confirmed: the parties treat the calendar as uncovered, and Google "may" hold the appointment. |
| ICD-18 | major | TEXT | The party line gives the registered address (legal.ts); the Delaware mailbox appears only in clause 20, as a mailing address with its disclaimer. |
| ICD-19 | minor | TEXT | Clause 1 defines "Services" and "Fees", and says the Services end when the subscription does, the pass-through after it not continuing them; the preamble points to the Definitions clause. |
| ICD-20 | minor | TEXT | "a practice in the field of {specialty}", in the catalogue's own words. |
| ICD-21 | minor | TEXT | Clause 2 reworded: no capital NOT, one name for the transaction, "so believes". |
| ICD-22 | minor | TEXT | Clause 20's rule for clause names; clause 6 headed "Google Calendar"; clause 4 names clauses by exact heading; every reference checked in every variant. |
| ICD-23 | minor | TEXT | Clause 1 defines patient information, HIPAA, its two Rules, covered entity and business associate; "PHI" throughout; clause 18 names state privacy, consumer-health-privacy and breach-notification laws. |
| ICD-24 | minor | TEXT | "Practice" in clauses 3, 14 and 15; headings "What healdesk reads from Practice's systems" and "Where healdesk acts in Practice's place". |
| ICD-25 | minor | TEXT | The not-used clause credits the classification to healdesk's list and says "for the location". |
| ICD-26 | minor | TEXT | Clause 1 defines a calendar election and makes an accepted one part of the agreement; the location paragraph names Practice's first location, the one set up under its first order (which a practice moving from 1.2.1 also has), and the account kinds; clause 20's entire-agreement sentence includes elections. |
| ICD-27 | minor | TEXT | Clause 5: no credentials to the system "or to any other booking, practice-management or point-of-sale system". |
| ICD-28 | minor | TEXT | Clause 6: nothing clinical "beyond the name of the service". |
| ICD-29 | minor | TEXT | As HRC-15. |
| ICD-30 | minor | TEXT | Clause 20 grants the change-in-law termination itself, ending the Services; the Term clause then applies (owner flag: no refund term). |
| ICD-31 | minor | TEXT | One notice address for Practice, its account's email; a notice is effective when delivered; the Delaware courts have exclusive jurisdiction. |
| ICD-32 | minor | TEXT | Export unasked within 30 days; "termination" is the day the agreement and the Services end; token use stops when the Services end. |
| ICD-33 | minor | TEXT | Clause 1's "breach" includes a state-law breach of security, which clause 12 reports within 24 hours. |
| ICD-34 | minor | TEXT | As HRC-12. |
| ICD-35 | minor | TEXT | As HRC-17. |
| SL-01 | major | TEXT | As HRC-09: the shared paragraph's duplicate sentences gone; "sell or share" only as 1798.140 defines them; own management and administration ruled out except as state law expressly permits. |
| SL-02 | major | TEXT | The more protective clause governs; clause 4's looser allowances (six-month backups, combining identifiable data for statistics, calendar purposes for manual practices) are gone. |
| SL-03 | major | TEXT | Combination only for security and fraud; statistics only from information already de-identified (clauses 4 and 8). |
| SL-04 | minor | PAGE-C19 | Clause 8 carries the state de-identification conditions once, for every practice; `/privacy` must publish the commitment before release. |
| SL-05 | major | TEXT | Clause 4(c) carves out the subcontractor retention, and the flow-down is a covenant; vendor terms carrying processor terms are a release gate. |
| SL-06 | major | CODE-ROUTED | Per-person deletion stays ten business days (raw copies from other services included) with 35-day backups, and only a record of the request is kept, no longer than needed; the erase path (leaving no telephone number in `suppressions`), vendor deletion and runbook are a release gate (gate 6). |
| SL-08 | major | TEXT | As ICD-10. |
| SL-09 | minor | TEXT | As HRC-16. |
| SL-10 | minor | TEXT | Backups deleted "within 35 days after" deletion from healdesk's own records. |
| SL-11 | minor | TEXT | "an appropriate and accepted control standard or framework and assessment procedure" (Conn. Gen. Stat. 42-521(b)(5)). |
| SUB-01 | major | PAGE-C19 | As ICD-13; the signing screen must show 1.3.0's notes through `clauseExplainer`. |
| SUB-02 | major | PAGE-C19 | Instagram, Messenger and WhatsApp stay Practice's own services in clause 4; Meta's row on `/subprocessors` becomes a note at release. |
| SUB-03 | major | TEXT | Termination on objection ends the Services; no Fees after, and a refund (owner flag) outside clause 18's exclusion and indemnity. |
| SUB-04 | minor | TEXT | As HRC-11; Terms §9 follows at release. |
| OU-01 | minor | TEXT | Clause 8: the recipient notifies healdesk of any instance in which the confidentiality of the PHI has been breached (164.504(e)(4)(ii)(B)(2)). |
| PT-01 | blocker | TEXT | As HRC-02; destruction must also reach suppressions, consent records and contact attempts, and the clinic's calls at Retell (release gates). |
| PT-02 | major | TEXT | Clause 11 lists what the booking-field catalogue can ask, the call-only optional fields included, and no email. |
| PT-03 | major | TEXT | Clause 10's exception covers answering, passing through to the direct line (also after the Services end, as the Terms provide) and live transfer; "no calls to patients and no SMS"; clause 4 purpose (d). |
| PT-04 | major | TEXT | As ICD-11. |
| PT-05 | major | TEXT | As HRC-16. |
| PT-06 | major | TEXT | "The calendar" is each calendar healdesk uses, one per provider included, and every rule applies to each; C6 and C8 build it. |
| PT-07 | major | TEXT | The not-used clause offers only the route that exists: an election for a system that reads Google Calendar. |
| PT-08 | major | PAGE-C19 | As ICD-13. |
| PT-09 | major | TEXT | As HRC-11. |
| PT-10 | major | TEXT | As HRC-13. |
| PT-11 | major | TEXT | Clause 7: a link only in website chat and on Meta ("may"), none on a call; only an amount, a generic description and a reference; no payer details kept. Package D builds to it (release gate). |
| PT-12 | major | CODE-ROUTED | Clause 16 says each Meta message is checked for clinical content before the model sees it and kept nowhere; the front door must do so before release, and stays off for every clinic until it does, since the public copy already says so (gate 4). |
| PT-13 | major | CODE-ROUTED | The first reply in each Meta conversation must open with `metaChannelGreeting` before release. |
| PT-14 | major | CODE-ROUTED | The console's `notifyDeadline` must give 24 hours for every class and clinic; its test is outside this redraft. The runbook works to 24 hours now. |
| PT-15 | major | TEXT | Clause 20 defines Practice's one notice address; the runbook and template send there, and by phone. |
| PT-16 | major | TEXT | The runbook and template identify each affected patient by secure transfer with every breach report, and give the breach date and the steps patients should take. |
| PT-17 | major | TEXT | Clause 14(b): corrected where the record can change, otherwise appended and linked (164.526(c)(1)); the amendment record is a release gate. |
| PT-18 | major | CODE-ROUTED | As SL-06: raw webhook copies deleted within the ten business days. |
| PT-19 | major | TEXT | As ICD-18. |
| PT-20 | minor | CODE-MINE | Clause 6 names the three further things Google's permissions reach, the subscribed-calendar list included; C8's organisation filter keeps the covered promise. |
| PT-21 | minor | TEXT | As ICD-17. |
| PT-24 | minor | TEXT | Clause 14: a request made to healdesk itself is answered only in healdesk's reply; no later contact. |
| PT-25 | minor | TEXT | As ICD-19, including when the Services end. |
| PT-26 | minor | TEXT | As ICD-16. |
| PT-27 | minor | TEXT | As ICD-20. |
| PT-28 | minor | TEXT | Clause 11 states each record's retention as the purge runs it; the purge on for every 1.3.0 clinic, a contact kept while a recent booking request refers to it, and Retell's retention no longer than the clinic's, are release gates. |
| PT-29 | minor | TEXT | The sentence naming clauses that do not exist is gone. |
| PT-30 | minor | TEXT | Clause 6: the first name the person booking gave, else "Patient"; the service, else "Appointment" (event.ts). |
| PT-31 | minor | TEXT | One combination rule; matching a request to the same clinic's contact is outside it, and per-clinic references link no one across clinics. |

Totals: TEXT 80, OWNER-KEPT 2, CODE-MINE 2, CODE-ROUTED 5, PAGE-C19 5.

#### Release gates

1.3.0 is not released, and `approvedByCounsel` stays false, until each of
these is closed, by code, a page, a signed paper or a host setting, and
§12.4's table reads "Yes" throughout.

**Calendar build (CODE-MINE)**

1. **The covered-calendar guardrail (C8; HRC-04, PT-20; owner decision 4).**
   A covered clinic books only into calendars that its connected Workspace
   account owns inside its own organisation: covered terms refused unless
   the ID token shows a managed account (`hd`); the calendar list asked with
   `showOwnOrganizationOnly` beside `minAccessRole=owner`; every chosen
   calendar, provider calendars included, checked at choice and again in the
   write gate before every insert, failing closed.
2. **Named providers (PT-06).** One calendar per provider and the
   service-to-provider mapping (C6's `clinic_providers`, C8/C9's
   `saveProviders`, C12/C13's per-provider availability, holds and writes),
   with every calendar passing the same terms and ownership checks as the
   shared one.
3. **Token use stops when the Services end (ICD-32)**, and the token is
   deleted on disconnect, on finding access removed at Google, and at
   destruction (C7, C8, C10); withdrawal of the uncovered direction stops
   writes, and not-used terms refuse a connection (C7, C8).

**Other sessions' code (CODE-ROUTED)**

4. **Meta front door (PT-12, PT-13).** `front-door.ts` screens each inbound
   message for clinical and urgent content before `input.responder`, sending
   the fixed hand-off or urgent line without calling the model, and the
   first reply of each conversation opens with `metaChannelGreeting()`
   (Messenger added to `disclosure.ts`'s channels). Until both land,
   `metaFrontDoorEnabled` stays false for every clinic, whatever agreement it
   signed. Terms §9, `/trust` and the `/subprocessors` Meta row
   (`apps/web/src/lib/subprocessors.ts`) already tell every customer that
   clinical content is "caught on arrival" or "caught when it arrives",
   which is true only once the screen runs. Switching the front door on sooner needs that copy corrected
   first (apps/web, with a `LEGAL_VERSION` bump). Done on 7 October 2026.
   `answerFrontDoor` runs the catalog's `findUrgentContent` (the urgent set,
   new: none existed) and then `findClinicalContent` over each message before
   `input.responder`. An urgent message gets `urgentLine` (the AI line, 911,
   then the clinic's direct line, else its published number) and the urgent
   alert's hook; a clinical one gets the fixed hand-off line. Neither calls
   the model, so nothing of the message is extracted, drafted, requested,
   audited or logged. The first reply of each conversation opens with
   `metaChannelGreeting()`, the fixed lines included, and no later one does:
   a conversation is the person's thread until 24 hours pass without a
   message from them, and `chat_threads.greeted_conversation_id`
   (drizzle/0055, `lib/meta/greeting.ts`) records whose first reply carried
   it. The webhook records it only once that reply has gone out, so a reply
   `sendMetaReply` drops outside Meta's window (a backlog Meta delivers a
   day late) leaves the greeting to the first reply the person does get.
   Messenger is in `disclosure.ts`'s channels. The copy above now
   describes the code, as far as the catalog's vocabulary reaches: a
   condition it does not name (acne, rosacea) still goes to the model, where
   the prompt and the reply guard hold it, and nothing of any message is
   stored but cleaned booking fields. Nothing here switches the front door
   on; the ops console's `setMetaFrontDoor` still can, for a production
   clinic with a published number.
5. **Incident deadline (PT-14).** `notifyDeadline` in
   `apps/app/src/lib/incidents/incidents.ts` returns discovery plus 24 hours
   for a breach, a security incident and an improper use or disclosure, for
   every clinic; its test (`tests/incidents-and-offboarding.test.ts`), its
   comments, the schema comment and the ops Incidents page follow. Done on
   7 October 2026: it does, keeping the state-law "immediately" for a breach
   at a clinic that is not a covered entity wherever that is the earlier
   clock (24 hours today); the service complaint's two business days and the
   owner's 30-day clock are unchanged. The tests, the comments, the schema
   comment, the ops care page, `incident-response.md` and the risk analysis
   follow. An incident opened before keeps the deadline it was opened with,
   and the runbook says to work to 24 hours for it too.
6. **Per-person deletion (SL-06, PT-18).** An operator erase path that runs
   `eraseContact` and also deletes the person's `webhook_events`,
   `meta_booking_drafts`, booking requests matched by messaging identifier
   and `chat_threads`, tells the voice vendor and other subcontractors to
   delete, and records it; a "Deletion requests" runbook section; a
   retention rule for `chat_threads`. The erase path leaves no telephone
   number in `suppressions`. It records the request without the number, or
   with a keyed hash used only to re-apply the deletion after a restore. It
   keeps that record no longer than the 35-day backup window
   (`BACKUP_RETENTION_DAYS`) plus any restore in progress, and nothing reads
   it for contact decisions. `eraseContact`'s comment that the number is
   kept "so the request itself is honoured forever" changes with it. That is
   what clause 4(c) promises: "only a record of the request, for no longer
   than it needs one to make sure the information stays deleted".
   Done on 8 October 2026 (`drizzle/0063_erasure_requests.sql`,
   `apps/app/src/lib/patient-rights/erasure.ts`, pinned by
   `tests/person-erasure.test.ts`):
   - The operator erase path is `npm run ops:erase-person`, run in apps/app's
     own shell, which reads the number and the address from a prompt, never
     the command line. Until the second review of 12 October 2026 it was the
     care page's "Delete a person", which sent them through a Vercel server
     action into the signed ops envelope: a hop through a host with no BAA.
     That operation, and `amendRecord` and `amendContact`, are gone from the
     envelope; the care page keeps the records, the subcontractor steps (a
     closed outcome each, never typed) and counts. No log line or audit row
     carries the person's details, and the script prints the request's id,
     its deadline and counts. On the AWS host it runs by contact id, through
     run-task.sh only (HEALDESK_ERASURE_*: no interactive shell exists
     there, and overrides are recorded by CloudTrail); the typed prompt is
     for a development database. Amendment words and corrected details
     cannot run there and wait for the M5 portal; getting a contact's id
     without the person's details crossing a channel is an open item until
     M5 (docs/handover.md, "Reaching the app's shell").
   - One transaction runs `eraseContact` for each number and address, then
     deletes what it does not reach: the person's raw payloads
     (`webhook_events`: every voice payload of their calls, and any payload
     carrying their number or address, matched whole, the number with or
     without its country code; the first version's substring test took
     joann@ for ann@ and missed "555 013 0001"), the drafts and `chat_threads` of
     their own messaging threads, matched by the keyed references the tables
     already hold, and their suppressions, consent records and
     contact attempts (`app_erase_contact_evidence`, since the runtime role
     has no DELETE on the three, and only under the record of the request:
     one written in the same transaction, or one whose restore references
     have not expired, and only what was recorded before it; the first
     version took a bare cutoff that `now()` satisfied, so the runtime role
     could delete any number's "stop" with no request at all, against 0058,
     until the review of 12 October 2026). The second review found that a
     record the runtime role wrote itself, or any record still holding its
     references, still let it delete any number's stop; the function now
     refuses a number any contact of the clinic still carries, so evidence
     goes only after its person's contacts have, and every call that
     deletes anything writes an audit row naming the request, the path and
     the counts. What still bounds the restore path: the 35 days, what was
     recorded before the deletion, numbers no one on file carries, and that
     row. No telephone number of theirs is left, in
     any table (the test reads every table with a `clinic_id`, and the
     security events, for it).
   - A booking request goes only with the person it names
     (`app_erase_contacts`, 0054), and a messaging thread is the person's own
     only when everything it sent named them. The first version deleted
     every request a thread the person had touched ever sent
     (`app_erase_thread_requests`), so erasing a child deleted the requests
     their parent had made for themselves and for a sibling, and the
     parent's thread; the review of 12 October 2026 proved it, and the
     function is gone. A thread that also booked for someone else keeps what
     it sent for others, with its drafts and its `chat_threads` row, and the
     reply counts what was kept (`kept`), never naming anyone. One case
     stays: a request the person sent from their own WhatsApp for someone
     else carries their WhatsApp id, which is their number, as its sender,
     and stays as the other person's record. Known limits, as specified and
     recorded in docs/handover.md ("Deletion requests"): the closure is one
     step (C1 {P, E1}, C2 {P, E2}, C3 {E2}: erasing E1 leaves C3 and E2's
     payloads); a Meta request reuses a contact by number, so a parent
     booking for a child with the parent's own number is one contact; and
     the amendment identifier check misses wide separators, slashes and
     spelled-out numbers, and refuses runs like "1200 1300 1400".
   - `eraseContact` no longer writes `suppressions`, and its comment says
     why. The request is recorded in `erasure_requests` without the number:
     who asked (one of three, chosen, never typed: the first version took
     free text screened only for numbers and addresses, so a name could be
     kept; review of 12 October 2026), when it arrived, the ten-business-day
     deadline (SL-06), when the deletion ran (the database's clock, stamped
     by a trigger), the counts, and the operator's stamp for each
     subcontractor step: Retell's, done in its console, since nothing in
     apps/app reaches it yet. The care page shows each step outstanding,
     with the deadline, until it is stamped; a stamp cannot be undone.
   - The record's only reference to the person is `restore_refs`: keyed
     references (`identifierRef`) to the numbers, addresses and messaging
     threads the deletion found, used by `npm run reapply-erasures` to
     delete the person again from a restored database, taking only what was
     recorded before the deletion ran, and by nothing else. The hourly,
     unswitched `erasure-expiry` sweep empties them 35 days after the
     deletion (`BACKUP_RETENTION_DAYS`), when the row goes too unless a
     subcontractor step is still outstanding (then it stays, holding
     nothing of the person, until the step is stamped). The sweep runs in
     the worker, which a restore keeps stopped, so a restore in progress
     keeps the references it needs. Destruction deletes the records with the
     rest of the clinic (`app_mark_clinic_destroyed` checks them). That clock
     is the database's: the runtime role cannot empty the references, delete
     a record or write a stamp that counts, so the expiry and destruction
     run through definers (`app_expire_erasure_records`, on the 35 days by
     the database's clock; `app_destroy_erasure_requests`, on
     `app_destruction_due`), the guard refuses an early emptying from any
     role, and a step counts as stamped only with a stamp the guard wrote and
     timestamped. The first version held all of that only in TypeScript
     (review of 12 October 2026).
   - Nothing reads the record for a contact decision (a test lists the
     modules that touch the table). Readers of `suppressions` after the
     change: `canContact`, the outbound gate, which in v1 refuses before it
     reads a row (`OUTBOUND_CONTACT_ENABLED` is false) and otherwise reads
     only stops, of which v1 writes none; `exportPatient` and
     `exportClinic`, which carry what is there; `reapplyErasures`, which
     reads the numbers only to find a deleted person again after a restore;
     and destruction. None of them sees an erasure.
   - The purge deletes a `chat_threads` row once its last message is past
     the record clock, clause 11's "until 90 days after the last time those
     details were recorded".
   - docs/handover.md has the "Deletion requests" runbook (who may ask, how
     ops verifies, the operation, the vendor steps, the deadline, the
     reply), and "Restoring" carries the records over and re-applies them.
   - Left: a person who only ever messaged on Messenger or Instagram and
     gave no number is found only by a thread id, which the practice cannot
     see; their thread (a keyed reference and a time) goes with the purge.
     Phase-two payloads (POS read-back) are matched by the number or the
     address written verbatim, and a number formatted another way is not
     found in them.
7. **Offboarding (HRC-02, PT-01).** Code in
   `drizzle/0058_destruction_clock.sql` and
   `apps/app/src/lib/offboarding/offboarding.ts`, pinned by
   `tests/destruction-clock.test.ts`.
   - Done: 1.2.1 and earlier keep their flat thirty days and 1.3.0 and the
     DPA keep the DPA's rule, which clause 17 states, read from the
     agreement the clinic was bound to when its service ended, terminated
     since or not (`app_agreement_at_end`, `DESTRUCTION_RULES`,
     `destructionPlan`; `app_destruction_due()` is the same rule as the
     database's floor). No agreement, or a version the map does not know,
     gets the thirty days. The clock starts at the subscription's own end,
     which the database takes up to a week back.
   - Done: `export_delivered_at` is stamped only by the operator's record of
     the handover, which is refused until a bundle has been produced since
     offboarding started, through `app_mark_export_delivered()`, the
     column's only writer. The portal export, when it is built, stamps it
     once its download has reached Practice.
   - Done: the job runs every hour, and a clinic on the thirty days is due
     at day 29, so its data is gone before thirty days have passed.
   - Done (the calendar session's decision, 7 October 2026): 1.3.0's Term
     clause keeps its words, "thirty days after the Services end if the
     export has been delivered by then; otherwise as soon as the export is
     delivered; and in any case no later than ninety days after the Services
     end", and the code meets them exactly. Every hourly run destroys on
     this rule too, and a 1.3.0 or DPA clinic is due at day 29 once its
     export has been delivered (by day 30), at the delivery when that is
     later, and at day 89 without one, so neither limit is passed whatever
     the hour (`THIRTY_DAY_LIMIT_DUE_DAYS`, `NINETY_DAY_LIMIT_DUE_DAYS`;
     `app_destruction_due()` the same in the database). The 04 UTC run,
     which could come up to a day after day 30, after a delivery and after
     day 90, is gone. 1.3.0 and the DPA keep one rule. The DPA's clause 17
     ("runs once a day ... at the first run once") is left as it is: the
     hourly job destroys no later than it says.
   - Done: `destroyClinicData` also deletes suppressions, consent records and
     contact attempts, through `app_destroy_contact_evidence()` (the runtime
     role keeps no DELETE on them), and `app_mark_clinic_destroyed()` refuses
     while any is left.
   - Done: destruction, `eraseContact` and the purge succeed for a practice
     with a confirmed booking request
     (`drizzle/0054_booking_request_destruction.sql`). The request's
     `appointment_id ON DELETE SET NULL` met its confirmed-shape CHECK; the
     requests now go first, through three functions bound to the practice,
     and `docs/counsel/dpa.md` § 9 records how.
     `tests/booking-request-destruction.test.ts` pins each path.
   - The clinic's calls and agent are deleted at Retell by the deadline. An
     operator step for now: recorded on the care page as a
     `voice_vendor_data_deleted` security event, and shown outstanding, with
     its deadline (the day the data is destroyed here), until it is. Nothing
     in apps/app reaches Retell yet; the deletion moves into code with the
     voice runtime.
   - Done: a restore re-runs destruction. `docs/handover.md` ("Restoring")
     gives the steps: each destruction's `clinic data destroyed` log line
     carries the dates it ran on, which the owner puts back where a restore
     lost them, and `npm run destroy-due -w @healdesk/app`
     (`destroyEverythingDue`) then destroys every clinic due and exits
     non-zero while any still is. `tests/destruction-clock.test.ts` restores
     a destroyed clinic and runs both.
8. **Amendment record (PT-17).** An append-only amendment linked to the
   booking request or conversation it amends, carried by `exportPatient`,
   `exportClinic` and the portal export. The DPA's clause 13 promises the
   same, as a correction, so its release waits on this gate too (`dpa.md`,
   gap 22). Done on 12 October 2026 (`drizzle/0064_record_amendments.sql`,
   `apps/app/src/lib/patient-rights/amendments.ts`, pinned by
   `tests/record-amendments.test.ts`):
   - `record_amendments` holds each amendment: the record it amends (a
     booking request or a conversation, by `target_kind` and exactly one
     foreign key), Practice's words, who asked (one of three, chosen, never
     typed: the second review found a typed "Jane Doe's mother, by telephone"
     in the append-only audit log after Jane's deletion, so amendments and
     corrections now take the same closed set as deletions, held by
     `record_amendments_requested_by_check`), when
     Practice directed it, who appended it, and when, stamped by the
     database. Each foreign key carries `clinic_id` with the record's id, so
     an amendment can only point at a record of its own clinic. Tenant RLS,
     FORCEd, `TENANT_SCOPED_TABLES`, and the BAA gate.
   - Append-only: the runtime role holds INSERT and SELECT only, a trigger
     refuses any UPDATE by any role, and the foreign keys have no delete
     action, so a record cannot be deleted around its amendment.
   - Writers: the operator's scripts in apps/app's own shell,
     `npm run ops:amend-record` and `npm run ops:amend-contact` (which
     corrects a contact in place, the record that can change), reading the
     words and the corrected details from a prompt, never the command line.
     Until the second review of 12 October 2026 they were the care page's
     forms, through a Vercel server action into the signed ops envelope; both
     operations are gone from it. No audit row, log line or reply carries the
     words. The portal (M5) calls `appendAmendment` with its member as the
     recorder.
   - Exports and uses: `exportPatient` and `exportClinic` carry each
     amendment beside the request or conversation it amends (`amendments`,
     oldest first), and the accounting of disclosures shows each being
     written. The desk's view of a booking request (`/booking/<token>`)
     says how many amendments the request carries and to read them in the
     export, and never their words: it opens with the emailed token alone,
     no passkey, and the first version printed the text there (review of 12
     October 2026). The request's name and number on that page are an older
     gap, which M5's passkey closes. The portal's export, and any
     screen of it that shows a request or a conversation, must do the same
     (the note in `amendments.ts`).
   - Removal: an amendment goes with its record and at no other time, inside
     the function that deletes that record: erasure (`app_erase_contacts`,
     redefined on 0054's body, still taking only the people's own requests
     and failing with nothing removed if anything else refers to them), the
     purge (`app_purge_booking_requests`, redefined with 0058's UTC pin, and
     the new `app_purge_amended_conversations`, under the same record-clock
     floor, which deletes an amended conversation and its amendments
     together), and destruction (the new `app_destroy_record_amendments`, on
     `app_destruction_due`); `app_mark_clinic_destroyed` refuses while one
     remains. The first version purged a conversation's amendments on their
     own, floored on `started_at`, which the runtime role could write: it
     could backdate a live conversation, purge its amendment and put the
     date back (review of 12 October 2026). The runtime role can no longer
     write `started_at` (nothing in the application did), and an amendment
     never goes while what it amends stays. A booking request's floor
     column, `created_at`, was already out of its reach.
   - docs/handover.md has the "Amendments" runbook, and
     `docs/incident-response.md` points to it.
   - Appointments, and clearing a field (review of 12 October 2026). Only a
     contact could be corrected, and the amendment record took only booking
     requests and conversations, so an appointment's service, practitioner
     or time could be neither corrected nor amended. An appointment is now a
     target too (`record_amendments.appointment_id`, by the same
     clinic-carrying key), carried by both exports, and it leaves with the
     same paths as the others: erasure (`app_erase_contacts`), the purge
     (the new `app_purge_amended_appointments`, which takes the appointment
     and its amendments together, since its time is one the runtime role and
     a sync can move), and destruction. It is appended rather than written
     over, because the appointment is the booking as the practice's calendar
     holds it. `amendContact` can now clear a name, number or address, but
     only one named in `clear`; an empty value is still dropped.
   - An amendment's words never carry a telephone number or an email
     address, refused by the writer and by a CHECK
     (`record_amendments_identifier_check`): an amendment on someone else's
     record is never searched by a deletion, so one written there would
     outlive the "no number left" promise (review of 12 October 2026).
   - Left: nothing in v1 shows a conversation's record to anyone but the
     operator's export yet; the portal's transcript view (M5) must show the
     conversation's amendments beside it.
9. **Retention (PT-28).** The nightly purge switched on for every 1.3.0
   clinic (0032 ships it off), and extended to webhook events that are never
   processed. Done in drizzle/0054 and `lib/retention/purge.ts`: the purge
   takes abandoned Meta booking drafts, and a contact is kept while a
   booking request made in the last 90 days refers to it, because purge
   step 3 checks `booking_requests` and a person cannot be deleted while a
   request names them (`booking_requests.contact_id` is ON DELETE NO
   ACTION), so a returning person's Meta request, which writes no
   conversation, no longer goes by cascade when their older call ages out. A request is
   kept for its own period, which clause 11 now states (§ 12.12). The rest
   done on 12 October 2026 (`lib/retention/purge.ts`,
   `lib/scheduler/retention-purge.ts`, pinned by `tests/retention.test.ts`):
   - The purge runs for every clinic bound to BAA 1.3.0 or later, or to the
     DPA, every night, whether the job's switch is on or not
     (`purgeIsPromised`, read from the agreement in effect: a version
     promises the purge only if its own retention clause states the
     purge's periods, which 1.3.0's and the DPA's do and 1.2.2's and
     earlier do not. Until the third review of 12 October 2026 every
     version off a list of earlier ones counted as promising, and 1.2.2,
     released after the list, nearly did; `runWideningJob`, which keeps
     runJob's lock and records each run). The switch, which 0032 ships off,
     adds every other clinic. The owner switches it on at the release
     (docs/handover.md, "Retention and offboarding"), so 1.2.2 and 1.2.1 clinics are
     purged too. A sync run holds a clinic's purge only while it is younger
     than six hours; one that crashed held it for good, since `sync_runs`
     is append-only.
   - A vendor payload never processed goes at the record clock, the period
     clause 11 gives the conversation it would have become; one processed
     goes at thirty days or the record clock if the practice has shortened
     it below that, so no raw copy outlives its record. `purge.ts` lists
     every period as clause 11 states it.
10. **Payment links (PT-11, ICD-10, SL-08; package D).** Links only in website
    chat and on Meta, carrying only an amount, a generic description and a
    reference, metadata and statement descriptor included, and no payer
    details kept from the processor's notices.
11. **The signing screen and the release mechanics.**
    - The clause notes come through `clauseExplainer(template.version, id)`
      (SUB-01, §12.11 item 12). apps/web's `agreement-kinds.ts` does this
      since the four-step funnel (8d7fcd4).
    - The "Why you're signing this" bullets come through
      `baaExplainerTerms(template.version)`. Done: the catalog's
      `AGREEMENT_COPY[kind].explainer(version)` (`baaExplainerFor`) gives each
      version its own bullets, and apps/web's `agreement-kinds.ts` builds each
      entry from the template it renders (`baaAgreementCopy`), so the version
      shown, its bullets, its text and the version signed are one version.
      1.2.1 still shows `BAA_EXPLAINER` word for word; a 1.3.0 buyer reads
      "limit its use and disclosure" and "if you determine that we have
      violated a material term of it" (`AgreementStep.version.test.ts`).
    - Plan C15 lands: provisioning's approval gate reads the bound
      acceptance's version (§12.11 item 13). Plan C3 has landed (ad02b30):
      both signing paths settle the version through `signableTemplate`.

**Public pages at release (PAGE-C19)**, with a `LEGAL_VERSION` bump:

12. `/privacy` publishes the de-identification commitment clause 8 points to
    (SL-04), and §11 says "the calendar, or one per provider".
13. `/subprocessors` and `/trust`: 24 hours' notice under 1.3.0 or later and
    15 days under earlier versions, sent to the notice address, naming the
    vendor, what it receives and why, with objection before the change takes
    effect (ICD-13, SUB-01, PT-08); Meta's row becomes a note beside Google
    Calendar and the payment processor, with the "three kinds of row" text,
    `subprocessors.ts`'s header and `/trust`'s scoped-subprocessor sentence
    (SUB-02).
14. Terms §9 states Anthropic's agreement in covenant form (HRC-11, SUB-04);
    Terms §4, §7 and §15 say that terminating the BAA ends the subscription
    the same day, with the refund clause 17 gives (HRC-07, SUB-03); §9 and
    §14 may say "consistently with" for "in the same way" (ICD-16).

Gates 12 and 14 are written in LEGAL_VERSION 2026-10-12.2, which replaces
2026-10-12.1 (main's consent wording, 8eb9b24); gate 13 is retired. The
owner decided on 12 October 2026 for the direction of 9 October (cc7d209 and
2acc070, on main through PR #6, f002e3f): breaches and incidents are reported "without unreasonable delay
and in no case later than 60 calendar days after discovery", and the 24
hours apps/app's incident deadline keeps is an internal operating target
that no public page promises; `/subprocessors` is retired, the list given to
a signed clinic on written request (clause 13 says so since § 13); `/trust`
is the Terms' annex, "How we protect data".

- 12: `/privacy` § 14 makes clause 8's commitment in clause 8's terms, for a
  clinic whose agreement allows de-identification (1.2.1 and 1.2.2 also do,
  more loosely; the DPA allows none), and § 11 follows clause 6: the
  calendar or one per provider, the main calendar until one is chosen, the
  calendar names read, the three things not read, and when the token is
  deleted. § 9 keeps 2acc070's breach wording and says, as clause 13 does,
  that a vendor signs before patient information reaches it.
- 13: retired by owner decision, list on request; done on main by the
  9 October branch, not here.
- 14: Terms § 9 states the language-model provider's agreement as clause 13
  states Anthropic's, without naming a vendor, and says no real patient
  information is processed until every agreement in the chain is in place;
  §§ 9 and 14 say "consistently with". Terms § 1 defines the "Data
  Agreement" (the BAA, or the DPA in its place), and §§ 4, 7 and 15 give the
  owner's refund rule of 12 October 2026, which clause 17's third paragraph
  states for the BAA: every ending stops the subscription and fees that day;
  a refund only where Practice terminates for healdesk's violation of a
  material term or under the Subcontractors clause, of the prorated unused
  paid period (the rest of the year on an annual plan), never the setup fee
  or overage already billed, and nothing before the plan starts; otherwise
  none. §§ 13 and 14 keep it outside the exclusion and the indemnity, as
  clause 18 does. Terms § 4's cancellation is the portal's Auto-renew switch,
  since Stripe's portal has cancellation off. The code that ends the
  subscription and refunds on termination (blocker 1 of the C19 audit, refund
  kind `agreement_terminated`) is another branch's.
- Meta, on the same version: `/privacy` §§ 5 and 12, Terms § 9 and the
  Terms' annex say no more than clauses 11 and 16 as the owner softened them
  on 12 October 2026 (no message or summary kept; the assistant instructed;
  replies checked by filters designed to keep clinical content out, a refused
  reply replaced by a fixed one; no filter catches every wording). "Caught on
  arrival", "not stored", "replies never name a treatment" and the 90-day
  Meta conversation are gone. `/privacy` § 12 also names Meta's identifier
  for the conversation, which the code keeps (`booking_requests.sender_id`)
  and clause 4 lists, though clause 11's "keeps only the details in (a)" does
  not. The same pages say the Meta assistant takes booking requests, books
  nothing and sends no payment link there, as the code does today
  (`lib/meta/front-door.ts`; nothing calls `depositLinkMessage`), although
  clauses 4 and 7 permit a link on Meta.

**Paper and settings**

15. Retell's US region and encryption at rest confirmed in writing, and its
    register row filled, before any PHI reaches it (HRC-13, PT-10; R6).
16. The executed AWS, Anthropic, Retell and database-provider terms each
    carry service-provider or processor terms for patient information that
    is not PHI (Cal. Civ. Code 1798.140(ag), Conn. Gen. Stat.
    42-521(b)(4)), or the exception is named (SL-05).
17. Anthropic's business associate agreement signed before any patient's
    information reaches it, as clause 13 promises.
18. Host backups at 35 days at most, with no manual snapshot holding PHI
    kept longer (`BACKUP_RETENTION_DAYS`); Retell's per-agent transcript
    retention no longer than the clinic's period.

**The funnel's DPA** (`packages/catalog/src/dpa.ts`, on main since the funnel
merged) shares `stateLawClauseBody`, the Payments clause, the calendar clause
bodies, the location paragraph and the subcontractor notice. This commit
switches it, as the shared-module agreement of 6 October provides:

- Its state-law clause is now `stateLawClauseBody({ subject: "Client
  Information", sync })`, so `DPA_STATE_LAW_EDITS` and
  `DPA_STATE_LAW_CLAUSE_BODY` are gone.
- `CALENDAR_PERSON_NOUNS` follows the calendar clauses' new wording: "about
  the client", and "who may not be the client the appointment is for".
- The quoted fallback word stays "Patient", exactly as `event.ts` writes it
  for every practice, and is exempt from the no-"patient" check
  (`CALENDAR_EVENT_FALLBACK_QUOTED`). A DPA that printed "Client" there would
  misdescribe the event healdesk writes.
- `dpa-review.ts` follows the renamed calendar heading and prints the live
  variant of the state-law clause in its appendix.
- The DPA's eight golden hashes and `docs/dpa-v1.0.0.txt` are regenerated.

What remained the funnel's to do, before the DPA is released, and what was
done on 7 October 2026 (`docs/counsel/dpa.md` § 5, items 10 to 15; the DPA's
golden hashes and `docs/dpa-v1.0.0.txt` regenerated, no BAA hash moved):

- Done: "calendar election" defined in the DPA's own Definitions clause, in
  BAA 1.3.0's clause 1 words, an accepted one part of the agreement and of
  its entire-agreement sentence.
- Done, in part: an election form that names the Data Protection
  Agreement, `calendar-election-dpa/1.0.0`
  (`packages/catalog/src/dpa-calendar-election.ts`), unreleased and frozen,
  with `calendarElectionFor` to pick a form by the agreement's kind. The
  calendar session's election rows (plan C6, C7) are not on main, so
  nothing can record an election of either kind, and the DPA still refuses
  a second location or a change of booking system; that refusal stays
  until the form is released and the rows take it (`dpa.md`, gap 6).
- Done: "without penalty" has 1.3.0's effect (the Services end that day, no
  Fees after, a refund outside the liability exclusion and the indemnity,
  and the agreement prevails over the Terms on termination and the Fees),
  and the incident and breach notice is the 24-hour rule.
- Done: the instructions, requests and assistance clauses reconciled with the
  shared clause, one statement of each duty, the more protective kept; and
  a request made to healdesk is answered only in its reply (PT-24).
- Done, from review: the requests clause no longer promises, read alone, to
  correct a booking request in place, which 0039's trigger refuses. It takes
  1.3.0's clause 14(b) fix (PT-17) in its own words: corrected where the
  record can change, otherwise appended and linked. That rests on gate 8,
  so gate 8 holds the DPA's release too (`dpa.md`, gap 22).
- Done: `docs/counsel/dpa.md` brought up to date.
- Done on 12 October 2026, with gates 6 and 7: the "Clients' requests"
  clause no longer says a deleted client's telephone number is kept as the
  record of the request. It says the record holds no telephone number,
  email address or name, and, for the 35 days a backup could bring the
  information back, one-way keyed references used only to delete it again
  after a restore. The Term clause says that after destruction healdesk
  holds no Client Information, with no exception for that number.
  `docs/dpa-v1.0.0.txt` and the DPA's golden hashes were regenerated; no
  BAA hash moved (`dpa.md`, gap 15).

#### Flagged for the owner

- **Refund on termination** (HRC-07, SUB-03): where Practice terminates for
  healdesk's violation or on a subcontractor objection, no Fees accrue after
  that day and Fees paid for later time are refunded. A commercial term the
  owner has not seen; Claude took it so that a covered practice never keeps
  paying for a service it can no longer lawfully use. Since the verification
  of 7 October, clause 18's exclusion does not limit it and Practice's
  indemnity does not reach a claim for it, as Terms §13 treats its own
  refund; without that, the refund could be read as excluded.
- **A change-in-law termination** (ICD-30) ends the Services with no refund
  term. Recommended: the same refund.
- **The liability carve-out** (ICD-16) now reaches the exclusion as well as
  the cap, as Terms §13's does: a small change in Practice's favour.
- **De-identified statistics** (ICD-05, SL-03) may be used only to measure
  and improve the Services, not for marketing.
- **R3**, service of process on a UAE entity, is still open.

#### 1.2.1 keeps the defects it shares

1.2.1 is released, and released documents never change: a practice that
signed it signed those bytes. It keeps every defect it shares with the
audited text until that practice accepts 1.3.0, and whether the release
raises `MIN_ACCEPTABLE_BAA_VERSION` to require that is part of the release.
Where 1.2.1 promises less than the product does, operating to 1.3.0's
standard meets both (the runbook now notifies every clinic within 24 hours).
The shared defects:

- clause 15 (Term): destruction promised at 30 days and an export only on
  request, backups unmentioned (HRC-02, PT-01, ICD-32); infeasibility limits
  further use only, not disclosure (HRC-03); termination for "materially
  breaches", not for a violation Practice determines, and no statement that
  ending the agreement ends the Services (HRC-07, SUB-03); the six-year record
  of disclosures put on healdesk as a regulatory duty (HRC-14);
- clause 10 (Reporting): no steps individuals should take, no 164.412 delay
  (HRC-05, HRC-06); five days where California requires notice immediately
  following discovery (HRC-12);
- clause 11 (Subcontractors): Anthropic's agreement in the present tense
  (HRC-11, ICD-12, PT-09, SUB-04); the objection right ends the agreement
  only (SUB-03);
- clause 8 (Safeguards): "held on United States infrastructure", a flat
  statement about every vendor (HRC-13, PT-10); the telephone exception
  covers answering only, not pass-through or transfer (PT-03);
- clause 9 (Minimum necessary): "and no more", "a telephone number or email
  address", and retention stated for transcripts only (HRC-15, ICD-29,
  PT-02, PT-28); the opening-line promise on Meta (PT-13);
- clause 14 (Prohibited): the Meta replies inside the advertising ban, and
  "handles no clinical content" (HRC-10, ICD-14, PT-12);
- clause 3 (Permitted uses): no own-use exception (ICD-01, HRC-08);
- clause 4 (Data sources): "the only patient information … is what patients
  themselves give it" (PT-04, ICD-11), and "practice-management or
  point-of-sale" naming booking systems (ICD-27);
- clause 5 (Google Calendar): one calendar where the spec books by provider,
  and the calendar-list read unstated (PT-06, PT-20);
- clause 12 (Patient rights): amendments always corrected in place (PT-17),
  and the patient told after the conversation (PT-24);
- clause 6 (Own use): "notify healdesk of any breach of its confidentiality"
  (OU-01);
- the preamble and clause 18 (Notices): the Delaware mailbox as the party's
  address (ICD-18, PT-19), the specialty lower-cased (ICD-20, PT-27),
  "Services" and "Fees" left to the Terms, which define neither (ICD-19,
  PT-25), notices to the signatory's email only, and no exclusive venue
  (ICD-31, PT-15), the change-in-law termination pointing at the Term clause
  (ICD-30);
- clause 16 (Liability): "as section 14 of the Terms provides" with a
  different list (ICD-16, PT-26);
- clause 2 (Practice's status): the capital NOT (ICD-21); throughout:
  clauses named without a rule for resolving names (ICD-22), "patient
  information" and "PHI" undefined or in three forms (ICD-23), the legal
  name for "Practice" (ICD-24);
- the phase-two `data-sources-verified` clause still renders if signing ever
  allows verified reporting (HRC-17, ICD-35), fenced only by
  `HEALDESK_PHASE_TWO_ATTRIBUTION`.

#### Golden hashes

The ten 1.3.0 hashes, the election's and the disclosure's were regenerated
by this redraft, and the ten 1.3.0 hashes again by its verification of 7
October (clauses 1, 6's location paragraph, 12, 17 and 18); §12.12 lists
them. The election and the disclosure did not move in that round. The DPA's
golden hashes (`packages/catalog/src/dpa.test.ts`) and `docs/dpa-v1.0.0.txt`
moved with the shared clauses.

### 12.15 Release, 12 October 2026, and the audit before it

> **Not legal advice.** The owner released BAA 1.3.0 and
> `calendar-election/1.0.0` on 12 October 2026, on the owner's own review and
> **without external counsel** (owner answer Q2; plan C19), after Claude's own
> audit of the full text against the code on main. Counsel's approval, as the
> owner reported it on 6 October (§ 12.14), covered the calendar version of
> the BAA and the 24 hours' notice, and predates the merged and redrafted
> text: what is released is the owner's decision on this audit, not a
> lawyer's. The owner decided the same day that 1.3.0 replaces 1.2.2
> outright ("1.2.2 does not need to stay signable. Just replace it."): no
> overlap, and the go-live floor rises to 1.3.0. The DPA and its election
> stay unreleased.

#### The audit (12 October 2026)

- **Method.** Twelve 1.3.0 variants and three elections rendered through
  `prepareBaa` and `renderCalendarElection`, every golden variant reproducing
  its hash and the review copy matching the render byte for byte. Every
  sentence that says what healdesk's systems do or never do was checked
  against the code on main, by Claude for the calendar clauses, the election,
  the disclosure and the explainer, and by three read-only investigators for
  Meta and web chat; retention, deletion, export and destruction; and
  payments, voice, safeguards and the public pages. Every finding ranked was
  re-verified in the code. It was read again against main after the funnel's
  gates 6, 8 and 9 landed (c57360f), and the two text fixes below are the
  ones whose code reality that settled.
- **Verdicts.** HOLDS (the code makes it true); GAP (false on main: the code
  or the text must change); PENDING (true once named work lands); OWNER (an
  owner or counsel action); TEXT-ONLY (no system claim).
- **Regulatory skeleton.** Every element of 45 CFR 164.504(e) and
  164.314(a) is present, as § 12.10 found; nothing the audit changed touches
  one.

#### What it changed in the text

Two sentences, each a GAP whose fix was the text and whose code is on main
(HRC-02: the text says what the product does). Both are 1.3.0's own objects,
so no released hash moved.

| Clause | Before | After | Why |
| --- | --- | --- | --- |
| 11, Minimum necessary | "Practice may shorten these periods in its portal." | "Practice may shorten the period for transcripts in its portal." | The portal's Settings shortens transcripts (90, 30 or 7 days, `clinic_settings.transcript_retention_days`), with the raw webhook payloads and idle chat threads that carry the same words, and no other period: the purge reads it for those and nothing else (`apps/app/src/lib/retention/purge.ts`). "These periods" promised a control over appointments, booking requests and contact details that no screen offers. The DPA's clause 10 has said this since 12 October |
| 14(b), Amendment | "Where the record can be changed, healdesk corrects its own copy. Where a record must stay as it was made, such as a booking request or the record of a conversation, healdesk appends the amendment to it and links the two, as 45 CFR 164.526(c)(1) provides." | "healdesk corrects a person's contact details in its own copy. It does not rewrite a booking request, an appointment record or the record of a conversation: it appends the amendment to that record and links the two, as 45 CFR 164.526(c)(1) provides." | Gate 8 (`record_amendments`, drizzle/0064) appends to booking requests, conversations and appointments alike, and `amendContact` corrects a contact's name, number or address in place. The old sentence left an appointment under "where the record can be changed", as if healdesk rewrote it; it never does, because the appointment is the booking as the clinic's calendar holds it, which a sync or a reschedule moves |

The sentence after them was left as it was by this audit: "Every later use
and export of that record then carries the amendment." The second read
narrowed it (below). The DPA's Clients' requests clause
carries 14(b) in its own words ("a client's contact details", "the
correction", no CFR citation), and `packages/catalog/src/dpa.test.ts` holds
the two together, so it took the same change; the DPA's eight golden hashes
and `docs/dpa-v1.0.0.txt` were regenerated (the DPA 1.0.0 sample was then
`6811e994dd460c3bd6d026e95865fd8cac80adb2e334cc54aa6e11dc9d2093e5`).

Not reopened, because the owner decided them (9 and 12 October 2026,
§ 13): reporting "without unreasonable delay and in no case later than 60
calendar days"; the list of subcontractors on written request; hello@ as
healdesk's notice address. The 24 hours' notice of a new subcontractor
stands (§ 12.7).

#### The second read and the owner's wording (12 October 2026)

Before anything was pushed, the audit's rows were read again on the tree
being released (this release with main and the legal pages merged), in
five slices: termination; erasure and amendments; retention and
destruction; Meta; calendar and payments. The Meta slice found four
outcomes that clauses 11 and 16 promised and the code did not guarantee,
each shown by a probe through the Meta front door and its reply guard:

| Finding | What the probe showed | Sentence it broke |
| --- | --- | --- |
| B1 | The first-name field kept any short run of letters, so "Maria with diabetes" was stored on the booking request, and "Botox" given as a name came back as "Thanks, Botox!" | 11, "Clinical content sent on Instagram, Messenger or WhatsApp is not kept at all"; 16, "repeats none" |
| B2 | Treatment words outside the catalogue's vocabulary (microblading, sclerotherapy, Profhilo, HRT and others) passed the reply guard | 16, "The assistant names no treatment" |
| B3 | A day or a time beside an hours word passed ("Your visit can be Tuesday from 9am.") | 16, "confirms no appointment details" |
| B4 | A reply saying the person's own clinical word back passed whenever the word was on no list ("Please call the practice about your chemo.") | 16, "repeats none" |

The funnel hardened each (`007b58a`, `aa2edd6`, `743aa11` and `2cdc489`,
on main at `fd91a9f`): a first name is one or two name-like words that hit
no health or treatment word, said back only through the reply guard;
the missing treatment words are in the vocabulary; a day or a time passes
only in a sentence whose subject is the clinic's own hours; and a reply
that repeats a content word of the person's message is refused. Each is a
word list, a grammar or a rule over words, and none catches every wording.
The owner chose to have the text describe the safeguards rather than
promise outcomes.

The same reading of gate 8 (`record_amendments`, drizzle/0064) found
"every later use" wider than anything puts an amendment beside a record.
The amendment is carried by both exports (`exportPatient`,
`exportClinic`), and on healdesk's screens: the desk's booking link says
how many there are (counsel's question below), and the portal (M5) must
show them wherever it shows the record
(`apps/app/src/lib/patient-rights/amendments.ts`). A use that shows the
record to no one carries nothing, and the event in
Practice's calendar is never rewritten (an appointment's amendment sits
beside it). So 14(b)'s last sentence was narrowed to the exports and the
screens.

| Clause | Before | After |
| --- | --- | --- |
| BAA 11, Minimum necessary | "Clinical content sent on Instagram, Messenger or WhatsApp is not kept at all." | "healdesk does not keep the messages a person sends on Instagram, Messenger or WhatsApp. From those channels it keeps only the details in (a) (a first name and a telephone number, each checked by automated filters designed to keep clinical content out, and preferred times only in a fixed day-and-time form) and the identifier Meta attaches to the conversation." |
| BAA 16, Not authorised (the Meta paragraph) | "healdesk checks each message a person sends there for clinical content before the language model sees it, and keeps none, repeats none and carries none into a summary. The assistant names no treatment and confirms no appointment details there, and moves anything clinical to a call or to Practice's own secure route." | "healdesk checks each message a person sends there for clinical content before the language model sees it, and keeps no message there and no summary of one. The assistant is instructed not to repeat clinical content, name a treatment or confirm appointment details there, and to move anything clinical to a call or to Practice's own secure route. Each reply the language model writes there is checked by automated filters designed to keep those out, and a reply the filters refuse is replaced by a fixed one. No filter catches every wording, so Practice should not invite patients to send clinical information on these channels." |
| BAA 14(b), Amendment | "Every later use and export of that record then carries the amendment." | "Every later export of that record, and every screen of healdesk's that shows it, then carries the amendment." |
| DPA 13, Clients' requests | "Every later use and export of that record then carries the correction." | "Every later export of that record, and every screen of healdesk's that shows it, then carries the correction." |
| DPA 15, Not authorised (the Meta bullet) | "... the assistant replies there only inside a conversation the client started, handles no clinical content, confirms no appointment details, and moves anything clinical to a call or to Practice's own secure route." | "... the assistant replies there only inside a conversation the client started. It is instructed not to handle clinical content or confirm appointment details there and to move anything clinical to a call or to Practice's own secure route, and each reply the language model writes there is checked by automated filters designed to keep both out." |

Clause 11 also names what the old sentence left unsaid: from a Meta
conversation healdesk keeps item (a)'s details and the identifier Meta
attaches to the conversation, which a booking request and a Meta booking
draft hold (`sender_id`). Every sentence changed is 1.3.0's own object or
the DPA's, so no released hash of 1.2.2 or older moved; the ten 1.3.0
hashes, the DPA's eight, `docs/baa-v1.3.0.txt` and `docs/dpa-v1.0.0.txt`
were regenerated (§ 12.12). The release gates table below records
clause 11's old sentence ("Clinical content sent on Meta is not kept") as
it stood at c57360f. The public pages that describe the Meta channels are
the funnel's to align (gates 12 to 14).

#### What shipped

| Change | Where |
| --- | --- |
| 1.3.0 is `BAA_TEMPLATES[0]`, `publishedOn` 2026-10-12, `approvedByCounsel: true`, which records the owner's release (the flag's doc comment); checkout offers it and signing takes it | `packages/catalog/src/baa.ts` |
| 1.2.2 is `BAA_TEMPLATES[1]`, frozen, and no longer signable: `BAA_RELEASE_OVERLAP` is empty, so a checkout or a browser still holding the 1.2.2 signing screen is refused and asked to reload and review the current version | `packages/catalog/src/baa.ts`; `signableTemplate` in `apps/app/src/lib/agreements.ts` |
| The go-live floor rises to 1.3.0 (below): provisioning, the checkout's agreement check and go-live refuse a 1.2.2 signature | `MIN_ACCEPTABLE_BAA_VERSION` |
| `calendar-election/1.0.0` released: `approvedByCounsel: true`, `publishedOn` 2026-10-12; an election under it now counts for every clinic, not only a demo clinic | `packages/catalog/src/calendar-terms.ts` |
| `app_baa_version_acceptable()` accepts 1.3.0 and nothing else; `app_calendar_election_released()` lists `calendar-election/1.0.0` and nothing else (not the DPA's election); a DO block asserts both lists and that `app_destruction_rule()` gives 1.3.0 the export rule and 1.2.2 the thirty days | The `baa_release_1_3_0` migration in `apps/app/drizzle/` (numbered at integration, after main's `0065_destroy_deposit_payments`); parity tests in `apps/app/tests/database-audit.test.ts` |
| The released review copy, with the variant clauses, the election and the disclosure in appendices | `docs/baa-v1.3.0.txt` (renamed from `docs/baa-v1.3.0-draft-calendar-clauses.txt`) |

**The floor.** Raised to 1.3.0, as 1.2.2's release raised it past 1.2.1
(§ 13): 1.3.0 is the first version with the Payments clause and the clause
for a practice that is not a covered entity, and 1.2.2's one Google Calendar
clause is untrue for a practice whose booking system does not read Google
Calendar. The release as prepared kept it at 1.2.2, because raising it would
refuse go-live to every clinic that signed 1.2.2 and nothing lets one move to
1.3.0: `supersedeAgreement` (`apps/app/src/lib/agreements/kind.ts`) has no
caller, and a superseded first location would get no `agreement` election
row, which only provisioning records (`recordAgreementTerms`) and the
database allows only at sequence 1 (`calendar_elections_agreement_shape`,
drizzle/0057). That reasoning protected clinics holding 1.2.2, and there are
none: `apps/app` is deployed for no real clinic and no clinic has signed
1.2.2. So it no longer applies, and the owner's decision of 12 October
replaces 1.2.2 outright. Every clinic is now provisioned under 1.3.0 and
takes its first location's calendar terms from the agreement itself; a
location without them (a later location, or a superseded agreement) records
a calendar election, which this release makes possible for every clinic.

#### The release gates on the day

As main stood when this release was prepared (c57360f), against § 12.14's
gates and the audit's findings. Each open row is owned.

| Gate or finding | State | Owner |
| --- | --- | --- |
| Terminating the agreement ends the Services the same day, with clause 17's refund (clauses 1, 17, 20) | **Open.** `opMarkAgreementTerminated` records the termination and sweeps calendar access; it does not cancel the subscription, start offboarding or stop answering, and no refund kind exists for it. Interim only if the owner accepts it in writing: cancel in Stripe and start offboarding the same day | funnel (release/130-blockers); healdesk-io-58 for the refund kind |
| Gate 6, per-person deletion | Closed: `ops:erase-person`, the identifier closure, keyed restore references for 35 days, `reapplyErasures` (drizzle/0063) | — |
| Gate 8, the amendment record | Closed (drizzle/0064). Counsel's question: the emailed booking link shows only a count of amendments (it opens without a passkey), the portal (M5) the text behind step-up; whether a count "carries" the amendment on that one surface | counsel |
| Gate 9, the purge's periods | Closed for every 1.3.0 and DPA clinic, which is purged nightly whatever the job's switch (`purgeIsPromised`); unprocessed payloads on the record clock; a failed purge alerts ops and reruns at 09 UTC | — |
| Gate 21, `offboarding-destroy` switched on before the first clinic offboards; the retention switch for clinics on 1.2.2 and earlier | **Owner switches**, both seeded off | owner |
| Clinical content sent on Meta is not kept (clause 11) | **Open.** A free-text preferred window is screened by word lists (`findClinicalContent`, `WINDOW_REFUSED`), not the closed time grammar the audit asked for | funnel |
| Gate 12, /privacy's de-identification commitment and "one per provider"; gate 14, Terms §§ 4, 7, 9 and 15 | **Open** until the funnel's legal-pages bump lands with this release. Gate 13 is settled by the owner's decisions of 9 and 12 October: /subprocessors is gone and /trust is the Terms annex | funnel |
| Gate 20, no doubled greeting on Meta; the Meta follow-ups' switches | **Open.** The front-door prompt still opens "1. Greet the person warmly and briefly."; the desk's follow-up and the reschedule line still pass `enabled: true` | funnel (and the paid `qa:meta` run) |
| The Settings card's Google Calendar disclosure | **Open defect.** `apps/app/src/lib/portal/settings-calendar.ts` passes `GOOGLE_CALENDAR_DISCLOSURE` unrendered, so the card shows "{clinicName}"; the wizard and the link page render it | calendar session |
| Export at offboarding on AWS (clause 17) | Built on main (a6fc8b6), not applied; the bundle carries the deposits since a7da3a9; the day-21 alert for a 1.3.0 clinic and the bundle's chat threads and webhook payloads are open | healdesk-io-58; funnel |
| `deposit_payments` survive destruction (clause 17's two records) | Open at c57360f; closed on main while this release was prepared (a7da3a9, drizzle `0065_destroy_deposit_payments`: destruction deletes them and the clinic's Connect ledger rows) | — |
| Gates 15–18 and 22: Retell's region in writing, vendor processor terms, Anthropic's BAA signed before any PHI (and its retention sentences checked against what is signed), 35-day backups and encrypted ALB-to-task traffic applied; the Security Official named | **Owner and infra** | owner; healdesk-io-58 |

The audit ranked the termination, Meta clinical-content, public-pages and
Meta-greeting rows and the Settings card as blockers of this release (owner
answer Q2: release only if the audit finds no blocker), and the job
switches, the export, `deposit_payments` and the owner-and-infra rows as
gates before the first live clinic or the first offboarding under 1.3.0. When the release
was prepared those blockers were still open on main, so 1.3.0 is released on
the owner's decision to release with them open, not on the audit's
clearance. No clinic is live and apps/app holds synthetic and seed data
only (CLAUDE.md), so no patient's information is yet handled under any
version; every open row must close before the first live clinic.

#### For the owner and counsel

- **California, for a practice outside HIPAA.** § 13.5 left open whether
  1.3.0 adds "or sooner where a law that applies requires it" to the
  reporting clause. The release keeps the owner's 60-day wording: Cal. Civ.
  Code 1798.82(b) binds healdesk directly, and the internal 24 hours meets it.
  Open for counsel.
- **The count on the booking link** (gate 8, above). Open for counsel.
- **The open rows above,** each before its trigger.

#### Golden hashes

The ten 1.3.0 hashes moved with the two text fixes, and again with the
owner's wording after the second read, and are frozen from the release
(§ 12.12): 1.3.0 / covered_estimated is
`d9117482bba644006763a9d613d94ec0a38a3f8888a95b61ad6fbb6f3a68acb3`. The DPA's
eight moved with them (the DPA 1.0.0 sample is now
`7b4a1a973f99462ac956feb704c9e5747917a101cd6b566e5ff4e98ab335bc49`). The election's
(`63586893a436803155ee71811ea17a8d71800a0d90ce41e1b3d9c596650a02aa`) and the
disclosure's did not move. No hash of 1.2.2 or of any older version moved:
1.2.2 / covered_estimated is still
`e6cfb7356be47a223bf8802f8d762f78844e0106af29fe772ca03eab85621893`.

---

## 13. BAA 1.2.2: the list on request, one email address, the spec's breach wording

### 13.1 What the owner decided (9 October 2026)

Final, and in code the same day:

1. **No public subprocessor page.** `/subprocessors` is deleted. A signed
   clinic gets the current list of subcontractors on its written request,
   never at a URL.
2. **hello@healdesk.io is the only email address,** for notices as for
   everything else. There is no legal@ or privacy@ mailbox, and no
   client-facing copy names any other address.
3. **Breach notification follows the product spec** (`docs/v1-product-spec.md`,
   "Breach notification runs to the clinic without unreasonable delay and
   inside 60 days", and "The agreement commits Healdesk to notifying the
   clinic without unreasonable delay and inside 60 days"): "without
   unreasonable delay and in no case later than 60 calendar days after
   discovery". A security incident and an improper use or disclosure get the
   same wording, so a breach never has a looser deadline than a lesser
   incident. The 24-hour target in the incident console
   (`apps/app/src/lib/incidents/incidents.ts`) and in
   `docs/incident-response.md` stays, as an internal practice that no
   agreement publishes.
4. **No clinic has signed any BAA yet,** so 1.2.1 can be replaced with no
   re-acceptance and no overlap window.

### 13.2 What shipped

| Change | Where |
| --- | --- |
| BAA 1.2.2 released: `BAA_TEMPLATES[0]`, `publishedOn` 2026-10-09, `approvedByCounsel: true`, which records the owner's release on the owner's own review, without external counsel (the flag's doc comment) | `packages/catalog/src/baa.ts`; `docs/baa-v1.2.2.txt` |
| B1, clause 11 (Subcontractors): the list on request; the fifteen days' notice, the objection right and the first two paragraphs are 1.2.1's | `CLAUSES_1_2_2` |
| B2, the preamble's party line and clause 18 (Notices): hello@healdesk.io in `NOTICE_ADDRESS_1_2_2`. `NOTICE_ADDRESS`, with legal@, stays frozen with 1.1.0-draft to 1.2.1. `AGREEMENT_PARTY`, which only the DPA reads, now carries the 1.2.2 address | `packages/catalog/src/baa.ts` |
| B3, clause 10 (Reporting): the spec's wording for (a), (b) and (c); the sentence explaining why five days sat inside sixty is gone; the discovery rule, the routine-attempts carve-out and the 164.410(c) contents are 1.2.1's | `CLAUSES_1_2_2` |
| Every other clause is 1.2.1's own object, by lookup, in the same order; the golden test holds 1.2.2 to exactly these three changes | `apps/app/tests/baa-golden.test.ts` ("1.2.2 against 1.2.1") |
| The go-live floor, `MIN_ACCEPTABLE_BAA_VERSION`, is 1.2.2: 1.2.1 is below it. `BAA_RELEASE_OVERLAP` stays empty | `packages/catalog/src/baa.ts` |
| `app_baa_version_acceptable()` accepts 1.2.2 and nothing else; the console's wording of the destruction job and two comments say "1.2.2 and earlier" | `apps/app/drizzle/0062_baa_floor_1_2_2.sql`; parity test in `apps/app/tests/database-audit.test.ts` |
| 1.2.2 destroys on the thirty days, as 1.2.1 does (its Term clause is 1.2.1's) | `DESTRUCTION_RULES` in `apps/app/src/lib/offboarding/offboarding.ts` |
| The unreleased drafts, edited in place: BAA 1.3.0 and DPA 1.0.0 give the list on request (the shared sentence in `subprocessor-notice.ts`), name hello@healdesk.io, and report all three without unreasonable delay and in no case later than 60 calendar days after discovery; the 24-hour rationale sentence is gone from both | `packages/catalog/src/baa.ts`, `dpa.ts`, `subprocessor-notice.ts`, `dpa-explainer.ts`; `docs/baa-v1.3.0.txt` (then the draft copy); `docs/dpa-v1.0.0.txt` |
| The phase-two read-only user's address is `hello+{slug}@healdesk.io` (was `connect+…`) | `CONNECT_EMAIL_TEMPLATE` in `packages/catalog/src/connection-steps.ts` |

1.2.1 stays registered, released and frozen (its hash still reproduces), as
every superseded version does; the signing screen's notes for 1.2.2 are
1.2.1's, which say nothing about where the list is kept.

### 13.3 The text, against 1.2.1

Clause 10, items (a) to (c), now read:

> a. any use or disclosure of PHI not permitted by this agreement, without
> unreasonable delay and in no case later than 60 calendar days after
> healdesk becomes aware of it;
>
> b. any breach of unsecured PHI, without unreasonable delay and in no case
> later than 60 calendar days after discovery. A breach is treated as
> discovered on the first day it is known, or by exercising reasonable
> diligence would have been known, to healdesk or to any person other than
> the one committing it who is healdesk's workforce member or agent, as 45
> CFR 164.410(a)(2) provides;
>
> c. any security incident, without unreasonable delay and in no case later
> than 60 calendar days after healdesk becomes aware of it — except routine
> unsuccessful attempts that compromised nothing, such as blocked sign-ins,
> port scans and filtered traffic, which the parties agree this clause
> reports once, here, and which healdesk will summarise on request.

Clause 11's third paragraph:

> healdesk will give Practice its current list of these subcontractors on
> Practice's written request to healdesk's email address in the Notices
> clause, and will give Practice at least fifteen days' notice by email
> before adding one that will handle PHI. If Practice objects on reasonable
> grounds before the change takes effect, Practice may terminate under the
> Term clause without penalty.

The preamble and clause 18 give healdesk's address as "800 N King Street,
Suite 304-1426, Wilmington, DE 19801, United States, and by email to
hello@healdesk.io".

The shared sentence BAA 1.3.0 and the DPA carry now opens: "healdesk will
give Practice its current list of its subcontractors on Practice's written
request to healdesk's email address in the Notices clause, and will give
Practice at least 24 hours' notice by email before adding one that will
handle the information this agreement protects." The rest is unchanged.

### 13.4 Golden hashes

| Document and variant | SHA-256 |
| --- | --- |
| 1.2.2 covered_estimated (the sample, and covered_outbound) | `e6cfb7356be47a223bf8802f8d762f78844e0106af29fe772ca03eab85621893` |
| 1.2.2 notcovered_estimated | `07551348644ed59f47dd0a8ae5ff66ccb6297334d9360a25a6ec70bb247f4127` |
| 1.2.2 unknown_estimated | `ecdd2ce97442408babcf39326aae73442540474b60113234e5b23df3b56456bf` |
| 1.2.2 covered_verified_boulevard | `d75c7113583d6b13ff11efc02e459e30671f074024f12ce5b09396be6756f06a` |
| DPA 1.0.0 sample | `10b6feef5a2218d8c3fe625b9f3cb5bff3b2f40744a5ce03179d7c5ce79662de` |

The ten 1.3.0 hashes moved, as § 12.12 lists, and so did the DPA's eight
(`packages/catalog/src/dpa.test.ts`). No hash of a released version moved:
1.2.1 / covered_estimated is still
`618ac4a585a42f23d70865042c5a02e0b4765c07b6e65ba8ecf586e8f386cfd3`, and
1.2.0, 1.0.0, 1.1.0-draft and 0.1.0-draft reproduce as before.

The DPA's eight moved again with gates 6, 8 and 9 (12 October 2026), whose
clause 13 and 17 sentences and term-time retention paragraph were drafted
before 1.2.2 and merged after it, and with the owner's refund rule of the
same day in its Term clause (dpa.md, gap 17): the DPA 1.0.0 sample is now
`ff3e7acf0f37364ab85a352008fbbc1632e41f2f584514f5fde2fb6b4d9b3b3b`. No BAA
hash moved with them.

### 13.5 What the change costs, for the owner

- **Sixty days is the regulation's outer limit, not a target.** 45 CFR
  164.410(b) allows a business associate sixty days. A covered practice's own
  sixty days to notify patients under 164.404 may run from healdesk's
  discovery where healdesk acts as its agent (164.404(a)(2)), so a report
  near the limit could leave the practice none of its own. 1.2.1's five
  calendar days were written for that reason. "Without unreasonable delay" is
  the binding standard before the limit, and the internal 24 hours is how
  healdesk meets it. Recorded as risk 14 in `brief.md`.
- **California, for a practice outside HIPAA.** Cal. Civ. Code 1798.82(b)
  asks a business that maintains data it does not own to notify the owner
  "immediately following discovery". The DPA and 1.3.0's text met that until
  now; the text alone no longer does, though the statute binds healdesk
  directly and the internal 24 hours meets it. The release audits of 1.3.0
  and the DPA should decide whether either adds "or sooner where a law that
  applies requires it". Open.
- **Vendor notices.** AWS's BAA gives AWS sixty days from its own discovery
  (§ 3.4.3), so a vendor report at the end of its window would leave
  healdesk's sixty days nothing; the runbook acts on a vendor notice the day
  it arrives (`docs/policies/aws-hipaa-account.md`).
- **The list on request.** 45 CFR 164.504(e) asks for no published list; the
  notice before a new subcontractor and the objection right are unchanged.
  A clinic now has to ask, by email, to see the list, and an operator answers
  from the internal register (`docs/hipaa-compliance.md`).
- **One address.** Clause 18 makes hello@healdesk.io the notice address, so
  the Security Official must see what arrives there
  (`docs/policies/security-official.md`).

### 13.6 Outside this change

The deletion of `/subprocessors` and of every legal@ and privacy@ mention on
the website (`apps/web/src/lib/legal.ts` and the pages that read it) is
apps/web's. The apps/web tests that pin 1.2.1 as the version offered move to
1.2.2 with it. `docs/incident-response.md` keeps its 24-hour clocks as the
internal practice; its sentences that attribute them to BAA 1.3.0 need the
same correction as `docs/hipaa-risk-analysis.md` T12 received.

---

## 14. BAA 1.4.0: the transcript emailed, not kept

> **Not legal advice.** The owner released BAA 1.4.0 on 13 October 2026, on
> the owner's own instruction and **without external counsel**, the day the
> owner decided that healdesk keeps no transcript. The text was drafted by an
> AI assistant from the code, as the rest of this folder was. **Recommended:
> counsel reviews 1.4.0's three changed clauses, and the points in § 14.5,
> before the first live clinic.** No clinic had signed 1.3.0, so 1.4.0
> replaces it outright: no overlap, and the go-live floor rises to 1.4.0.
> The DPA, unreleased, takes the same change in place.

### 14.1 What the owner decided (13 October 2026)

When a call or a website chat ends, its transcript is emailed to the
clinic's one address (its sign-in, billing and notice address) and healdesk
keeps no transcript. A send that fails must still reach the clinic, so the
transcript waits, encrypted, until the email has gone and for seven days
after, and is then deleted. The conversation's record stays, without the
words: channel, times, outcome, the booking it produced, and when the "I'm
an AI assistant, this call is transcribed" line played, on its 90-day
record clock. No call audio is kept, and no Meta message is kept or
emailed, as before. The design record is
`docs/design/transcript-email-2026-10-13.md`; its "What has to change to
match" table names the 1.3.0 and DPA passages this release changes.

1.3.0 described the opposite in three clauses: healdesk "keep[s]
transcripts and records of those conversations" and exports, corrects or
deletes them (clause 4, purpose e); what people say is "kept as
transcripts" (clause 4, the information involved); and "healdesk keeps each
conversation, with its transcript, for 90 days … Practice may shorten the
period for transcripts in its portal" (clause 11). Released as it stood, it
would have promised a stored, exportable, correctable transcript and a
portal setting that no longer has anything to act on. The design record
says a new version is cheapest now, while no clinic has signed.

### 14.2 What the code does, read 13 October 2026

Read at `7da5ee3` (the transcript outbox), on the branch that carries
`8aa930d` (the transcript email).

| Sentence (clause) | The code fact | Where |
| --- | --- | --- |
| "When a call or a website chat ends, healdesk emails its transcript" (11) | The voice endpoint and the chat API are to queue the transcript in the conversation's own tenant transaction (`queueTranscriptEmail`) and send it straight after commit (`sendQueuedTranscriptNow`); neither is built yet, so nothing produces a transcript today. The Meta channels are refused by both the queue and the renderer | `apps/app/src/lib/conversations/transcript-outbox.ts`, `transcript-email.ts` |
| "to the email address on Practice's healdesk account, and to no other address" (11) | Each send goes to `billingRecipients`: the active owner and billing memberships' addresses, or, for a clinic provisioned before identities existed, the buyer seeded at provisioning. In v1 there is one shared sign-in, so one address; a second membership would get its own send | `apps/app/src/lib/billing/recipients.ts`; `deliverTranscriptEmail` |
| "only over an encrypted connection, as the Safeguards clause provides" (11; clause 10's "An email whose receiving server will not negotiate encryption is failed, not sent" is unchanged) | The email is classed `may-carry-phi`; `getTransport` sends that class only through SES with a configuration set whose `TlsPolicy` is `REQUIRE`, or refuses; Resend never carries it and refuses any blind copy | `apps/app/src/lib/reporting/deliver.ts`, `resend-transport.ts`; `infra/aws/ses.tf` |
| "healdesk holds one encrypted copy of the transcript" (11) | `transcript_emails.sealed`, sealed under the KMS key with the clinic's lock label, one row per conversation (unique index), forced row-level security, the BAA gate on insert; the runtime role cannot rewrite the copy | `apps/app/drizzle/0069_transcript_outbox.sql` |
| "until seven days after the email was first accepted for delivery or, if it never is, seven days after the transcript was queued for sending, and then deletes it" (11) | The trigger `app_transcript_email_clock` sets `destroy_after` from the database's clock: queue time plus seven days, moved once, at the first recorded send (`sent_at`, SES's acceptance), to that send plus seven days; no later send moves it. The `transcript-emails` job deletes each row once `destroy_after` has passed, every minute from the `billing-minute` queue with the hourly tick as its backstop. The copy also goes with its conversation (foreign key) and with the clinic's destruction | drizzle/0069; `runTranscriptEmailsJob`, `destroyTranscriptEmail`; `apps/app/src/lib/offboarding/offboarding.ts` |
| "healdesk may send the email again when a send fails or the email is returned, and when Practice asks" (11) | A failed send is tried again after 1, 2, 5, 10 and 30 minutes, then hourly; an SES hard bounce, rejection, complaint or rendering failure (`/api/webhooks/ses`) marks it bounced and it is sent again an hour later; the ops operation `resendTranscript` sends it again while the copy lasts. Ops hears on the third failure and if a copy is deleted unsent (`transcript_undelivered`, ids only) | `transcript-outbox.ts`; `apps/app/src/app/api/webhooks/ses/route.ts`; `apps/app/src/lib/ops/api.ts` |
| "healdesk keeps no other copy of a transcript, apart from the backups described below" (11) | `conversations.transcript_uri` is written null; the outbox logs ids, statuses and SES's scrubbed reason only. The archive copy to a healdesk mailbox (`HEALDESK_TRANSCRIPT_ARCHIVE_TO`) is off, and sends nothing unless `HEALDESK_TRANSCRIPT_ARCHIVE_BAA=signed`, which Terraform sets only with `transcript_archive_baa_signed`. The sealed copy is in the database's backups until they expire (35 days, the sentence after) | `transcript-email.ts` (`archiveCopyAddress`); `infra/aws/variables.tf`; `apps/app/src/lib/voice/ingest.ts` |
| "healdesk keeps the record of each conversation, without what was said or written in it, for 90 days after it took place" (11) | The `conversations` row (channel, times, outcome, the service asked about, `disclosure_played_at`, the contact) on the record clock, which the purge runs for every 1.4.0 clinic whatever its switch (`purgeIsPromised` reads the period off this text) | `apps/app/src/lib/retention/purge.ts`; `apps/app/src/lib/agreements/what-it-says.ts` |
| "After them healdesk has no transcript to make available, amend, export or delete" (14) | Neither export (`exportPatient`, `exportClinic`) reads `transcript_emails`; once the row is gone nothing holds the words | `apps/app/src/lib/patient-rights/export.ts` |

### 14.3 The text, against 1.3.0

Three clauses change; every other clause is 1.3.0's own clause object, in
1.3.0's order, and the preamble differs only in its version line
(`apps/app/tests/baa-golden.test.ts`, "1.4.0: the transcript emailed, not
kept", holds it to that).

| Clause | 1.3.0 | 1.4.0 |
| --- | --- | --- |
| 4, Where Practice is not a covered entity (purpose e) | "e. keep transcripts and records of those conversations and bookings, show them to Practice's staff, and export, correct or delete them when Practice asks;" | "e. email Practice the transcript of each call and website chat, keep records of those conversations, without what was said or written in them, and of bookings, show those records to Practice's staff, and export, correct or delete them when Practice asks;" |
| 4 (the information involved) | "The patient information involved is what people say or write, kept as transcripts with no call audio; …" | "The patient information involved is what people say or write, which healdesk keeps no longer than the clause headed "Minimum necessary" allows and, from a call or a website chat, emails to Practice as a transcript, with no call audio; …" |
| 11, Minimum necessary | "Anything else a person chooses to say or write is kept only in the transcript of that conversation, for the period below." | "Anything else a person chooses to say or write on a call or in a website chat is kept only in the transcript of that conversation, for no longer than the next paragraph allows." |
| 11 (new paragraph) | — | "healdesk does not keep transcripts. When a call or a website chat ends, healdesk emails its transcript to the email address on Practice's healdesk account, and to no other address, only over an encrypted connection, as the Safeguards clause provides. So that an email that fails or is returned can be sent again, healdesk holds one encrypted copy of the transcript until seven days after the email was first accepted for delivery or, if it never is, seven days after the transcript was queued for sending, and then deletes it. Until then healdesk may send the email again when a send fails or the email is returned, and when Practice asks. healdesk keeps no other copy of a transcript, apart from the backups described below; what Anthropic keeps is what the Subcontractors clause describes. Once healdesk's copy is deleted, the email is Practice's own record of what was said, and Practice is responsible for keeping, protecting and deleting it." |
| 11 (retention) | "healdesk keeps each conversation, with its transcript, for 90 days after it took place, … Practice may shorten the period for transcripts in its portal. A backup copy …" | "healdesk keeps the record of each conversation, without what was said or written in it, for 90 days after it took place, … A backup copy …" (the sentence on shortening is gone; every other period is 1.3.0's word for word) |
| 14, Patient access, amendment and accounting (new paragraph after the list) | — | "healdesk holds a transcript only to deliver it to Practice, and only for the days the clause headed "Minimum necessary" allows. After them healdesk has no transcript to make available, amend, export or delete: the email that carried it is Practice's own record, and Practice answers a request about a transcript from that email." |

The rest of 1.3.0 already reads true of the emailed transcript: clause 10's
email sentence is the one the transcript relies on; clause 4(c)'s deletion
on request reaches the outbox copy, which erasure deletes with the person's
conversations (foreign key); clause 17's export and destruction reach it
(`destroyClinicData` deletes `transcript_emails`, and
`app_mark_clinic_destroyed` refuses while one is left, drizzle/0069); and
the opening-line sentence of clause 11 says only that the line is given and
cannot be switched off. No clause of 1.3.0 or 1.4.0 relies on a stored
transcript as the record of the AI and transcription announcement
(§ 14.5, item 5).

The DPA (unreleased, so edited in place; `docs/dpa-v1.0.0.txt` and its
eight hashes regenerated) takes the same three changes in its own words: its
clause 5 is `stateLawClauseBody140` with the subject "Client Information";
its clause 10, "Minimum necessary, and who receives Client Information",
carries 1.4.0's transcript paragraph word for word and the period of the
record of each conversation without the words, and no longer lets Practice
shorten the period for transcripts; its clause 13, "Clients' requests",
gains the paragraph of 1.4.0's clause 14 with "give Practice, correct or
delete" for "make available, amend, export or delete" (`dpa.md`, § 6, gap 2).

### 14.4 What shipped

| Change | Where |
| --- | --- |
| 1.4.0 is `BAA_TEMPLATES[0]`, `publishedOn` 2026-10-13, `approvedByCounsel: true`, which records the owner's release (the flag's doc comment); checkout offers it and signing takes it. Its clauses are `CLAUSES_1_3` with `STATE_LAW_1_4`, `MINIMUM_NECESSARY_1_4` and `PATIENT_RIGHTS_1_4` in place of 1.3.0's three; its preamble and render guard are 1.3.0's naming 1.4.0 | `packages/catalog/src/baa.ts` |
| The shared state-law clause keeps 1.3.0's frozen wording as `stateLawClauseBody`, and 1.4.0's beside it as `stateLawClauseBody140`; the catalog's `baa.test.ts` holds the two to differing in the two sentences above and nothing else | `packages/catalog/src/baa.ts` |
| 1.3.0 is `BAA_TEMPLATES[1]`, frozen, and no longer signable: `BAA_RELEASE_OVERLAP` is empty | `packages/catalog/src/baa.ts`; `signableTemplate` in `apps/app/src/lib/agreements.ts` |
| The go-live floor rises to 1.4.0: provisioning, the checkout's agreement check, go-live and a supersede refuse a 1.3.0 signature | `MIN_ACCEPTABLE_BAA_VERSION` |
| `app_baa_version_acceptable()` accepts 1.4.0 and nothing else; `app_destruction_rule()` gives 1.4.0 the export rule 1.3.0 has (its Term clause is 1.3.0's own); a DO block asserts both lists and the election list as 0068 left it | `apps/app/drizzle/0070_baa_release_1_4_0.sql`; parity tests in `apps/app/tests/database-audit.test.ts` and `destruction-clock.test.ts` |
| `DESTRUCTION_RULES` gives 1.4.0 the export rule; `PURGE_PERIODS` reads the conversation's period in either wording, so a 1.4.0 clinic is purged nightly whatever the switch, as a 1.3.0 clinic is | `apps/app/src/lib/offboarding/offboarding.ts`; `apps/app/src/lib/agreements/what-it-says.ts` |
| The signing screen's note beside 1.4.0's clause 11 says the transcript is emailed and healdesk's copy deleted seven days after; 1.4.0's other notes and its bullets are 1.3.0's own objects | `packages/catalog/src/baa-explainer.ts` |
| The portal's Records card ("Keep transcripts for") is gone, with its server path: the key `transcript_retention` is refused as no setting, and setup's writer no longer takes the field. The column `clinic_settings.transcript_retention_days` stays, read by the purge, where a value saved before only ever deletes sooner | `apps/app/src/app/c/[slug]/settings/`; `apps/app/src/lib/portal/settings.ts`, `settings-view.ts`; `apps/app/src/lib/setup/settings.ts` |
| /terms, /privacy and /data-deletion say each transcript is emailed to the clinic and not kept, the one copy deleted seven days after the email first goes, and the conversation's record kept 90 days without the words; nothing offers a shorter period; the Terms' export no longer promises transcripts, and its annex says the record of each call notes when the opening line was given rather than that the line is "the first line of every transcript". LEGAL_VERSION 2026-10-13.3 | `apps/web/src/app/terms/page.tsx`, `privacy/page.tsx`, `data-deletion/page.tsx`; `apps/web/src/lib/legal.ts` |
| The released review copy, with the variant clauses, the election and the disclosure in appendices | `docs/baa-v1.4.0.txt` |

**The floor, and nobody signed.** 1.3.0 is below the floor from this
release, as 1.2.2 was from 1.3.0's. Nothing in the code needed it to stay
acceptable. No clinic has signed any version: `apps/app` is deployed for no
real clinic and has only ever held synthetic and seed data (CLAUDE.md).
`createDemoClinic` and both signing paths sign `BAA_TEMPLATES[0]`.
Provisioning reads a location's calendar terms from the clause ids an
acceptance applied (`CALENDAR_CLAUSE_IDS_1_3`, `templateReadsCalendarAccount`),
and 1.4.0 applies 1.3.0's calendar clauses under the same ids, so a 1.4.0
signer's first location gets its terms exactly as a 1.3.0 signer's did, and
`calendar-election/1.0.0` takes the place of 1.4.0's calendar clause word for
word. The two-deploy window `BAA_RELEASE_OVERLAP` exists for cannot strand a
buyer, because nothing is deployed for one to be part-way through a checkout
on. The tests that sign "the current version" now sign 1.4.0; those that
read 1.3.0's own behaviour name 1.3.0 as current themselves, as the tests of
1.2.x did after 1.3.0's release.

### 14.5 For counsel, and the owner

Counsel review of 1.4.0 is recommended before the first live clinic, on
these points in particular. Each open row has an owner.

1. **The practice's inbox becomes the record.** After seven days healdesk
   cannot produce, amend, export or delete a transcript, and clause 14 says
   Practice answers from the email. Is a transcript the business associate
   held only to deliver it part of a designated record set it must keep
   available under 164.524 and 164.526, and may the agreement put that duty
   on Practice once the copy is delivered? (owner; counsel)
2. **The practice's mailbox.** The one address is often a shared info@
   inbox, and many practices have no business associate agreement of their
   own with their email provider. The agreement now says Practice keeps,
   protects and deletes the email; it does not tell Practice to receive it
   at a mailbox under such an agreement. Counsel may want that said, in the
   agreement or at setup. (owner; counsel)
3. **Replies.** The email comes from hello@healdesk.io, which has no
   business associate agreement behind it, and asks not to be replied to. A
   reply would put the transcript there. Settle it with a covered reply-to,
   or accept the risk in writing. (owner)
4. **The archive copy.** The code can blind-copy every transcript to a
   healdesk mailbox, and it is off. Turned on, it is a copy healdesk keeps,
   which 1.4.0's "healdesk keeps no other copy of a transcript" forbids:
   turning it on needs a new agreement version (and a mailbox held under a
   business associate agreement, which the code already requires). (owner)
5. **The call-announcement record (state-disclosure.md, R1).** For
   Washington and Connecticut the record that the "this call is transcribed"
   line was given was to be the transcript's first line and its timestamp.
   healdesk no longer keeps the transcript, so the record it holds is
   `conversations.disclosure_played_at`, the fixed audio asset the line is
   played from, and the vendor's call log; the emailed transcript, in
   Practice's hands, may carry the line too. No clause of 1.3.0 or 1.4.0
   relies on a stored transcript for it, and the Terms annex no longer says
   the line is "the first line of every transcript". Put to counsel with R1.
   (counsel)
6. **A transcript that never goes.** After seven days of failed sends the
   copy is deleted and the transcript is lost; ops hears at the third
   failure and at the deletion, and a person tells the clinic. Clause 10's
   "healdesk tells Practice rather than send it in the clear" is kept by
   that person: nothing tells the clinic automatically. (owner)
7. **The seven days depend on a switch.** The deletion runs in the
   `transcript-emails` job, seeded on, through `runSwitchedJob`: an
   operator who switches it off stops the deletion, and the copies outlive
   the seven days clause 11 states. `offboarding-destroy` and
   `retention-purge` run for every clinic whose agreement promises them
   whatever their switch (`runWideningJob`); the outbox's deletion should
   too, or the console should refuse to switch it off. (engineering)
8. **The voice vendor's copy.** Retell transcribes the call and keeps what
   its per-agent retention setting says. It is a subcontractor bound to the
   same restrictions, so its retention must be set to its minimum, and no
   longer than healdesk's seven days, before the first call; Anthropic's
   30 days are what clause 13 states. (owner; infra)
9. **Raw vendor payloads.** The pre-Retell Synthflow webhook still stores
   its raw payload (`webhook_events.raw_payload`, up to 30 days), which can
   carry a transcript, beside "healdesk keeps no other copy". That route
   serves no clinic in v1; it must be removed, or stop keeping the
   transcript, before any real call reaches it, and the Retell endpoint must
   store none (the design record's "Raw vendor payloads"). (engineering)
   **Done 14 October 2026:** the webhook was removed, and with it the only
   code that stored a voice vendor's raw payload; the Retell endpoint stores none.
10. **Backups.** The sealed copy is in the database's backups until they
    expire, within 35 days of its deletion, which clause 11's "apart from
    the backups described below" says.
11. **Outside this change.** The spec (`docs/v1-product-spec.md`, an export)
    still describes a stored, searchable transcript and a 30- or 7-day
    shortening; the owner's spec doc changes and is re-exported. Product
    copy outside the agreements and the legal pages still describes kept
    transcripts: the cancellation email promises "your export of
    transcripts" (`apps/app/src/lib/email/templates/canceled.ts`), the
    homepage FAQ says "transcripts automatically after 90 days, or sooner
    if you choose" (`apps/web/src/components/KnowMore.tsx`), the demo's
    product brief says "Opening a transcript needs a second factor"
    (`apps/web/src/lib/knowledge/index.ts`), and the vendor register's
    hosting and voice rows list transcripts (`apps/web/src/lib/subprocessors.ts`).
    (funnel; owner)

### 14.6 Golden hashes

Frozen from the release (`apps/app/tests/baa-golden.test.ts`):

| Document and variant | SHA-256 |
| --- | --- |
| 1.4.0 covered_estimated (the sample, and covered_outbound) | `090b15ed4e7c18484e478f9fd7513fe98fac7538970aff02966913d19d081f1c` |
| 1.4.0 notcovered_estimated | `860a6b5c3ee77c81d51f0926664027bd15636ab8122d8723331f574cd16776c0` |
| 1.4.0 unknown_estimated | `24fbf49533fa8dc3f305177398bbc357343f254893f2ae6ac7cf3dbd3032194b` |
| 1.4.0 uncovered_nobaa | `8368172f436a9745c5f49b3618f0868fb4699f0949d126ef18b11533aa6535b8` |
| 1.4.0 uncovered_personal | `44783845eb1f726364f4880165ceac442577a5cebaafacdfb1bc2c421515ac40` |
| 1.4.0 notused_mindbody | `2bba813e83d84759fd11da4b3f7100668ac09b7fd967a996f68bdb59c866b7fe` |
| 1.4.0 notused_other | `2991f7af136e30740ff9ef1571abc388310c2d6f05d3250d8c1913614f5d8d2b` |
| 1.4.0 live_calcom | `7b847d7578719c64b59a58a5a60db1abcea3a66b53d631e048ba20ea1c12c642` |
| 1.4.0 live_highlevel_personal | `e82033ab4c71ee1ac6463098229b0aa3553702612cc6599ec5401362bb640ff7` |
| 1.4.0 live_calendly_nobaa | `015d11feb12702430ae5cdfae6b1b198960d01a5d1d4e06ee8f9aade6064f433` |
| DPA 1.0.0 sample, regenerated | `97058d2d2ca9ec0483a1cf2e2d459ee7d3ae3d0c9949ad38cc8dd052104dad05` |

No released hash moved: 1.3.0 / covered_estimated is still
`d9117482bba644006763a9d613d94ec0a38a3f8888a95b61ad6fbb6f3a68acb3`, 1.2.2 and
every older version reproduce as before, and so do the election
(`63586893a436803155ee71811ea17a8d71800a0d90ce41e1b3d9c596650a02aa`, rendered
against 1.3.0) and the Google Calendar disclosure. The DPA's other seven
hashes moved with its sample (`packages/catalog/src/dpa.test.ts`).

---

## 15. BAA 1.5.0: the transcript's copy deleted once delivery is confirmed

> **Not legal advice.** The owner released BAA 1.5.0 on 14 October 2026, on
> the owner's own instruction and **without external counsel**, the day the
> owner decided that a transcript's encrypted copy is deleted the moment its
> delivery is confirmed. The text was drafted by an AI assistant from the
> code, as the rest of this folder was. **Recommended: counsel reviews
> 1.5.0's two changed clauses, with § 14.5 and the points in § 15.5, before
> the first live clinic.** No clinic had signed 1.4.0, so 1.5.0 replaces it
> outright: no overlap, and the go-live floor rises to 1.5.0. The DPA,
> unreleased, takes the same change in place.

### 15.1 What the owner decided (14 October 2026)

1.4.0 held each transcript's one encrypted copy until seven days after SES
first accepted the email, delivered or not, so that a clinic that lost the
email could be sent it again. The owner decided that no copy is kept once
the clinic has the email, and none indefinitely when it never arrives:

- the copy is deleted the moment delivery is confirmed: SES's Delivery event
  for the message the row records, which says the practice's mail server
  accepted the email, deletes it in the same transaction;
- if delivery fails, the copy is kept and the email sent again until it is
  delivered: a failed send keeps its back-off, and a hard bounce, a
  rejection, a complaint or a rendering failure is sent again an hour later;
- but never for longer than 30 days after the transcript was queued: then
  the copy is deleted, and ops hears, so a dead address cannot keep patient
  words;
- an email SES accepted with no Delivery and no failure 72 hours after it
  was last sent loses its copy then, and ops hears once (SES's events are
  probably not reaching the app); a transient bounce or a delay is not an
  answer;
- what stays is a receipt without the words (the conversation, the
  attempts, when it was sent and delivered, SES's message id, the status,
  SES's scrubbed reason), so the owner and the clinic can know whether each
  transcript reached the clinic. It goes with its conversation.

The blind archive copy to a healdesk mailbox, which 1.4.0's "healdesk keeps
no other copy" already forbade and the code kept off (§ 14.5, item 4), is
removed from the code. The design record is
`docs/design/transcript-email-2026-10-13.md`.

### 15.2 What the code does, read 14 October 2026

| Sentence (clause) | The code fact | Where |
| --- | --- | --- |
| "healdesk holds one encrypted copy of the transcript only until Practice's mail server confirms that it has received the email, and then deletes the copy at once" (11) | `recordSesTranscriptEvent`, called by `/api/webhooks/ses` for a verified SNS message, sets `sealed` to NULL, the status to `delivered` and `delivered_at` (the database's clock) in one tenant transaction, for the SES message id the row records and only while it holds a copy; an event for an earlier send, whose id the row no longer records, finds nothing. A CHECK holds `sealed` NULL exactly when the status is delivered, expired or unconfirmed, and the trigger lets a copy become NULL only with one of those statuses, never come back, and a receipt never change | `apps/app/src/lib/conversations/transcript-outbox.ts`; `apps/app/src/app/api/webhooks/ses/route.ts`; `apps/app/drizzle/0072_transcript_delete_on_delivery.sql` |
| "If a send fails or the email is returned, healdesk keeps the copy and sends the email again until it is delivered" (11) | A failed send waits 1, 2, 5, 10 and 30 minutes, then an hour between tries; SES's hard bounce, rejection, complaint or rendering failure for a sent row marks it bounced, sent again an hour later. Ops hears on the third failure and at the first bounce (`transcript_undelivered`, ids only) | `deliverTranscriptEmail`, `recordSesTranscriptEvent` |
| "If the email is accepted for delivery but neither its delivery nor its failure is confirmed within 72 hours of its last sending, healdesk deletes the copy then" (11) | `sent_at` is set from the database's clock at each accepted send; `app_transcript_email_work` returns a sent row 72 hours after it as `unconfirmed`, and `endTranscriptCopy` deletes the copy under the same condition, which the trigger checks again; ops hears once per transcript | drizzle/0072; `endTranscriptCopy`, `runTranscriptEmailsJob` |
| "In no case does healdesk hold the copy for more than 30 days after the transcript was queued for sending" (11) | `destroy_after` is `created_at` plus 30 days, set by the trigger at the insert and never moved; the work function returns every row still holding a copy past it as `expire`, before any send, and the claim refuses to send one; the trigger refuses `expired` before it | drizzle/0072; `deliverTranscriptEmail`'s claim |
| (the deletions do not depend on a switch) | Both deletions run in `runTranscriptEmailsJob` outside `runSwitchedJob`, whatever the `transcript-emails` switch says, every minute from the `billing-minute` queue with the hourly tick as its backstop; the switch governs sending only | `runTranscriptEmailsJob`; `apps/app/src/lib/scheduler/tick.ts`; `apps/app/src/workers/index.ts` |
| "While it holds the copy, healdesk may also send the email again when Practice asks" (11) | The ops operation `resendTranscript` queues a row that is pending, bounced, or sent and awaiting SES's answer; a receipt answers `gone` | `resendTranscript`; `apps/app/src/lib/ops/api.ts` |
| "healdesk keeps a record of each transcript's delivery, without what was said or written in it, for as long as it keeps the record of that conversation" (11) | The `transcript_emails` row, once a receipt, holds no copy; it goes with its conversation by the foreign key's cascade (the record clock, erasure), and with the clinic's destruction (`destroyClinicData`; `app_mark_clinic_destroyed` refuses while one is left). The read-only ops operation `transcriptDeliveries` shows counts by status and the newest receipts, never words, an address or SES's reason | drizzle/0069, 0072; `apps/app/src/lib/offboarding/offboarding.ts`; `listTranscriptDeliveries` |
| "It keeps no other copy of a transcript" (11) | The archive copy is gone from the code: no blind copy option, no `bcc` on a delivery target, no BccAddresses on the SES send, and the `HEALDESK_TRANSCRIPT_ARCHIVE_*` variables are read nowhere | `transcript-email.ts`; `apps/app/src/lib/reporting/deliver.ts` |
| "Once the copy is deleted, healdesk has no transcript to make available, amend, export or delete" (14) | Neither export reads `transcript_emails`; a receipt holds no words | `apps/app/src/lib/patient-rights/export.ts` |

### 15.3 The text, against 1.4.0

Two clauses change; every other clause is 1.4.0's own clause object, in
1.4.0's order (the state-law clause included: it says only that what
people say is kept no longer than the Minimum necessary clause allows), and
the preamble differs only in its version line
(`apps/app/tests/baa-golden.test.ts`, "1.5.0: the transcript's copy deleted
once delivery is confirmed", holds it to that).

| Clause | 1.4.0 | 1.5.0 |
| --- | --- | --- |
| 11, Minimum necessary (the transcript paragraph; the other five paragraphs are 1.4.0's word for word) | "… So that an email that fails or is returned can be sent again, healdesk holds one encrypted copy of the transcript until seven days after the email was first accepted for delivery or, if it never is, seven days after the transcript was queued for sending, and then deletes it. Until then healdesk may send the email again when a send fails or the email is returned, and when Practice asks. healdesk keeps no other copy of a transcript, apart from the backups described below; …" | "… So that an email that fails or is returned can be sent again, healdesk holds one encrypted copy of the transcript only until Practice's mail server confirms that it has received the email, and then deletes the copy at once. If a send fails or the email is returned, healdesk keeps the copy and sends the email again until it is delivered. If the email is accepted for delivery but neither its delivery nor its failure is confirmed within 72 hours of its last sending, healdesk deletes the copy then. In no case does healdesk hold the copy for more than 30 days after the transcript was queued for sending: a copy whose email has not been delivered by then is deleted. While it holds the copy, healdesk may also send the email again when Practice asks. healdesk keeps a record of each transcript's delivery, without what was said or written in it, for as long as it keeps the record of that conversation. It keeps no other copy of a transcript, apart from the backups described below; …" |
| 14, Patient access, amendment and accounting (the paragraph after the list) | "healdesk holds a transcript only to deliver it to Practice, and only for the days the clause headed "Minimum necessary" allows. After them healdesk has no transcript to make available, amend, export or delete: …" | "healdesk holds a transcript only to deliver it to Practice, and only for as long as the clause headed "Minimum necessary" allows. Once the copy is deleted, healdesk has no transcript to make available, amend, export or delete: …" |

The DPA (unreleased, so edited in place; `docs/dpa-v1.0.0.txt` and its
eight hashes regenerated) takes the same two changes: its clause 10 carries
1.5.0's transcript paragraph word for word, and its clause 13 the paragraph
of 1.5.0's clause 14 with "give Practice, correct or delete" (`dpa.md`).

### 15.4 What shipped

| Change | Where |
| --- | --- |
| 1.5.0 is `BAA_TEMPLATES[0]`, `publishedOn` 2026-10-14, `approvedByCounsel: true`, which records the owner's release (the flag's doc comment); checkout offers it and signing takes it. Its clauses are `CLAUSES_1_4` with `MINIMUM_NECESSARY_1_5` and `PATIENT_RIGHTS_1_5` in place of 1.4.0's two; its preamble and render guard are 1.3.0's naming 1.5.0 | `packages/catalog/src/baa.ts` |
| 1.4.0 is `BAA_TEMPLATES[1]`, frozen, and no longer signable: `BAA_RELEASE_OVERLAP` is empty | `packages/catalog/src/baa.ts`; `signableTemplate` in `apps/app/src/lib/agreements.ts` |
| The go-live floor rises to 1.5.0: provisioning, the checkout's agreement check, go-live and a supersede refuse a 1.4.0 signature | `MIN_ACCEPTABLE_BAA_VERSION` |
| `app_baa_version_acceptable()` accepts 1.5.0 and nothing else; `app_destruction_rule()` gives 1.5.0 the export rule 1.4.0 has (its Term clause is 1.3.0's own); a DO block asserts both lists and the election list as 0070 left it | `apps/app/drizzle/0073_baa_release_1_5_0.sql`; parity tests in `apps/app/tests/database-audit.test.ts` and `destruction-clock.test.ts` |
| `DESTRUCTION_RULES` gives 1.5.0 the export rule; `PURGE_PERIODS` needs nothing, since 1.5.0's retention paragraph is 1.4.0's, so a 1.5.0 clinic is purged nightly whatever the switch | `apps/app/src/lib/offboarding/offboarding.ts`; `apps/app/src/lib/agreements/what-it-says.ts` |
| The signing screen's note beside 1.5.0's clause 11 says healdesk's copy is deleted once the practice's mail server confirms delivery, and kept trying for up to 30 days; 1.5.0's other notes and its bullets are 1.3.0's own objects | `packages/catalog/src/baa-explainer.ts` |
| The outbox: the copy deleted with SES's Delivery event, the 30-day cap and the 72 hours on the database's clock, the receipt, the `transcriptDeliveries` operation, and the archive copy removed | `apps/app/drizzle/0072_transcript_delete_on_delivery.sql`; `apps/app/src/lib/conversations/transcript-outbox.ts`, `transcript-email.ts`; `apps/app/src/lib/ops/api.ts` |
| /terms, /privacy and /data-deletion and the homepage FAQ say the copy is deleted once delivery is confirmed, or at 30 days if it never is; the vendor register's hosting row says the same. LEGAL_VERSION 2026-10-14.1 | `apps/web/src/app/terms/page.tsx`, `privacy/page.tsx`, `data-deletion/page.tsx`; `apps/web/src/components/KnowMore.tsx`; `apps/web/src/lib/subprocessors.ts`; `apps/web/src/lib/legal.ts` |
| The transcript email tells the clinic healdesk's copy goes once its mail server confirms receipt | `apps/app/src/lib/conversations/transcript-email.ts` |
| The released review copy, with the variant clauses, the election and the disclosure in appendices | `docs/baa-v1.5.0.txt` |

**The floor, and nobody signed.** 1.4.0 is below the floor from this
release, as 1.3.0 was from 1.4.0's. No clinic has signed any version, the
product has not launched, and `apps/app` has only ever held synthetic and
seed data. 1.5.0 applies 1.3.0's calendar clauses under the same ids, so a
1.5.0 signer's first location gets its terms exactly as before, and
`calendar-election/1.0.0` takes the place of 1.5.0's calendar clause word
for word. The tests that sign "the current version" now sign 1.5.0.

### 15.5 For counsel, and the owner

Counsel review of 1.5.0 is recommended before the first live clinic, with
§ 14.5, whose items this release changes as follows.

1. **No resend after delivery.** A clinic that loses the email after its
   server accepted it can no longer be sent it again: healdesk's copy is
   gone the moment delivery is confirmed. § 14.5, item 1 (the inbox is the
   record) now applies from delivery rather than seven days after; the
   question for counsel is the same, and more pressing. (owner; counsel)
2. **Delivery is the receiving server's acceptance.** SES's Delivery event
   says the practice's mail server accepted the message, not that it
   reached a mailbox a person reads: a server that accepts and then
   quarantines or drops it counts as delivered. The agreement says "Practice's
   mail server confirms that it has received the email", which is that
   fact. (counsel)
3. **A transcript that never goes** (§ 14.5, item 6) is now lost after 30
   days of failed sends rather than seven; ops hears at the third failure,
   at the first bounce and at the deletion, and a person tells the clinic.
   (owner)
4. **SES's events are load-bearing.** Deletion on delivery depends on SES's
   events reaching `/api/webhooks/ses` (`infra/aws/ses.tf`). If they stop,
   no copy is deleted on delivery, but none outlives the 72 hours after its
   last send, and ops hears once per transcript; the clinic still has the
   email. (infra)
5. **The receipt.** The record of each transcript's delivery holds the
   conversation's id, times, attempts, SES's message id and SES's own
   reason, scrubbed: patient information only in so far as the
   conversation's record is, and kept with it. (counsel)
6. **The archive copy** (§ 14.5, item 4) is closed: the code that could
   send it is removed, and the Terraform variables that set it are removed
   from `infra/aws` separately. (engineering; infra)
7. **The voice vendor's copy** (§ 14.5, item 8): Retell's retention must
   still be set to its minimum before the first call; it should be no
   longer than the 72 hours a confirmed email's copy can now outlive its
   send, and in any case short. (owner; infra)
8. **Outside this change.** The spec (`docs/v1-product-spec.md`, an export)
   still says seven days; the owner's spec doc changes and is re-exported.

### 15.6 Golden hashes

Frozen from the release (`apps/app/tests/baa-golden.test.ts`):

| Document and variant | SHA-256 |
| --- | --- |
| 1.5.0 covered_estimated (the sample, and covered_outbound) | `cc903fb5d31765ee0f084096ef47181e55737ad3a28816e3bab9a21f37e6f7e2` |
| 1.5.0 notcovered_estimated | `f73fac87ffce5a7d0b2da7a38423ca1e9582e122d9ebddeef018c124f3b29825` |
| 1.5.0 unknown_estimated | `5845f4d5676953eed5d376dd9343b80299a859cb52108d8afd63e41cfae61e2e` |
| 1.5.0 uncovered_nobaa | `53b5f205112ad935c06e9981425afacca8e0e1f2f8a27c85d1cb55c3458c2034` |
| 1.5.0 uncovered_personal | `625b0096758cc4366b08c41de6325e36b9310f8b58b1e4466faefcb51f16cb79` |
| 1.5.0 notused_mindbody | `31a03c3426ae769ee9e5845ba1cc70097036b4bf13967dd442c9048af4abcbde` |
| 1.5.0 notused_other | `7c873d501ece8b209904d6460545bbbf180d2308284dfad818a0e8766e153c4f` |
| 1.5.0 live_calcom | `6ec8b4429bab9f7cedb8e944b2f52e019cce1ee0c02340804c1ab170ac574d58` |
| 1.5.0 live_highlevel_personal | `ac831c6e29f29f99bffb65c370047543a4fdfbbebe2dd187785bd42642db2fe8` |
| 1.5.0 live_calendly_nobaa | `eb71e8ef0b94b402950e045369b93be24094fb75d2f1c602af67d86af45675f7` |
| DPA 1.0.0 sample, regenerated | `a84117ed3b31091e8c8d02dd9744262e7bfb29aa72b60ec19b24ddfc08ff9e55` |

No released hash moved: 1.4.0 / covered_estimated is still
`090b15ed4e7c18484e478f9fd7513fe98fac7538970aff02966913d19d081f1c`, 1.3.0 and
every older version reproduce as before, and so do the election
(`63586893a436803155ee71811ea17a8d71800a0d90ce41e1b3d9c596650a02aa`, rendered
against 1.3.0; against 1.5.0, in `docs/baa-v1.5.0.txt`'s Appendix B,
`595ed7f45fd4eb3510e021abbdf285fb9afd6a1b9869a34e2f11c6c2fd0f03dd`) and the
Google Calendar disclosure. The DPA's other seven hashes moved with its
sample (`packages/catalog/src/dpa.test.ts`).

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
