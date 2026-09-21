# Counsel audit — the six remaining questions, answered

_21 September 2026. Written by the AI counsel the owner asked for, with the
statute and the case behind every answer. Not a licensed attorney's opinion;
where a lawyer's engagement letter would matter, the line says so._

The BAA half of the audit is in the launch guide (twenty-six findings, three
lenses) and is fixed by the 1.1.0 draft in `packages/catalog/src/baa.ts`. This
document answers the six questions the session limit cut off, in the order
they depend on each other. The first one decides the other five.

---

## 1. Is this clinic a HIPAA covered entity, and what changes when it is not

**The test, in one sentence.** A health care provider is a covered entity if it
transmits any health information in electronic form in connection with a
transaction for which HHS has adopted a standard (45 CFR 160.103). In practice
that means: does the practice, or anyone on its behalf (a billing service, a
clearinghouse), send electronic claims, eligibility checks or remittance
requests to an insurer? One electronic claim a year is enough. Cash-only
practices that never bill insurance electronically are not covered entities,
and many med spas, hair-restoration clinics and cosmetic dentists are exactly
that.

**How to determine it, and why the clinic must say so.** Ask three questions at
onboarding, and record the answers on the clinic row:

1. Do you bill any insurer, Medicare or Medicaid, in any form?
2. Does anyone bill on your behalf (a billing company, an EHR that submits
   claims, a clearinghouse)?
3. Do you check a patient's insurance eligibility electronically?

"Yes" to any of them is a covered entity. All "no" is probably not. The clinic
answers; healdesk records. The 1.1.0 draft changes the clause from healdesk
"confirming" the status to the Practice "notifying" it, because a vendor that
determines its customer's legal status has taken on a liability it cannot
carry: if the determination is wrong, the vendor made the mistake.

**When the clinic is a covered entity.** HIPAA governs. healdesk is its business
associate, the BAA is required (45 CFR 164.502(e)), the Privacy Rule's own
standards apply to what healdesk does in the clinic's place (164.504(e)(2)(ii)(H),
already in the agreement), and the TCPA healthcare exemption is available for
reminders and follow-ups.

**When it is not.** HIPAA does not apply to the clinic or to healdesk for that
clinic's data. Three other regimes take its place, and none is lighter:

- **The FTC Health Breach Notification Rule** (16 CFR Part 318, amended 2024)
  applies to a "vendor of personal health records" and to entities that offer
  products through them. A clinic that collects health information through a
  web chat or a call log it does not control is close to that definition, and
  the 2024 amendment made an unauthorised disclosure itself a breach. The clock
  is sixty days to individuals and, when 500 or more people are affected, ten
  business days to the FTC. Penalties run to $53,088 per violation. The
  incident table in the product carries this clock as `ftc_notify_by` when the
  clinic is not a covered entity.
- **Washington's My Health My Data Act** has a private right of action, no
  revenue threshold, and an exemption only for HIPAA-covered data, which this
  is not. Consent is required to collect or share consumer health data, and the
  consent must be separate from a general terms acceptance. California's CMIA
  covers providers regardless of HIPAA status; Nevada's SB 370 and Connecticut's
  law are similar to Washington's without the private action.
- **The FTC Act §5** reaches any claim healdesk or the clinic makes about
  privacy or security; "HIPAA-compliant" as a badge is the specific claim the
  FTC has fined (Henry Schein, 2016).

**What healdesk does about it.** The same safeguards apply to every clinic
regardless of status (the agreement says so). For a non-covered clinic, the
agent's opening disclosure and the web chat's consent line double as the
Washington consent, worded to name what is collected and why. The FTC clock is
computed automatically when an incident is opened. Reactivation messaging
stays off, because the TCPA exemption is not available (see question 4).

**Where a lawyer's record matters.** The consent wording for Washington and
California, and whether a given clinic's answers to the three questions were
recorded correctly. A short engagement to bless the three-question script and
the consent line is the highest-value hour of legal time in the whole plan.

---

## 2. Call recording under California's CIPA

