# Turning on the payment-link text: what is left (30 October 2026)

For the owner. Plain words. The decisions themselves are in `payment-link-text-route-scope.md`.

## Where it stands

- A clinic can see the choice "text the payment link after a call", but the switch is locked ("Texting the payment link is not available yet.") until a sender is ready. One flag, `PAYMENT_LINK_TEXT_SENDER_READY` in `apps/app/src/lib/portal/switch-rules.ts`, holds it. A 29 October session locked it so a clinic cannot "choose" an option that does nothing, which BAA 1.6.0's wording would otherwise promise.
- Nothing sends a text, and `paymentLinkTextOffered()` in `switch-resets.ts` always says no, so the assistant never offers one.
- The Terms, Privacy and the checkout box describe the text as designed. The launch register item `payment-link-text` is Being built and does not block go-live.

## Decided (owner, 28 to 30 October)

- No separate agreement with the sender; the text is scoped to fixed words and the clinic's own checkout link.
- Sender: AWS End User Messaging SMS, in healdesk's own account, one US toll-free number registered once by healdesk (the route scope has the AWS facts and what is still unverified). AWS handles STOP and HELP.
- No text goes to a caller of a clinic whose accepted agreement is older than the one that carries the exception: BAA 1.6.0 (released in code; it reaches clinics when `apps/app` is deployed and its migration runs) and DPA 1.1.0 (released by your word on 30 October).

## What is left, in order

1. **File the toll-free registration with AWS** (you, in the AWS console, for Viixi FZC). Up to 15 business days. It needs the company name, address, a registry ID, a privacy policy link and a terms link, and an opt-in script as evidence. Whether one registration may send for many clinics, and whether a payment-link message fits the use categories, is only answered by filing.
2. **Deploy `apps/app`** so BAA 1.6.0 and DPA 1.1.0 reach clinics.
3. **Build the sending** in the tool layer (Claude Code, one lane of work). Fixed words and the clinic's own checkout link only, after the caller says yes and reads the number back, once per booking, only for a clinic on an agreement that covers it. It has its own Terraform plan, which needs your approval as every infrastructure change does.
4. **Test it** on a real call with a test clinic, from yes on the call to the text arriving, and the failure case.
5. **Unlock the switch and flip the register item** `payment-link-text` to On in the same commit that makes production send the text. Record the sender in `docs/hipaa-compliance.md`, `/admin/map` and the spec's vendor table, and change the other copy that says AYA sends no texts only where it is no longer true.

## Not part of this

Support requests by email that become actions are built and on `main`, and they only run once the `support-draft` job is switched on. They are not live-verified.
