# Legal wording proposal: the optional payment-link text (28 October 2026)

For the owner to approve. Nothing here has been applied. Terms, Privacy, the editorial pieces and `LEGAL_VERSION` are untouched by this lane.

Why this is needed: the owner allowed one optional text after a call (28 October 2026). Terms section 8 says AYA "sends no text messages", Privacy section 8 says the website sends none and that texts would be described first, and the guide "How AYA is built to behave" says the same. While no sender exists, those sentences are still true as a description of what production does, so they can stay until the text goes live. They must change in the same commit that makes production send the first text, and the register item `payment-link-text` (`apps/web/src/lib/admin/seo/launch.ts`) moves to On in that commit. If you prefer copy first, then the switch (CLAUDE.md), apply these before sending, phrased as "designed to".

## 1. Terms, `apps/web/src/app/terms/page.tsx`

### 1a. Section 8, "Inbound only" (about line 618)

Current:
> Inbound only. The agent speaks to a person only in reply, inside a conversation that person started with your Practice: it places no calls, sends no text messages, and sends no reminders, follow-ups or marketing to patients by any channel, and if you ask for any of those we will decline.

Proposed:
> Inbound only. The agent speaks to a person only in reply, inside a conversation that person started with your Practice: it places no calls, and sends no reminders, follow-ups or marketing to patients by any channel, and if you ask for any of those we will decline. There is one optional exception, which is off unless you turn it on: after a booking by phone, if the caller says yes and reads their number back, the agent is designed to send that caller one text with your Practice's own payment link, in fixed words that name no treatment, time or amount. It is sent once, for that call, and never again.

### 1b. Section 2, phone payments (about line 342 to 345)

Current:
> By phone it cannot take a payment: it books and flags the deposit for your staff to collect.

Proposed:
> By phone it cannot take a payment in the call: it books and flags the deposit for your staff to collect, or, if you have turned on the payment-link text, offers to text the caller your Practice's payment link.

### 1c. Section 2, Meta paragraph (about line 344 and line 705)

The Meta sentences ("sends no payment link" on Instagram, Messenger and WhatsApp) stay true: the text is voice only. No change. Keep them.

### 1d. Section 8 "Your responsibilities" (new sentence, about line 618, end of the list)

Proposed new bullet:
> Payment-link texts. If you turn on the payment-link text, you agree that the text goes out under your Practice's name, and that we may register your Practice with the phone carriers for it, which can take one to four weeks. You can turn it off at any time, and it stops on the next call.

## 2. Privacy, `apps/web/src/app/privacy/page.tsx`

### 2a. Section 8, "Text messages" (about lines 572 to 578)

Current:
> This website does not send text messages, and nothing on it asks you to agree to any. The demo call in section 2 is a voice call. If we ever add texts, the programme will be described here first, with the carrier-standard terms: message frequency, "message and data rates may apply", and STOP to opt out and HELP for help. Marketing texts would need a separate, explicit opt-in.

Proposed:
> This website does not send text messages, and nothing on it asks you to agree to any. The demo call in section 2 is a voice call. If a clinic that uses healdesk turns it on, its assistant may text a caller one message after a booking call, only if the caller says yes: a fixed line and the clinic's own payment link, with no treatment, time or amount in it. It is sent once, to the number the caller read back, and is not a reminder or a follow-up. Reply STOP to opt out and HELP for help; message and data rates may apply. We send no marketing texts, and would need a separate, explicit opt-in to.

### 2b. Section on what the assistant does for a clinic's callers (Meta, about line 735)

"sends no payment link there" is about Instagram, Messenger and WhatsApp and stays true. No change.

### 2c. Vendor categories (`apps/web/src/lib/subprocessors.ts`, `PROCESSOR_CATEGORIES`, printed in Privacy section 5)

Once a sender is chosen, add one category in the simplest words, for example: "A text-message service that delivers the one optional payment-link text, which carries only fixed words and the clinic's payment link". No category is added today because no sender exists. Check `subprocessors.test.ts` and `site-copy.test.ts` for what they pin about the list.