**The exposure.** California Penal Code §631 (wiretapping) and §632
(confidential communications) are two-party-consent statutes with statutory
damages of $5,000 per violation, class-certifiable, no proof of harm required.
*Ambriz v. Google* (N.D. Cal. 2025) held that an AI vendor whose system listens
to a call can be a third-party eavesdropper under §631 even where the business
consented, and that the test is the vendor's **capability** to use the content
for its own purposes, not whether it did.

**Two questions, two answers.**

*Is healdesk, or Synthflow, a party or a third party?* The agent that answers
the call is the party the caller is speaking to: it is the clinic's front desk,
acting for the clinic. That is the strongest position and it should be kept
clean: healdesk's agent speaks for the clinic, in the clinic's name, under the
"acting in your place" clause. Synthflow and the language-model provider are
the harder case, because they are the *Ambriz* fact pattern: a vendor's system
receives the audio. The defence is contractual and architectural, not verbal.
A recording disclosure alone does not answer *Ambriz*; a subprocessor contract
that forbids the vendor from using call content for its own purposes does.
Synthflow's Subscriber Terms §14.4 (no training on customer input or output)
and Anthropic's no-training terms are therefore not nice-to-haves. They are the
evidence. Keep both, in writing, and keep the versions.

*What must the spoken disclosure say?* Before any audio is transcribed: that
the caller is speaking with an automated assistant, that the call is recorded
and transcribed, and that a person is available. All three, in one breath,
first. The product's `voiceDisclosure()` in
`apps/app/src/lib/compliance/disclosure.ts` says exactly that, and the
`disclosure_played_at` field is the evidence it was said before content
flowed. "Transcribed" is not decoration: transcription is the interception of
contents that §631 is about, and a disclosure that says "recorded" alone does
not describe it.

**The caller who refuses.** In a two-party state, if the caller says "don't
record this", continuing to record is the violation. The product records the
refusal (`recording_opt_out`) and the runbook's instruction is that the agent
offers a callback from a person or ends the call; whether Synthflow can stop
recording mid-call is question 8 on the vendor list and decides whether there
is a third branch. Until it is answered, recordings should be **off** at the
agent level, which also removes the retention problem: with storage off,
nothing is recorded to refuse.

**Recommendation.** Recordings and transcripts off at Synthflow until question
8 and the storage-off extractor test are answered; the disclosure as written;
the vendor no-training terms filed; clinics told in the BAA that calls are
answered by an automated agent and transcribed for the purpose of the service.
A lawyer's record matters most on the party-versus-third-party analysis for
the model provider, which is unsettled law.

---

## 3. Are win-back messages and in-call upsells HIPAA "marketing"?

**The rule.** "Marketing" is a communication about a product or service that
encourages the recipient to buy it, and it requires the patient's written
authorisation (45 CFR 164.501, 164.508(a)(3)). Two exceptions matter here: a
face-to-face communication, and a communication about a health-related product
or service *of the covered entity itself*, made for treatment or for case
management, where the covered entity receives no payment from a third party
for making it (164.501, "marketing", paragraph (2)).

**Applied.**

- *"You're due for your next appointment"* for a treatment the patient has been
  receiving is a treatment communication, not marketing. Permitted without
  authorisation under HIPAA. (The TCPA analysis is separate; see question 4.)
- *"We now offer laser resurfacing, would you like to book?"* to a patient who
  has never had it is a communication about a service of the covered entity,
  made to encourage purchase, with no third-party payment. Under the exception
  it is **not** marketing, so no HIPAA authorisation is required, **provided**
  no third party pays the clinic to send it and the message is about the
  clinic's own services.
