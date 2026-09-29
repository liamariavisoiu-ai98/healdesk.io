/**
 * The consent questions the assistant asks, verbatim and versioned.
 *
 * An AI voice is an "artificial voice" under the TCPA (FCC 24-17), so a
 * callback placed by the assistant needs the person's prior express consent —
 * and "they gave us their number" is not that. Both front doors therefore ask
 * one fixed question, in these exact words, and the product stores the
 * person's own reply beside it: on the phone the extractor's verbatim quote,
 * on a Meta thread the raw inbound message (never the model's summary).
 *
 * The wording is data, not prose in a prompt, for three reasons:
 *
 *   1. The stored consent row records `wordingVersion`, and the dialer refuses
 *      a row whose version is not the current one — so the question a person
 *      answered is always reproducible from this file, and a reworded question
 *      cannot silently inherit consent given to an older one.
 *   2. The purposes named in the question are exactly the purposes a callback
 *      may have (settle the time; collect a detail the desk still needs).
 *      A call for any other reason is outside the consent, by the text.
 *   3. Counsel reviews one string, once (decision (b), design of
 *      23 September 2026).
 *
 * `{clinic}` in the Meta lines is the practice's display name; the caller
 * substitutes it (it occurs once per line). The Meta lines are worded to pass
 * every REFUSED pattern in the front door's reply guard — they name no time,
 * service or practitioner — and a test asserts it.
 *
 * Changing any string here is a new version. The old one stays the wording
 * that existing consent rows point at.
 */
export const CALLBACK_CONSENT = {
  version: "callback-v2",
  voice:
    "Is it alright if the practice's automated assistant calls you back on this number about this booking request — to settle the time, or if the front desk still needs a detail from you? It's an AI voice, and you can say 'stop' at any time and we won't call again.",
  meta:
    "Is it OK for {clinic}'s automated assistant to call you back on that number about this request — to settle a time, or if the front desk needs one more detail? It's an AI voice, and it stops the moment you tell it to. It's also fine to say no — the practice will still see your request.",
  whatsappOptIn:
    "One more thing — is it OK for {clinic} to send you a message here on WhatsApp if there's an update about your request? Reply yes or no; either is fine.",
} as const;

export type CallbackConsentWording = typeof CALLBACK_CONSENT;