## 3. Editorial guide, `apps/web/src/lib/content/pieces/how-aya-is-built-to-behave.ts`

### 3a. "Does AYA ever contact a patient first?" (about line 101)

Current:
> It places no calls and sends no text messages, reminders, follow-up sequences, win-back messages or review requests.

Proposed:
> It places no calls and sends no reminders, follow-up sequences, win-back messages or review requests. One optional text is the only exception: after a booking by phone, if the caller says yes, AYA is designed to send one text with the clinic's own payment link, in fixed words, once.

### 3b. Payment paragraph (about lines 156 to 160)

Current:
> On a call AYA cannot take payment, so where a service needs a deposit it is designed to book and flag the deposit for the clinic's staff to collect.

Proposed:
> On a call AYA cannot take payment, so where a service needs a deposit it is designed to book and flag the deposit for the clinic's staff to collect, or, where the clinic has turned it on, to offer to text the caller the clinic's own payment link.

"On Instagram, Messenger and WhatsApp it sends no payment link." stays.

Process note: this is a legal piece. CLAUDE.md requires an independent audit of every statement against the primary text before a legal piece goes live. Changing the text means re-running that audit, updating `lastReviewed` and the `review` sentence, and keeping `cite: ["terms"]` true after the Terms change.

## 4. What must change with the wording

Tests that quote the current sentences and fail on any change:

| File | What it pins now | Change |
| --- | --- | --- |
| `apps/web/src/app/terms/terms-copy.test.ts` line 58 | `"it places no calls, sends no text messages, and sends no reminders"` | Replace with the proposed 1a sentence start, `"it places no calls, and sends no reminders"`, and add a check for the exception sentence |
| `apps/web/src/app/terms/terms-copy.test.ts` lines 585 to 596 | Meta sentences "sends no payment link" | No change (Meta stays true); confirm still green |
| `apps/web/src/app/privacy/privacy-copy.test.ts` lines 199 to 206 | Meta "sends no payment link there" | No change; confirm still green |
| `apps/web/src/lib/legal-version.test.ts` | SHA-256 of `/terms`, `/privacy`, `/data-deletion`, in `PINNED_BEFORE_1_6_0` and `PINNED_WITH_1_6_0` | Terms and Privacy hashes both move: re-pin both blocks in the same commit. `/data-deletion` should not move |
| `apps/web/src/lib/legal.ts` | `LEGAL_VERSION` (`2026-10-27.1` or `.2`) and `LEGAL_LAST_UPDATED` | Bump to a new version and date, and set `replaces` in `legal-version.test.ts` to the version that was live |
| `apps/web/src/lib/site-copy.test.ts` | House style over every legal sentence, and the vendor list against Privacy | Run it; fix any banned word |
| `apps/web/src/lib/content/content.test.ts` | Citations, sources, house style, review age for each piece | Run it after the guide edit |
| `apps/web/src/components/checkout/funnel-copy.test.ts`, `apps/web/src/app/api/checkout/*.test.ts`, `apps/web/src/lib/checkout/order.test.ts` | Read `LEGAL_VERSION` | Update only if they pin the literal version |
| `packages/catalog/src/baa.ts` (`BAA_1_6_0_RELEASED`) | Another document with its own version | Not touched by this wording; do not release it together by accident |

Also review whether the text changes a clinic's signed terms: a clinic that already signed under the old version is on the old text, so the new version applies to clinics that sign after it, and the owner decides whether existing clinics are told.

Also in the same commit: `docs/counsel/` has nothing on texting today; the carrier rules (consent, STOP and HELP wording, registration) should be checked by a person before the first text goes, because the AI review does not replace counsel here.

## 5. Order of work when you approve

1. You choose the sender.
2. Claude Code applies sections 1 to 3, the test changes in section 4 and the new hashes in one commit.
3. The sending is built and tested (see `payment-link-text-owner-note.md`).
4. In the commit that turns the sending on, the register item `payment-link-text` moves to On.
