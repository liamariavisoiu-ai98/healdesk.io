# The first-month guarantee and the refund terms (launch step 1.10)

> **Adopted by the owner on 1 October 2026 without external counsel review.
> Residual risks are listed in the Review log. Not legal advice.**
>
> The live wording is `GUARANTEE_TEXT` in `apps/web/src/lib/legal.ts`,
> rendered into terms § 5 and, once built, the pricing page. This file records
> what was decided, why, and the tightened text the constant should carry
> (see "Changes against the shipped constant").

## Decisions taken

| # | Point | Decision | Basis |
| --- | --- | --- | --- |
| 1 | 14-day refund | Kept, beside the guarantee. At most one refund of the first period's fee under either | The two promise different things: "cancel for any reason" versus "we missed". Keeping both costs one refund at most |
| 2 | Remedy | The refund is the sole remedy for a call or message missed in month one | Without it a missed call invites a lost-patient damages claim on top of the refund. The sentence is limited to the miss itself and does not touch BAA rights (finding G10) |
| 3 | Meaning of "answered" | A defined term: opening line started within 10 seconds on a call, first reply sent within 60 seconds on a message | A plain-English reader could take "answer" to mean "answer correctly". A definition that sits in the advertised block controls over the ordinary sense, and quality complaints stay on the service-complaint route |
| 4 | Thresholds | 10 s call, 60 s message, 5 s abandoned call. In the text, not on a linked page | FTC guidance wants material conditions where the claim is made (16 CFR 239.3(b)). The owner set the numbers ahead of measured latency; revisit once the counter exists |
| 5 | Setup fee | Not part of the guarantee. Non-refundable under terms § 3, with one exception decided in this review (owner to confirm): refunded if no channel has gone live within 30 days of payment for a reason on our side | A flat "never refundable" for a service never delivered is the kind of term the FTC Act § 5 and a card network dispute both reach, and it reads worse than silence. Provisioning starts on `invoice.paid`, so the exception should never fire |
| 6 | Annual plans | One month at the annual per-month price (annual fee ÷ 12) | The 14-day window refunds the whole purchase because it is a cooling-off right; the guarantee is a service-level promise priced at one month on every plan. Both are stated in § 4 and § 5 so the asymmetry is disclosed, not discovered |
| 7 | Claim-based or automatic | Claim-based, 30 days after the first month, by the account owner. Added in this review: we tell the owner within 7 days when our own records show a miss, and we give our finding within 10 business days of a claim | A claim-based refund where only we can see the counter, and no duty to speak, is an unfair-practice argument waiting to be made. The notice closes it at no cost |
| 8 | Whose records decide | Ours plus any record the clinic sends. A carrier record showing the forward, or an inbox showing no reply, counts as a miss unless our records show it answered or show it never left the carrier or Meta | Resolves conflicts in the clinic's favour by default. The only way we can refuse is with our own evidence |
| 9 | Identical text, or a summary with a link | Identical block, in full, rendered from one constant on both pages; nothing collapsed | The spec requires identical text. 16 CFR 239.3(b) wants conditions "with such clarity and prominence as will be noticed and understood by prospective purchasers" |
| 10 | Staying clinic: refund or credit | Refund to the payment method used, whether or not the clinic stays | A promise to "refund" that is paid as a credit is a different thing from the one advertised. Non-guarantee refunds to a staying clinic remain credits under § 5 |
| 11 | Vendor failures and force majeure | Our suppliers' failures are ours; terms § 19 does not apply to the guarantee | The guarantee is about reliability we control by choosing vendors. Excusing vendor outages would empty it |
| 12 | Advertising | Covered below under "Advertising the guarantee" | FTC Act § 5; 16 CFR Part 239 |

**Superseded on 6 October 2026: decision 5, and where the first month starts.** The owner
decided that the setup fee is never refunded and that an account with no channel live at the
end of the 30th day after payment is closed (`docs/v1-product-spec.md`, "Stage 1, payment" and
"The guarantee"). Terms 2026-10-06.5 drop the exception and say so in § 3 and § 5. The risk
decision 5 names, a flat "never refundable" reached by FTC Act § 5 or a card dispute, still
stands and is on counsel's list. Billing now starts on the plan start, the day the assistant
first answers a patient, so the guarantee's first month, the 14-day refund window and renewal
all run from that day: the first month's fee is charged on it.

## The adopted text