- *An in-call upsell* by the agent ("while you're booking, we have a
  membership") is the same analysis: the clinic's own service, no third-party
  payment, not marketing under HIPAA. The clinic must have the patient on the
  line for a reason it initiated, which an inbound call satisfies.
- *Anything paid for by a manufacturer* ("Allergan is sponsoring a Botox
  event") is marketing and needs written authorisation. The product should
  never carry such a message, and the agent script guard already refuses
  brand promotion.

**The trap is not HIPAA, it is the TCPA.** HIPAA may permit a win-back message
that the TCPA still forbids: a text or an artificial-voice call that
encourages a purchase is *telemarketing* under the TCPA regardless of the
HIPAA label, and telemarketing to a mobile needs prior express **written**
consent. The product's `outbound-consent` clause already puts that warranty on
the clinic, and reactivation stays switched off until a clinic has written
consent on file for each patient (`consent_records`,
`consent_type = 'express_written'`). That is the right posture and it should
not be loosened by the HIPAA answer.

**Recommendation.** Treat treatment reminders and own-service offers as
permitted under HIPAA without authorisation; require prior express written
consent for any of them sent by text or automated call; never carry a
third-party-funded message. Counsel's record matters least here; the analysis
is settled and the conservative posture is already built.

---

## 4. The missed-call text-back: what consent it needs, and what it must say

**The facts.** A patient calls the clinic's number, nobody answers, the agent
or the system sends a text: "Sorry we missed you, reply here or call back."
Is that lawful without anything more?

**The TCPA.** A text message is a "call" under the TCPA. Whether consent is
needed turns on how it is sent and what it says:

- Sent with an autodialer, or with an artificial or prerecorded voice, to a
  mobile number: prior express consent is required (47 U.S.C. §227(b)(1)(A)).
  The FCC's February 2024 ruling makes an AI-generated voice an "artificial
  voice". A *text* is not a voice, but nearly every bulk texting system is an
  autodialer under the FCC's current reading, and the safe assumption is that
  the product's texts are autodialed.
- **The consent exists.** A person who places a call to a business and leaves
  their number has given prior express consent to be contacted at that number
  about the subject of their call. That is the FCC's long-standing position
  (1992 Order, ¶31; reaffirmed 2015) and it is the basis on which every
  missed-call text-back product operates. The consent covers a reply *about
  why they called*, promptly, and does not cover marketing or a drip campaign.
- **Scope, therefore.** One text, sent promptly after the missed call, that
  identifies the clinic, says they were missed, and offers a way to reach a
  person or to book. Nothing promotional. No second text unless they reply.
  Their reply is a new consent for the conversation that follows; "STOP" ends
  it and is honoured across channels (`isStopRequest()` and `suppress()` in
  `apps/app/src/lib/compliance/contact-policy.ts`).
- **The healthcare exemption** (47 CFR 64.1200(a)(3)(v)) lowers the bar to
  ordinary consent for calls that deliver a healthcare message from a covered
  entity or its business associate. It helps a covered clinic; it is
  unavailable for a non-covered one (question 1). The text-back does not need
  it, because the call-back consent above is enough, but it is a second
  defence for covered clinics.
- **Quiet hours.** No text before 8am or after 9pm in the *recipient's* local
  time (47 CFR 64.1200(c)(1)); state rules are tighter (Florida 8am–8pm,
  Oklahoma, Washington 8am–8pm, Maryland). The product now fails closed when
  the recipient's timezone is unknown, which is the right default; the
  missed-call text-back should therefore be sent only when the timezone is
  known, which it is for every caller (set from the clinic's timezone at
  ingest).
- **Registration.** Texts from a 10-digit number require A2P 10DLC brand and
  campaign registration with the carriers. Until that is approved no text can
  be sent at all; the product keeps texting switched off.

**What the text must contain.** The clinic's name; that this is a reply to
their call; a way to reach a person; "Reply STOP to opt out" on the first
message; and nothing else. A sample, which is also the 10DLC campaign sample:

> Radiance Med Spa: sorry we missed your call. Reply here with what you need,
> or call us at (415) 555-0199 and a person will help. Reply STOP to opt out.

**Recommendation.** Build the text-back as a single prompt reply, gated on a
known timezone and 10DLC approval, with STOP handling, and no follow-up unless
the patient replies. Counsel's record matters on one point: the FCC's
call-back consent doctrine is the load-bearing element, and a TCPA lawyer
should confirm it against the current state of the *Facebook v. Duguid*
autodialer line before the first live send.

---

## 5. Cold-email sender identity under California §17529.5

**The rule.** California Business & Professions Code §17529.5 makes it
unlawful to send a commercial email that contains or is accompanied by
falsified, misrepresented or forged header information, or a subject line
likely to mislead. Statutory damages of $1,000 per email, strict liability, a
private right of action, and the plaintiff need not have been harmed. It
applies to email sent to or from a California address; roughly 600 of the
4,500 clinics on the prospect list are in California.

**Applied to the outreach plan.** Thirty invented personas on ten lookalike
domains is the pleaded fact pattern in the §17529.5 cases: a "from" name that
is not a real person and a domain that is not the sender's are "misrepresented
header information". CAN-SPAM pre-empts state law only for falsity that is
*not* also fraudulent, and the California courts (*Balsam v. Trancos*, 2012)
have held that a domain that does not identify the sender is exactly the kind
of header the statute reaches.

**The safe pattern**, which costs nothing in deliverability:

- Send as a real person, by their real name, with a real reply-to that a human
  reads.
- Send from domains the company owns and that identify it (a lookalike domain
  that is registered to healdesk and resolves to healdesk's site is fine; ten
  domains that pretend to be something else are not).
- Put the legal entity's name and a physical postal address in every footer
  (CAN-SPAM requires this anyway), and a working unsubscribe honoured within
  ten business days.
- No misleading subject lines ("Re:" on a first email, "your account", fake
  urgency).
- Keep the claims true: "we sign a BAA with every clinic", not "HIPAA
  compliant"; "live on web chat in minutes", not "live in 90 seconds" for
  voice.

**Recommendation.** Adopt the safe pattern; it is already the one the CAN-SPAM
footer work in the repo assumes. Counsel's record matters little; the statute
and the case are clear.

---

## 6. The public claims

**"HIPAA-compliant."** No such certification exists; HHS says it neither
endorses nor recognises private certifications. The FTC treated the badge as
a deceptive claim in *Henry Schein* (2016, $250,000). The honest sentence is
"we sign a business associate agreement with every clinic and build to the
HIPAA Security Rule", and the trust page can show what that means in practice
(the subprocessor register, US hosting, encryption, the audit log). The site
already says this; the cold-email hook must too.

**"Live in 90 seconds."** True for web chat, which can be embedded from a
snippet. Not true for voice (a Synthflow number and call forwarding take an
onboarding call) and not for WhatsApp or SMS (Meta verification and 10DLC take
weeks). A claim that is true for one channel and false for the others is a
deceptive claim under FTC Act §5 when read as the product overall. Scope it:
"web chat live today; phone and messaging set up with you in the first week."

**"Recovers X% of missed calls."** A number needs a basis. The product now
computes recovery per clinic from its own data; until there is data, the site
should say what the product does, not what percentage it achieves. Remove any
figure that is not derived from the product's own reports.

**Veterinary and massage.** Animal health records are outside HIPAA; a
confidentiality addendum replaces the BAA for a veterinary practice, and the
Meta channels can be a full booking channel there if the owner chooses B for
that segment. Chiropractors are usually covered entities (they bill insurance
electronically); massage therapists usually are not. The one onboarding
question in question 1 decides.

**Recommendation.** Keep the site's current wording; correct the outreach
copy to match; never publish a recovery percentage the product did not
measure.

---

## What this does and does not give you

Every answer above is grounded in the statute, the regulation or the case
named beside it, and the conservative posture in each is already built into
the product. What this document is not: a licensed attorney's opinion that a
regulator or a clinic's counsel would accept as evidence of reasonable
diligence. Two questions are worth buying that record for: the covered-entity
script and the state consent lines (question 1), and the third-party analysis
for the model provider under CIPA (question 2). A short, scoped engagement on
those two, with this document as the brief, is the cheapest credible thing to
do first.
