# The first-month guarantee and the refund terms (launch step 1.10)

> **DRAFT for counsel review — not legal advice.** Written by an AI assistant
> from the repo on 1 October 2026. Nothing here is in force. The live terms
> are `apps/web/src/app/terms/page.tsx`; this file changes nothing in them.

## What the spec asks for

From `docs/v1-product-spec.md`, "The guarantee":

- The setup fee is non-refundable, because provisioning work starts at once.
- The guarantee is about something healdesk controls and can measure: calls
  and messages answered. Not revenue, not bookings.
- Shape: if the assistant does not answer every call and message routed to it
  during the first month, the first month's retainer is refunded.
- The wording, the refund window, and whether the setup fee is refundable
  before provisioning are for counsel. The text must be **identical** on the
  pricing page and in the service agreement.

## Proposed wording

One block. The same words go on `/pricing` and into the terms as a new
section (proposed: "5. Refunds and the first-month guarantee"). Square
brackets are numbers the owner must set from measured latency; they are not
legal choices.

> **Our first-month guarantee.** If, during your first month, the assistant
> fails to answer any call or message routed to it, we refund your first
> month's subscription fee.
>
> **Your first month** is the 30 days that start on the day your first
> channel goes live, as shown in your portal.
>
> **Routed to it** means: a phone call that reaches the healdesk number
> assigned to your practice; a website chat message that reaches our servers
> from the widget on your site; and an Instagram, Messenger or WhatsApp
> message that Meta delivers to us from an account you connected.
>
> **Answered** means: on a call, the assistant speaks its opening line within
> [10] seconds of the call reaching us; on a message, the assistant's first
> reply is sent within [60] seconds of the message reaching us. A fixed
> safety reply, such as the one given when someone reports an urgent symptom,
> counts as an answer.
>
> **What does not count:** calls and messages that reach us while you have
> paused the assistant or switched that channel off; while your service is
> suspended for non-payment; or after your monthly allowance has run out and
> your setting is "Stop and fall back". Calls that end within [5] seconds of
> reaching us. Calls and messages that never reach us because of your phone
> carrier, your call-forwarding settings, your website, or Meta. A call or
> message that reaches us and is not answered because our systems or one of
> our suppliers failed **does** count as missed, even if it then forwards to
> your own line.
>
> **How to claim.** Within 30 days after your first month ends, the account
> owner emails [hello@healdesk.io] from the owner's address and asks us to
> check, giving the date, time and channel of any call or message you believe
> was missed, if you have one. We check our own records and any call record
> from your phone carrier that you send us. If one call or message was
> missed, we refund your first month's subscription fee to the card you paid
> with, within 14 days of your claim, and tell you what failed.
>
> **Limits.** One refund per practice. On an annual plan, the refund is one
> month at your plan's annual per-month price. The setup fee is not
> refundable under this guarantee or otherwise. You do not have to cancel to
> claim; if you stay, the service continues as normal.

About 350 words. It is long for a pricing page. A short pricing-page line
that links to it is possible, but the spec says identical text; that is
counsel's call (open choice 9).

## Why each definition is worded this way

**"Routed to it" is measured where our system first sees the contact.**

| Channel | The event that makes it "routed" | Where the record lives |
| --- | --- | --- |
| Voice | Retell reports an inbound call on the clinic's agent (its call-started event) | Retell's call log and our conversation row. The Retell voice process is not built yet |
| Web chat | The widget API in `apps/app` receives a visitor message | Our conversation row. Not built yet |
| Instagram, Messenger, WhatsApp | Meta's webhook delivers an inbound message for a connected account | `webhook_events` in `apps/app` |

A call the clinic's carrier never forwards is not "routed". We cannot see
it, and the clinic controls forwarding. This matters most in "Overflow and
after hours" mode, where conditional forwarding is the clinic's set-up.

**"Answered" is a timed first response, not a good outcome.** The spec
promises reliability, not quality. A wrong answer is a quality complaint
handled under the existing service-complaint route
(`docs/incident-response.md`), not a guarantee claim. Counsel should confirm
that a reader would not take "answer" to mean "answer correctly" (open
choice 3).

**Our failures count against us.** The spec's failure rule says every
degradation path forwards calls to the clinic's direct line. That fallback
protects the patient. It is still a miss for the guarantee if the cause was
us or a vendor we chose (Retell, Anthropic, the host). Excluding it would
make the guarantee close to empty.

**The clinic's own choices do not count.** Pause AI, channel switches,
suspension for non-payment, and "Stop and fall back" are clinic choices or
clinic defaults. They are excluded.

**Very short calls are excluded.** Pocket dials and hang-ups before the
opening line can play would otherwise trigger a refund. The threshold must
sit below the time it takes to speak the opening line.

**Measurement must be built.** Today nothing records "routed" and "answered"
per channel. The voice endpoint, the web chat API and the v1 Meta adapter are
not built (`docs/hipaa-risk-analysis.md` §1). The portal's Home screen
should show "routed" and "answered" counts for month one, so the clinic can
see the same number we use. Do not publish the guarantee before the
counter exists.