One block. The same words go on `/pricing` and into terms § 5. Numbers in
the block are `POLICY` constants in `legal.ts` (10, 60, 5, 30, 14, and the
7-day and 10-business-day figures added here).

> **Our first-month guarantee.** If, during your first month, the assistant
> fails to answer a call or message routed to it, we refund your first
> month's subscription fee. The setup fee is not part of this guarantee.
>
> **Your first month** is the 30 days that start on the day your first
> channel goes live, as shown in your portal. A channel that goes live later
> is covered from the day it goes live until the end of those 30 days. A
> channel that goes live after your first month ends is not covered.
>
> **Routed to it** means: a phone call your carrier forwards to the healdesk
> number assigned to your practice, from the moment your carrier's record or
> ours shows the forward; a message a visitor sends from the healdesk widget
> on your website; and an Instagram, Messenger or WhatsApp message sent to an
> account you connected while that channel was switched on. A call or
> message that was routed to us and that our systems or our suppliers failed
> to receive still counts as routed.
>
> **Answered** means: on a call, the assistant starts its opening line within
> 10 seconds of the call reaching us and the call is not later cut off by
> our systems or our suppliers; on a message, the assistant's first reply is
> sent within 60 seconds of the message reaching us. A fixed safety reply,
> such as the one given when someone reports an urgent symptom, counts as an
> answer. A fixed line sent only because our systems or our suppliers had
> failed does not.
>
> **What does not count:** calls and messages that reach us while you have
> paused the assistant or switched that channel off, while your service is
> suspended for non-payment, or after your monthly allowance has run out and
> your setting is "Stop and fall back"; calls the caller ends within 5
> seconds of reaching us; and calls and messages that never reach us because
> of your phone carrier, your call-forwarding settings, your website, the
> visitor's connection, or Meta. A call the caller ends after 5 seconds and
> before the opening line has started does count as missed. A call or
> message that reaches us and is not answered because our systems or one of
> our suppliers failed counts as missed whatever the cause of that failure,
> even if the call then forwards to your own line; an event outside our
> control does not excuse it. Our suppliers are the companies we choose to
> run the service: telephony and speech, the language model, and hosting.
> Your carrier, Google and Meta are not our suppliers.
>
> **How to claim.** Within 30 days after your first month ends, the account
> owner emails hello@healdesk.io from the owner's address and asks us to
> check, giving the date, time and channel of any call or message you
> believe was missed, if you have one. We check our own records and any
> record you send us: a call record from your phone carrier, or a screenshot
> of an unanswered message in your Instagram, Messenger or WhatsApp inbox. A
> call your carrier's record shows forwarded to your healdesk number, or a
> message your inbox shows with no reply from us within the time above,
> counts as missed unless our records show it was answered, or show that it
> never left your carrier or Meta. We tell you our finding within 10
> business days of your claim. If one call or message was missed, we refund
> your first month's subscription fee to the payment method you paid with,
> within 14 days of that finding, and tell you what failed. If our own
> records show a miss, we tell the account owner by email within 7 days of
> recording it, whether or not you have claimed.
>
> **Limits.** One refund per practice, meaning one account, however many
> locations or channels it has. On an annual plan, the refund is one month at
> your plan's annual per-month price, meaning the annual fee divided by
> twelve. You do not have to cancel to claim; if you stay, the service
> continues as normal. This refund is your only remedy for a call or message
> missed during your first month. It does not limit your rights under the
> Business Associate Agreement, or for anything other than the missed call
> or message itself.

Outside the block, the terms keep two sentences (already in § 5 as shipped):
"A Practice receives at most one refund of its first period's fee, whether
under the paragraph above or under the guarantee; the two do not stack. The
guarantee refund is not limited by section 13, and section 19 does not apply
to it." Section 12 opens "Except for the first-month guarantee in section
5"; section 13 says the refund is not limited by it; section 19 excludes it
from force majeure. All three are in the shipped terms.

### Changes against the shipped constant

`GUARANTEE_TEXT` as committed on 1 October 2026 is the earlier draft. The
engineer should carry these changes into it, each tied to a finding below:

1. First paragraph: "any call or message" → "a call or message"; add "The
   setup fee is not part of this guarantee." (G9, G15)
2. "Your first month": add the two sentences on channels that go live later.
   (G6)
