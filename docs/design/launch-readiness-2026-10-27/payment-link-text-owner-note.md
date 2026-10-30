# Turning on the payment-link text: what is needed (30 October 2026)

For the owner. Plain words. Replaces the 28 October version.

## Where it stands today

- Each clinic can save the choice "text the payment link after a call". It is off by default. The switch is locked ("Texting the payment link is not available yet.") until a sender is ready; `PAYMENT_LINK_TEXT_SENDER_READY` in `switch-rules.ts` is the one flag. A 29 October session locked it so a clinic cannot "choose" an option that does nothing, which BAA 1.6.0's wording would otherwise promise; you had earlier asked for it to be usable with conditions, so say if you want that back.
- Nothing sends a text. No texting provider is chosen, and the code that decides whether the assistant may offer a text (`paymentLinkTextOffered()` in `apps/app/src/lib/portal/switch-resets.ts`) always says no. So turning the switch on changes nothing a caller hears.
- The Terms, Privacy and the checkout box describe the text as designed. The launch register item `payment-link-text` is Being built and does not block go-live (your decision of 28 October).

## What is decided

- **No agreement with the sender.** It is handled by scoping, like Meta and Stripe: fixed words plus the clinic's own checkout link, nothing else, no treatment, time or amount.
- **The route (the lead's choice, 30 October, as you asked).** AWS End User Messaging SMS, in healdesk's own AWS account. AWS lists it as HIPAA eligible and your AWS agreement already covers it, so no new vendor and nothing new to sign. It sends from a number held in that account for this one purpose, never AYA's number, a number given to a clinic, or the clinic's published number. The text opens with the clinic's name. Who answers an inbound STOP or HELP is still to decide. This replaces the earlier idea of a separate texting provider; the facts are in `payment-link-text-route-scope.md`.
- **Only under an agreement that covers it.** No text goes to a caller of a clinic whose accepted agreement is older than the one that carries the exception. BAA 1.6.0 is released in code (it reaches clinics when `apps/app` is deployed and migration 0136 runs). DPA 1.1.0 is a draft that waits for your release.

## What is left, in order

1. **Check what carriers need, in the AWS console (you, or Claude with your AWS access).** AWS End User Messaging SMS in `us-east-1`: which registration US carriers need for this traffic (a 10DLC brand and campaign, or a toll-free verification), who files and under which legal entity (healdesk is Viixi FZC in the UAE: confirm AWS and the carriers accept it), whether one registration can serve every clinic, and what AWS keeps of a message. I have not verified any of this. Your own figure of one to four weeks may turn out to be once, not per clinic.
2. **Opt-out.** Decide who handles an inbound STOP, since the product is otherwise inbound-only: AWS may be able to answer STOP and HELP itself (not verified).
3. **Release the agreements.** Deploy `apps/app` so BAA 1.6.0 reaches clinics, and release DPA 1.1.0 when you are ready. Clinics must accept the new versions before any text goes to their callers.
4. **Build the sending** in the tool layer (one lane of work, with its own Terraform plan that needs your approval, as every infrastructure change does) (Claude Code). Fixed words and the clinic's own checkout link only, after the caller says yes and reads the number back, once, for that call, and only for a registered clinic on an agreement that covers it. If it fails, the booking stands and staff are told about the deposit. Then `paymentLinkTextOffered()` can say yes.
5. **Test it** on a real call with a test clinic, from yes on the call to the text arriving, and the failure case.
6. **Flip the register item** `payment-link-text` to On in the same commit that makes production send the text, and record the provider in `docs/hipaa-compliance.md`, `/admin/map` and the spec's vendor table. Change the other copy that says AYA sends no texts at that point only where it is no longer true.

## Not part of this

Support requests by email that become actions are built and on `main`, and they only run once the `support-draft` job is switched on. They are not live-verified.