## How it relates to the current 14-day refund

Today, `apps/web/src/lib/legal.ts`:

```ts
export const POLICY = {
  /**
   * Days after purchase within which the first period is refundable in full.
   * 0 = no refund window. The setup fee is never refundable, regardless of
   * this value (decision of 21 September 2026).
   */
  refundWindowDays: 14,
  /** Whether an annual plan cancelled mid-term is refunded pro rata. */
  annualProRataRefund: false,
```

which the terms render as §5:

> "If you cancel within 14 days of your first payment we refund the first
> period's subscription fee in full. The setup fee is not refundable. Where a
> refund is due to a Practice that is staying, it is applied as a credit to
> the next invoice; where the Practice is leaving, it is returned to the
> card."

Points of contact:

1. **Two different promises.** The 14-day window is "for any reason, if you
   cancel". The guarantee is "if we miss, whether or not you cancel". They
   can coexist.
2. **"First period" is not "first month" on an annual plan.** On an annual
   plan the 14-day window refunds a full year's fee. The guarantee as drafted
   refunds one month. Counsel should decide whether that asymmetry is
   intended.
3. **No double refund.** If both apply, the clinic gets one refund of the
   first period's fee, not two. Add: "A practice receives at most one refund
   of its first period's fee, under this section or the guarantee."
4. **Timing mismatch.** The 14 days run from first payment. The guarantee's
   month runs from first go-live. A clinic that is slow to set call
   forwarding could be past day 14 before voice is live. That is a reason to
   keep both.
5. **The setup fee.** Both say it is never refundable. The spec still lists
   "whether the setup fee is refundable before provisioning" as open.
   Provisioning is gated on the first paid invoice, so in practice the gap is
   minutes to hours. Counsel should decide whether a refund before any work
   starts is required or advisable (open choice 5).
6. **Terms §12 contradicts the guarantee as written.** It says:

   > "WE DO NOT WARRANT THAT IT WILL BE UNINTERRUPTED OR ERROR-FREE, THAT
   > THE AGENT WILL ANSWER EVERY CALL OR BOOK EVERY APPOINTMENT, OR THAT ANY
   > PARTICULAR REVENUE WILL RESULT."

   Add at the start: "Except for the first-month guarantee in section 5, …"
   and make clear the refund is the clinic's sole remedy for a miss.
7. **Terms §13 (liability exclusion) and §14 (indemnity).** The guarantee
   refund must sit outside the liability exclusion, or a court could read
   the exclusion as cancelling it. State that the guarantee refund is "not
   limited by section 13".

## Open choices counsel must settle

1. **Keep, replace or shorten the 14-day window.** Recommendation: keep it,
   add the guarantee, cap at one refund.
2. **Refund remedy.** Is the refund the sole and exclusive remedy for a
   missed call or message in month one?
3. **Meaning of "answered".** Is a timed first response defensible as the
   meaning, given the word's ordinary sense? Should the text say "picked up
   or replied to" instead?
4. **The thresholds.** [10] seconds for a call, [60] seconds for a message,
   [5] seconds for an abandoned call. The owner sets them from measured
   latency; counsel says whether they must appear in the text or can be set
   in a linked page.
5. **Setup fee before provisioning.** Refundable if no provisioning work has
   started, or never refundable?
6. **Annual plans.** One month at the annual per-month price (the draft), or
   a full refund of the annual fee, or no guarantee on annual?
7. **Claim-based or automatic.** The draft is claim-based. An automatic
   refund, triggered by our own counter, is fairer and harder to dispute. It
   also removes the "you didn't claim in time" argument.
8. **Whose records decide.** The draft says our records plus the clinic's
   carrier record. What if they disagree? Suggest: a forwarded call shown on
   the carrier's record, with no matching record on our side, counts as
   missed.
9. **Identical text, or a short pricing-page summary that links to the
   agreement.** The spec says identical. A 350-word block on a pricing page
   is long.
10. **Does a refunded clinic stay a customer?** The draft says yes. The
    current §5 credits a staying clinic instead of refunding to card. Pick
    one for the guarantee.
11. **Vendor failures and force majeure.** The draft counts our vendors'
    failures as ours. Terms §19 excuses delay "caused by events beyond its
    reasonable control". Does §19 apply to the guarantee? Recommendation: no,
    or the guarantee says little.
12. **Advertising rule.** The guarantee is advertised on `/pricing`. Under
    FTC Act §5, the material conditions must be clear where it is
    advertised, not only in the agreement. Counsel to confirm the block above
    is enough.

## What changes in code once counsel decides (for the engineer, not counsel)

- `apps/web/src/lib/legal.ts`: `POLICY.refundWindowDays`, and probably a new
  `POLICY` field for the guarantee thresholds; bump `LEGAL_VERSION` and
  `LEGAL_LAST_UPDATED`.
- `apps/web/src/app/terms/page.tsx` §5, §12 and §13; the pricing page. Both
  should render the guarantee from one shared string, so they cannot drift.
- A routed/answered counter per channel in `apps/app`, shown on the portal's
  Home screen.