3. "Routed to it": the carrier-record moment for calls; "sends from the
   healdesk widget" instead of "reaches our servers"; "while that channel was
   switched on"; the final sentence on messages we failed to receive. (G1,
   G2)
4. "Answered": "starts its opening line" and "not later cut off by our
   systems or our suppliers"; the sentence excluding failure fallback lines.
   (G3, G5)
5. "What does not count": "calls the caller ends within 5 seconds"; the
   sentence counting a hang-up after 5 seconds with no opening line; "the
   visitor's connection"; "whatever the cause of that failure"; the
   definition of "our suppliers". (G4, G13)
6. "How to claim": the inbox screenshot; the evidence rule; the 10-business-
   day finding; "payment method you paid with"; the 7-day notice of a
   recorded miss. (G7, G8, G12)
7. "Limits": define practice and annual per-month price; delete "or
   otherwise" after "The setup fee is not refundable"; add the sentence
   limiting the sole-remedy clause. (G9, G10, G11)
8. Terms § 3: add the one setup-fee exception (decision 5), if the owner
   confirms it.

## Why each definition is worded this way

**"Routed to it" is measured at the hand-off into our side.** For voice,
that is the carrier's forward to the healdesk number. Once the carrier has
handed the call off, everything after it is us or a supplier we chose, so a
carrier record of the forward with no record on our side is our miss, not
the clinic's problem. A call the carrier never forwards is not routed: we
cannot see it and the clinic controls forwarding. This matters most in
"Overflow and after hours" mode, where conditional forwarding is the
clinic's own set-up.

| Channel | The event that makes it "routed" | Our record | The clinic's record |
| --- | --- | --- | --- |
| Voice | The carrier forwards the call to the clinic's healdesk number | The voice vendor's call log and our conversation row (the voice process is not built yet) | The carrier's call detail record |
| Web chat | The visitor presses send in the widget on the clinic's site | The widget API's request log and conversation row (not built yet) | None, by the nature of the channel; the clinic's report is enough to make us check our outage record |
| Instagram, Messenger, WhatsApp | A message is sent to a connected account while the channel is on | `webhook_events` in `apps/app`, and our endpoint's availability log | A screenshot of the inbox showing the message and no reply |

**"Answered" is a timed first response that holds.** The spec promises
reliability, not quality. A wrong answer is a service complaint
(`docs/incident-response.md`), not a guarantee claim. Two additions close
the gaps a timed definition alone leaves: a call we pick up and then drop
because our systems or our suppliers failed is a miss (the voice vendor's
call-end reason makes this measurable), and a fallback line we send only
because we had failed is not an answer. A fixed safety reply still is: it is
the product working as designed.

**Our failures count against us, including our suppliers'.** The fallback
to the clinic's direct line protects the patient; it does not turn a miss
into an answer. "Our suppliers" is defined so that nobody can argue the
clinic's carrier, Meta or Google into the exclusion or out of it.

**The clinic's own choices do not count.** Pause AI, channel switches,
suspension for non-payment and "Stop and fall back" are clinic choices or
clinic defaults and are excluded. The clinic cannot pause, let a call fall
through, and claim.

**Very short calls are excluded, but only when the caller ends them.** A
pocket dial that ends in 3 seconds is not a miss. A caller who waits 8
seconds in silence and hangs up before the opening line is a miss, even
though the 10-second clock never ran out. Without that sentence the two
thresholds left a gap in our favour.

**Later channels.** The first month runs from the first channel's go-live.
A channel connected on day 20 is covered for its last 10 days; a channel
connected after day 30 is not covered. This is the clinic-adverse reading,
so it is stated rather than left to argument. The alternative, 30 days per
channel, was rejected because it leaves the refund open-ended on a plan the
clinic may connect a channel to months later.

**Measurement must be built.** Today nothing records "routed" and
"answered" per channel. The voice endpoint, the web chat API and the v1 Meta
adapter are not built (`docs/hipaa-risk-analysis.md` § 1). The portal's Home
screen should show routed and answered counts for month one, so the clinic
sees the same number we use. Do not publish the guarantee on `/pricing`
before the counter exists; the terms may carry it earlier only if the
owner accepts that a claim would be checked by hand from vendor logs.

## How it sits with the 14-day refund and the rest of the terms

`apps/web/src/lib/legal.ts` `POLICY.refundWindowDays` is 14 and
`annualProRataRefund` is false. Terms § 5 renders the window, then the
guarantee block, then the two sentences quoted above.

