# Turning on the payment-link text: what is needed (30 October 2026)

For the owner. Plain words. Replaces the 28 October version.

## Where it stands today

- Each clinic can save the choice "text the payment link after a call". It is off by default. The switch works once the clinic has bought phone and connected Stripe.
- Nothing sends a text. No texting provider is chosen, and the code that decides whether the assistant may offer a text (`paymentLinkTextOffered()` in `apps/app/src/lib/portal/switch-resets.ts`) always says no. So turning the switch on changes nothing a caller hears.
- The Terms, Privacy and the checkout box describe the text as designed. The launch register item `payment-link-text` is Being built and does not block go-live (your decision of 28 October).

## What is decided

- **No agreement with the sender.** It is handled by scoping, like Meta and Stripe: fixed words plus the clinic's own checkout link, nothing else, no treatment, time or amount.
- **The route (30 October).** A texting-only number per clinic, registered with the carriers under the clinic's own name. It never comes from AYA's number, from a number we give a client, or from the clinic's published number. The text opens with the clinic's name. A reply gets one automatic answer with the clinic's direct line, and the provider honours STOP.
- **Only under an agreement that covers it.** No text goes to a caller of a clinic whose accepted agreement is older than the one that carries the exception. BAA 1.6.0 is released in code (it reaches clinics when `apps/app` is deployed and migration 0136 runs). DPA 1.1.0 is a draft that waits for your release.

## What is left, in order

1. **You choose a texting provider and open the account.** Only you can. It must register each clinic under its own brand with the carriers (US numbers). Ask it for current fees and its brand-registration rules before you commit; I have not verified either. Then paste its key into Parameter Store, as with the other keys.
2. **Per-clinic registration.** When a clinic switches the text on, the portal asks for the business details the carriers need, we file the registration, and the switch only works for a registered clinic. It takes one to four weeks. A clinic that never switches it on registers nothing. This is a design for Claude Code to bring to you before building.
3. **Release the agreements.** Deploy `apps/app` so BAA 1.6.0 reaches clinics, and release DPA 1.1.0 when you are ready. Clinics must accept the new versions before any text goes to their callers.
4. **Build the sending** in the tool layer (Claude Code). Fixed words and the clinic's own checkout link only, after the caller says yes and reads the number back, once, for that call, and only for a registered clinic on an agreement that covers it. If it fails, the booking stands and staff are told about the deposit. Then `paymentLinkTextOffered()` can say yes.
5. **Test it** on a real call with a test clinic, from yes on the call to the text arriving, and the failure case.
6. **Flip the register item** `payment-link-text` to On in the same commit that makes production send the text, and record the provider in `docs/hipaa-compliance.md`, `/admin/map` and the spec's vendor table. Change the other copy that says AYA sends no texts at that point only where it is no longer true.

## Not part of this

Support requests by email that become actions are built and on `main`, and they only run once the `support-draft` job is switched on. They are not live-verified.
