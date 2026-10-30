# Sending the payment-link text: route and build scope (30 October 2026)

For the owner, then for the builder. Scope only: nothing here is built, chosen or turned on. It follows the owner's rulings of 28 October 2026 (the text is optional, off by default, fixed words plus the clinic's own checkout link; the sender signs no BAA, handled by scoping) and does not reopen them.

## What is settled and what the code does today

- The clinic's switch (`text_payment_link`) is saved and locked by `switch-rules.ts`. `paymentLinkTextOffered()` in `apps/app/src/lib/portal/switch-resets.ts` always returns false, so the assistant never offers a text. The launch register item `payment-link-text` blocks go-live.
- The checkout link already exists for chat: `createDepositLink` (`lib/billing/deposit-link.ts`) makes the clinic's own Stripe link and `depositLinkText` holds the fixed words. Voice never calls it today.
- The spec says healdesk provides no texting numbers to clients and that a toll-free number is for healdesk's own operations. So the texts cannot come from a number healdesk offers as a product. That line has to change, or the route has to avoid it (decision 3 below).

## What is verified, and what is not

Verified (AWS HIPAA eligible services page, "Last Updated: October 15, 2026"):

- "Amazon Pinpoint and End User Messaging (formerly Amazon Pinpoint)" is listed as HIPAA eligible, "excluding Voice Message capabilities and WhatsApp Channel". SMS is not excluded.
- "Amazon Simple Notification Service (SNS)" is listed with no exclusion. The page does not say whether SNS's SMS sending is covered, so SNS is not a route here.
- The page repeats that PHI may be used on eligible services only under an AWS business associate agreement. healdesk's AWS agreement is already executed for the designated account (`docs/hipaa-compliance.md`).

Not verified (the AWS user-guide pages could not be read; check in the AWS console or docs before relying on any of these):

- Whether US carriers need a 10DLC brand and campaign, a toll-free verification, or a short code for this traffic, and the approval times. The spec's one to four weeks per clinic is the owner's figure, not an AWS one.
- Whether one registration by healdesk can cover many clinics, or each clinic needs its own.
- Whether AWS keeps message bodies, and for how long.
- Whether a numeric sender owned by healdesk's account may send on a clinic's behalf.

## Routes

| Route | On the BAA chain | Fits the spec's no-texting-numbers line | Notes |
| --- | --- | --- | --- |
| **A. AWS End User Messaging SMS**, healdesk's HIPAA account | Yes, SMS is on AWS's eligible list and the AWS agreement is signed, so the ruling that no sender BAA is needed is not even tested | No, unless the line is edited: the number would be one healdesk holds, registered per clinic | Recommended to evaluate first: no new vendor, no new BAA, same account and KMS, IAM permission and Terraform only. Cost and registration model unverified |
| B. Twilio-backed number | Only on Security or Enterprise Edition | No | The spec already rules Twilio numbers out for clients |
| C. The clinic's own number and account | Clinic's own agreement | Yes | healdesk cannot send from a clinic's account without a credential handover, which the portal never does ("every connection is a login button") |
| D. The clinic's payment gateway texts the link | The gateway's | Yes | Not assumed. Stripe is not known to text a Checkout link itself (unverified); do not build on this |
| E. Retell's own messaging | Retell signs a BAA, self-serve | Unknown | Not checked. Worth one question to Retell before ruling out |

Route A is chosen (see Decisions).

## Decisions (owner, 30 October 2026)

1. **Sender: AWS End User Messaging SMS.** Chosen.
2. **Registration model: the cheapest route, recommended and adopted.** One US toll-free number that healdesk registers once for itself, not a registration per clinic. Sourced from AWS's pages (read 30 October 2026):
   - Toll-free registration takes up to 15 business days, with no registration fee stated; the number leases at $2 a month; a US toll-free text costs $0.00774 plus a $0.00421 carrier fee (price table, "prices change regularly": check at purchase).
   - The form takes a non-US company: company name, address, country, and an ID number of type VAT or OTHER ("OTHER" if the type is not listed); it checks the number against official registries and accepts a registry extract for non-US businesses. It needs a privacy policy URL and terms URL for registrations from 15 September 2026, and a verbal opt-in is an accepted category with a script as evidence.
   - Compare 10DLC per clinic: a $4 brand fee each, $2 to $10 a month per campaign, $1 a month per number, a $40 optional vetting fee, each clinic's own tax ID, and a default quota of 25 brands per account.
   - **Not answered by AWS's pages:** whether one toll-free registration may send for many clinics, whether a payment-link message fits the use case categories (the closest are "Financial transactions" and "Booking confirmations"), and whether a one-off message conflicts with the opt-in confirmation rule. These are resolved only by submitting the registration. Fallback if refused: registration per clinic, 10DLC or its own toll-free number.
   - **Open wording point:** the fixed text must name its sender so a patient recognises it. Recommend "Healdesk" plus the link and the opt-out line, with the clinic shown on the checkout page, not in the text. The carrier's review may ask for the brand to match the registered business.
3. **Spec line: edited** (spec "Phone numbers", "Payment by text after a call", vendor table) to allow the one text from that one number.
4. **STOP and HELP: AWS handles them; nobody at healdesk or the clinic answers replies.** By default AWS puts a STOP number on its opt-out list and does not send to it again; the carrier answers STOP and HELP on a toll-free number and the answer cannot be changed. Our tool layer treats an opted-out number as a failed send (booking stands, staff told the deposit is pending). HELP handling for toll-free is not described in AWS's pages: check at registration.

## Build scope (Claude Code lane, about one lane of work)

Fixed tool layer only, never the model. All of it behind `paymentLinkTextOffered()`, which becomes the one place that checks sender ready, clinic registered, clinic switch on, gateway connected, and the rules in `switch-rules.ts`.

1. **Schema (apps/app, one migration):** a per-clinic sender registration row (status, opaque identity reference, no number text in logs) and a one-row-per-appointment text ledger that makes the send idempotent (unique on appointment). Statuses only; no message body kept, matching the transcript rule.
2. **Sender adapter:** `lib/sms/send.ts` calls the chosen service with the fixed words and the link. The link comes from `createDepositLink` with a new `voice` channel value; it keeps the same refusals (no treatment name, no amount in the words, expiry clamp).
3. **Voice flow:** after the booking, the assistant offers the text; the tool layer sends only after a recorded yes and the caller reading the number back (a boolean the voice endpoint sets, never inferred from prose). One text per booking. A failure leaves the booking standing and the deposit flagged for staff, and tells the caller when it can be known on the call.
4. **Opt-out and window rules:** per decision 4; a number that opted out is never texted. No resend, no reminder.
5. **Portal:** the switch keeps its dependency model and gains a registered-status reason ("Your texting registration is being set up") from `switch-rules.ts`, not from the UI.
6. **Infra (separate approval):** the task role's send permission and any Terraform for the chosen route, in `infra/aws`. Applied only on the owner's yes, as always.
7. **Paper:** the BAA 1.6.0 and DPA clauses already drafted carry the exception; the sender goes into `docs/hipaa-compliance.md`, the spec's vendor table and `/admin/map`; `LAUNCH_PROMISES` `payment-link-text` moves to On in the commit that makes production send, with a real test call as evidence.
8. **Tests:** idempotency (a retried tool call sends once), no text without the read-back, no text when the clinic is not registered, failure path flags the deposit, the words contain no treatment, time or amount.

Not in this lane: SMS as a channel, reminders, follow-ups, win-backs, or any text a caller did not just agree to.