1. **Two different promises.** The 14-day window is "for any reason, if you
   cancel". The guarantee is "if we miss, whether or not you cancel". A
   practice gets at most one refund of its first period's fee under either.
2. **Annual plans.** Day 1 to 14: full refund on cancellation. After that:
   no pro-rata refund, and the guarantee pays one month. Both facts sit in
   § 4 and § 5.
3. **Timing.** The 14 days run from first payment; the guarantee's month runs
   from first go-live. A clinic slow to set call forwarding can be past day
   14 before voice is live. That is why both exist.
4. **Section 12** disclaims "that the agent will answer every call" except
   for the guarantee. **Section 13** excludes liability but not the refund.
   **Section 19** excuses delay beyond a party's control except payment and
   the guarantee. All three carve-outs are in the shipped text.
5. **The setup fee** is governed by § 3, not by the guarantee block, which
   only says the fee is not part of the guarantee (decision 5).

## Advertising the guarantee

The guarantee is an advertised claim as well as a contract term, so the
FTC Act § 5 (15 U.S.C. § 45; unfair or deceptive acts or practices, which
reach business customers as well as consumers) and the FTC's Guides for the
Advertising of Warranties and Guarantees, 16 CFR Part 239, apply to how it
appears on `/pricing`. Rules adopted:

1. **Identical text, in full, where the claim is made.** 16 CFR 239.3(b):
   material limitations or conditions must be disclosed "with such clarity
   and prominence as will be noticed and understood by prospective
   purchasers". The block is rendered in full under the plan table, never
   behind a link or a collapsed panel. A headline above it may only repeat
   the block's first sentence.
2. **Never call it a "money-back guarantee".** 16 CFR 239.3(a) reserves that
   phrase for a refund of the full purchase price at the purchaser's request.
   Ours excludes the setup fee and turns on a measured miss. "First-month
   guarantee" with the setup-fee sentence in the first paragraph is the
   honest name.
3. **No marketing line may be broader than the block.** "Answers every call,
   message and DM, day or night" is a performance claim; the guarantee is its
   substantiation, so the headline figures (10 s, 60 s, the exclusions) must
   not be contradicted by copy elsewhere on the site.
4. **The refund must be a refund.** Paid to the original payment method,
   never a credit (decision 10).
5. **We must not sit on what only we can see.** The 7-day notice of a
   recorded miss (decision 7) is what keeps "claim within 30 days" from being
   a trap.
6. **Magnuson-Moss does not apply** (services sold to businesses, not
   consumer products), so 16 CFR 239.2's pre-sale availability rule is not
   engaged. State unfair-trade-practice statutes that protect business
   plaintiffs (for example California's Unfair Competition Law) follow the
   same clear-and-conspicuous logic.

Sources: 16 CFR 239.1 and 239.3,
https://www.law.cornell.edu/cfr/text/16/239.1 and
https://www.law.cornell.edu/cfr/text/16/239.3 (read 1 Oct 2026); FTC Act § 5,
https://www.law.cornell.edu/uscode/text/15/45 (statute text not re-read this
session).

## What changes in code (for the engineer)

- `apps/web/src/lib/legal.ts`: carry the eight changes above into
  `GUARANTEE_TEXT`; add `guaranteeFindingBusinessDays: 10` and
  `guaranteeMissNoticeDays: 7`; bump `LEGAL_VERSION` and
  `LEGAL_LAST_UPDATED`. `apps/web/src/app/terms/terms-copy.test.ts` asserts
  the current strings and must change with them.
- `/pricing`: render `GUARANTEE_TEXT` in full under the plan table. Until it
  does, the page must not mention the guarantee at all.
- `apps/app`: a routed/answered counter per channel, shown on the portal's
  Home screen; a "miss recorded" email to the account owner (channel, date
  and time only, so it stays `phiClass: "none"`); the finding and refund
  clocks tracked where the ops console can see them.
- **The claim inbox is on the no-PHI side.** A carrier call-detail record
  lists patients' numbers. The claim instructions, and the acknowledgement
  we send, must tell the clinic to send dates and times only, or to black
  out all but the last four digits of any number on a carrier record, and
  never to send a transcript or a patient's name. If a record with numbers
  arrives at hello@healdesk.io, treat it under `docs/incident-response.md`
  (a PHI inflow to a non-PHI channel), delete it from the mailbox, and ask
  for a redacted copy.

