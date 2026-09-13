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

/**
 * The demo gate's collection notice and its marketing checkbox.
 *
 * Same rule as CALL_CONSENT: the words live here, the gate renders them, and
 * the server (app/api/gate/route.ts) writes its OWN copy of the label onto the
 * lead together with `CONSENT_NOTICE_VERSION`, refusing to record consent when
 * the client reports a different version. Bump the version whenever either
 * string changes, in the same commit.
 *
 * Two separate facts are collected on that form and they must never merge:
 *
 *   1. The email unlocks the demo. That is the service the visitor asked for,
 *      and the notice says what it is used for and which cookie it sets
 *      (`hd_demo`, HTTP-only, 30 days — src/lib/gate.ts). It is not consent to
 *      anything else. CAN-SPAM lets a business email a customer about the
 *      thing they asked for; it does not make a demo unlock a marketing opt-in.
 *   2. The checkbox, UNTICKED by default, is the marketing opt-in. Its exact
 *      wording is the consent record.
 */
export const CONSENT_NOTICE_VERSION = "2026-09-13.2";

/**
 * Under the email input. Links to /privacy from the component.
 *
 * Says only what is true: the email unlocks the demo and tells us who tried
 * it. Nothing emails a transcript — an earlier draft of this sentence
 * promised one, which is exactly the kind of claim a privacy notice must not
 * make on a feature's behalf.
 */
export const GATE_NOTICE =
  "Your email unlocks the demo and tells us who tried it. It sets one cookie " +
  "(hd_demo, 30 days) so you don't have to re-enter it. We don't sell it and " +
  "we don't share it with ad platforms.";

/** The marketing checkbox. Must be rendered verbatim; the server stores this string. */
export const MARKETING_CONSENT_LABEL =
  "Email me about AYA and healdesk. Unsubscribe with one click, any time.";

/** The email ask that follows the visitor's first message in the chat demo. */
export const CHAT_EMAIL_NOTE =
  "One email, no spam. We'll only send you this conversation unless you tick " +
  "the box below, and you can reply \"stop\" to never hear from us again.";
