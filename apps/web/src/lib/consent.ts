/**
 * The consent text for the "have AYA call me" request, and why it is a module.
 *
 * ## Why this string is shared rather than typed into the component
 *
 * The thing that makes a consent record worth anything is being able to show,
 * later, the exact words someone agreed to. If the checkbox label lives in the
 * component and the server logs "consented: true", the record proves nothing,
 * the label could have changed a dozen deploys ago and nothing would tie the
 * old agreement to the old words. So the text lives here, the checkbox renders
 * it, the server writes `CALL_CONSENT.version` next to the number, and the two
 * cannot drift.
 *
 * Bump `version` whenever `text` changes, in the same commit.
 *
 * ## Why the wording is what it is
 *
 * This is an outbound call, placed by an AI voice, to a number a stranger typed
 * into a marketing site. In the US that is squarely TCPA territory, and the FCC
 * confirmed in February 2024 that AI-generated voices count as "artificial"
 * under the statute, so the call needs prior express written consent, not an
 * implied one, and statutory damages run $500–$1,500 per call.
 *
 * Four things that follow, none of which are decoration:
 *
 * 1. The checkbox is UNCHECKED by default and separate from the submit button.
 *    Pre-ticked or bundled-into-submit consent is not "express".
 * 2. It says the caller is automated and AI. Consent to "a call" is not consent
 *    to a robocall.
 * 3. It says consent is not a condition of purchase, required by the FCC's
 *    telemarketing rule, and true here.
 * 4. It says how to stop. A revocation route has to exist and has to be honored.
 *
 * The number is used for this one call and nothing else, which is also what the
 * text says. Widening that use later means new words and a new version.
 */

export const CALL_CONSENT = {
  version: "2026-09-09.1",
  text:
    "I agree that healdesk may place one automated demo call to this number " +
    "using an AI voice. Consent isn't a condition of purchase, call and data " +
    "rates may apply, and I can end the call or say \"stop\" at any time.",
  /** Shown under the checkbox, smaller. Not part of the agreement itself. */
  note:
    "We use this number for the demo call only. We don't sell it, we don't " +
    "add it to a marketing list, and we delete it on request.",
} as const;

/** The email ask that follows the visitor's first message in the chat demo. */
export const CHAT_EMAIL_NOTE =
  "One email, no spam. We'll only follow up about healdesk, and you can " +
  "reply \"stop\" to never hear from us again.";