## Review log (2026-10-01)

Adversarial pass on the draft block of 1 October 2026 and on `GUARANTEE_TEXT`
as shipped the same day. Finding → fix applied.

- **G1. Web chat "reaches our servers" let our own outage escape.** A visitor
  whose message never arrived because our API was down had not sent a message
  "that reaches our servers", so it was not routed. → Routed now means "sends
  from the healdesk widget"; a message we failed to receive still counts as
  routed; the visitor's connection and the clinic's website stay excluded.
- **G2. "Reaches the healdesk number" had no moment and no conflict rule.** A
  carrier record of the forward with nothing on our side could be argued
  either way. → The forward shown on the carrier's record or ours is the
  moment; a carrier-record call with no record of ours is a miss unless we
  show it never left the carrier.
- **G3. A call answered and then dropped by us was "answered".** → "Not later
  cut off by our systems or our suppliers" added; measurable from the voice
  vendor's call-end reason.
- **G4. The 5-second exclusion and the 10-second threshold left a gap.** A
  caller who hung up at 8 seconds of silence was neither excluded nor a
  miss. → Hang-up after 5 seconds with no opening line counts as missed; the
  exclusion applies only to calls the caller ends.
- **G5. "A fixed safety reply counts" could cover an error fallback line.**
  → A fixed line sent only because we had failed is not an answer.
- **G6. "Your first month" was silent on channels that go live later.** →
  Covered from go-live to the end of the 30 days; after that, not covered.
- **G7. Claim-based with asymmetric knowledge, and no deadline for our
  decision.** We could see a miss, say nothing, and let the 30 days run. →
  7-day notice of any recorded miss; finding within 10 business days.
- **G8. "To the card you paid with" excluded other payment methods.** → "The
  payment method you paid with."
- **G9. "The setup fee is not refundable under this guarantee or otherwise"
  was flatly non-refundable even if nothing was ever delivered**, and
  duplicated § 3. → The block says only that the fee is not part of the
  guarantee; § 3 keeps the rule with one exception (decision 5; owner to
  confirm). Worse-than-silence risk removed.
- **G10. "Only remedy" could be read to reach the BAA.** → Limited to the
  missed call or message itself; BAA rights untouched.
- **G11. "Practice" and "annual per-month price" undefined.** → Defined.
- **G12. No evidence rule for Meta messages.** → Inbox screenshot with no
  reply counts, subject to our records.
- **G13. "Our suppliers" undefined**, so the carrier, Google or Meta could be
  argued in or out. → Defined as the vendors we choose: telephony and
  speech, the language model, hosting.
- **G14. `/pricing` carries no guarantee block today** although the spec
  requires identical text and the FTC wants conditions where the claim is
  made. → Rule: nothing about the guarantee on `/pricing` until the block
  renders there from the constant.
- **G15. A "money-back guarantee" headline would be deceptive** under 16 CFR
  239.3(a) because the setup fee is excluded. → The name stays "first-month
  guarantee"; the setup-fee sentence sits in the first paragraph.
- **G16. The annual-plan asymmetry** (full refund inside 14 days, one month
  under the guarantee) → kept per the owner's decision; disclosed in § 4 and
  § 5 so it cannot be called hidden.
- **G17. "Answered" versus its ordinary meaning** → kept as a defined term;
  the definition is in the advertised block (decision 3).
- **G18. Force majeure** → § 19 carve-out confirmed present in the shipped
  terms; the block's "an event outside our control does not excuse it" kept.
- **G19. Refund timing ran from the claim, not from a finding**, so a
  disputed claim could put us in breach of the 14 days while still
  investigating. → 10 business days to a finding, 14 days from the finding
  to the refund.
- **G20. Carrier records sent to hello@healdesk.io carry patients' numbers
  into the no-PHI side.** → Redaction instruction in the claim process; an
  unredacted arrival is handled as an incident.
- **Residual risks.** (a) The thresholds were set before latency was
  measured; if the opening line regularly starts later than 10 seconds the
  guarantee pays on every clinic. Trigger: the first week of measured
  voice latency. (b) The guarantee is advertised before the counter exists
  only if the owner accepts hand-checking claims from vendor logs. (c) A
  state unfair-trade-practice claim by a clinic is still possible if site
  copy outruns the block; the rule in "Advertising the guarantee" item 3 is
  the control, and nobody checks copy against it automatically yet.
