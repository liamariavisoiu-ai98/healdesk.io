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
 *
 * ## Shorter since 12 October 2026
 *
 * The owner asked for words that read as an offer rather than a warning: the
 * 2026-09-09.1 text ran to three clauses of legal register plus a paragraph
 * on the number, beside a "Call me" button. The four things above are all
 * still in it, in plain words: healdesk, this number, once, automated, an AI
 * voice (1 and 2 are the box itself); "not required to buy anything" (3);
 * "I can hang up anytime" (4, and with a single call, hanging up is the whole
 * of stopping it). "Call and data rates may apply" went: it is the CTIA's
 * line for text-message programmes, not one of the FCC rule's disclosures
 * for a call. "We delete it on
 * request" went from the note: the consent record is kept for the period a
 * call could be disputed (the privacy page says how long), so the promise
 * was the policy's to make, in full, not the note's in part.
 */

export const CALL_CONSENT = {
  version: "2026-10-12.1",
  text:
    "Yes, healdesk may call this number once for an automated demo with AYA, " +
    "its AI voice. Not required to buy anything, and I can hang up anytime.",
  /** Shown after it, beside the link to the privacy policy. Not part of the agreement itself. */
  note: "Used only for this call, never sold or added to a list.",
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
 *      (`hd_demo`, HTTP-only, DEMO_ACCESS_DAYS — src/lib/gate.ts). It is not
 *      consent to
 *      anything else. CAN-SPAM lets a business email a customer about the
 *      thing they asked for; it does not make a demo unlock a marketing opt-in.
 *   2. The checkbox, UNTICKED by default, is the marketing opt-in. Its exact
 *      wording is the consent record.
 */
export const CONSENT_NOTICE_VERSION = "2026-09-29.1";

/**
 * How long an unlocked demo stays unlocked, in days.
 *
 * The owner's decision, recorded in docs/handover.md ("Demo expiry — 7
 * days"). The gate cookie's lifetime (lib/gate.ts), the privacy policy, the
 * notice under the email field and the /why-wait copy all read this one
 * constant, because until 29 September 2026 the cookie said 30, the policy
 * said 30 and the decision said 7, and a page nearly shipped promising a
 * week the cookie did not keep. It lives here rather than in gate.ts so that
 * client components can import it without pulling node:crypto into the
 * bundle.
 */
export const DEMO_ACCESS_DAYS = 7;

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
  `(hd_demo, ${DEMO_ACCESS_DAYS} days) so you don't have to re-enter it. We don't sell it and ` +
  "we don't share it with ad platforms.";

/** The marketing checkbox. Must be rendered verbatim; the server stores this string. */
export const MARKETING_CONSENT_LABEL =
  "Email me about AYA and healdesk. Unsubscribe with one click, any time.";

/** The email ask that follows the visitor's first message in the chat demo. */
export const CHAT_EMAIL_NOTE =
  "Your email unlocks the demo. Nothing is emailed to you unless you tick the " +
  "box below.";
