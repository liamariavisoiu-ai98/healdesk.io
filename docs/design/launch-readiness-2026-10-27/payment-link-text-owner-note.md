# Turning on the payment-link text: what is needed (28 October 2026)

For the owner. Plain words.

## Where it stands today

- Each clinic can save the choice "text the payment link after a call". It is off by default. The switch works once the clinic has bought phone and connected Stripe.
- Nothing sends a text. No sender is chosen, and the code that decides whether the assistant may offer a text (`paymentLinkTextOffered()` in `apps/app/src/lib/portal/switch-resets.ts`) always says no. So turning the switch on changes nothing a caller hears.
- The launch register has an item for it, `payment-link-text`, marked Being built and blocking go-live. Operators can also see and set the switch for a clinic from the clinic's Setup page in /admin.

## What your decision of 28 October 2026 settles

- The sender does not need a business associate agreement. It is handled by scoping, like Meta and Stripe: the text is fixed words plus the clinic's own checkout link, and nothing else. No treatment, time or amount in the words.
- Registration with the phone carriers is still needed for each clinic that turns the text on, and takes one to four weeks. A clinic that never turns it on registers nothing.

## What is left, in order

1. **You choose a sender.** A company that sends texts for us. This is the one thing only you can do. Nothing is chosen yet.
2. **Per-clinic registration.** Decide how each clinic is registered with the carriers (whose tax ID, who files, who pays) and how the portal knows a clinic is registered. The switch should only be usable for a registered clinic.
3. **Build the sending** in the tool layer (Claude Code). Fixed words and the clinic's own checkout link only. Only after the caller says yes and reads the number back. Once, to that number, for that call. If it fails, the booking stands and staff are told about the deposit. Then `paymentLinkTextOffered()` can say yes, but only when the sender is ready, the clinic's switch is on and the clinic is registered.
4. **Legal wording.** Terms, Privacy and "How AYA is built to behave" still say AYA sends no texts. They must change before the first text goes. The exact sentences and what has to change with them are in `legal-wording-proposal-payment-text.md` for you to approve.
5. **Test it** on a real call with a test clinic, from yes on the call to the text arriving, and the failure case.
6. **Flip the register item** `payment-link-text` to On in the same commit that makes production send the text, and record the sender in `docs/hipaa-compliance.md`, `/admin/map` and the spec's vendor table.

## Not part of this

Support requests by email that become actions (lane D) are not built yet.
