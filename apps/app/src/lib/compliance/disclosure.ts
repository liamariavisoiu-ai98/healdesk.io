/**
 * The opening disclosure.
 *
 * One sentence satisfies almost the entire AI-disclosure landscape at once:
 * California SB 1001 and AB 2905, Utah's AI Policy Act (health counts as a
 * high-risk interaction), Maine LD 1727, Texas TRAIGA, Anthropic's usage
 * policy, and the all-party call-recording states. What a spoken line cannot
 * be is written, and the statutes that want the notice in writing as well are
 * met by the clinic's own notice, clinicAiNotice() below.
 *
 * Three properties make it work, and all three are easy to lose:
 *
 *   1. It is FIRST — before any audio reaches transcription, so the notice
 *      precedes the interception it is giving notice of.
 *   2. It is recorded as given, and timed: `conversations.disclosure_played_at`,
 *      with the fixed asset the line is played from. healdesk keeps no
 *      audio, so there is no recording of its own to carry it (the voice
 *      provider holds one for at most a day, until healdesk has the
 *      transcript), and since 13 October 2026 healdesk keeps no transcript
 *      either (it is emailed to the clinic; BAA 1.4.0), so the timestamp is
 *      the evidence healdesk holds that notice was given
 *      (state-disclosure.md, decision 3).
 *   3. It is not configurable. If a clinic can switch it off, a clinic will,
 *      and we become a co-defendant.
 *
 * Announce on 100% of calls. Do not build a state-by-state matrix: area codes
 * do not track location, callers roam, and two seconds is cheaper than a class
 * action.
 */

export type Channel = "voice" | "sms" | "web_chat" | "instagram_dm" | "messenger" | "whatsapp";

export type DisclosureContext = {
  clinicName: string;
  channel: Channel;
  /** True when the exchange touches clinical information (CA AB 3030). */
  clinical?: boolean;
};

/**
 * The voice opener.
 *
 * Says AI, says transcribed and by whom, and says healdesk keeps no audio and
 * the providers hold a recording for a day at most: the facts the statutes
 * below need, and nothing else, in about five seconds of speech. The clinic's
 * greeting follows it and asks what the caller wants (lib/setup/greetings.ts).
 *
 * Shortened on 23 October 2026 (owner, after test calls in which callers
 * said "hello?" into a 75-word opener). Dropped, by the owner's decision:
 *   - "not a human": "the AI assistant" already says it, which is what every
 *     AI-disclosure statute in state-disclosure.md asks (decision 1, revised);
 *   - the "say representative" line: a caller who asks for a person still
 *     gets the handover (prompt.ts, BOOKING; the model's `handoff`), but the
 *     opener no longer sends callers away before AYA has tried to help;
 *   - "an automated system run by": "by our service providers" keeps what
 *     decision 4 needs, that a third party transcribes.
 * Until 22 October 2026 the line said "no audio recording is kept", true of
 * healdesk since 21 September 2026 (conversations carries no recording
 * reference) but not of the voice provider, which holds a call's transcript
 * and recording until healdesk has its own copy and deletes the call then
 * (one day at the longest, the backstop in lib/voice/backstop.ts). The line
 * says both halves, because a disclosure that understates what happens is
 * worse than none.
 * "Transcribed" is not decoration: the CIPA §631(a) exposure in *Ambriz v.
 * Google* is about a third party intercepting call CONTENTS, which is what
 * transcription is. Disclosing recording alone does not describe it, and
 * "by our service providers" tells the caller that a third party is the one
 * transcribing (docs/counsel/state-disclosure.md, decision 4).
 */
export function voiceDisclosure(context: DisclosureContext): string {
  return (
    `Hi, this is the AI assistant for ${context.clinicName}. ` +
    `This call is transcribed by our service providers; we keep no audio, and they hold a recording for a day at most.`
  );
}

/**
 * The voice opener in Spanish (owner, 22 October 2026).
 *
 * A call always opens with the English line above: nothing is known of the
 * caller's language before they speak. The first time a call is taken into
 * Spanish (lib/voice/call-language.ts), this line is said before the next
 * reply, once per call, so a caller who did not follow the English notice
 * hears it in words they do. It says exactly what the English line says, the
 * same three facts and no others: an AI assistant; transcribed by our service
 * providers; healdesk keeps no audio and they hold a recording for a day at
 * most. It is not configurable either, and a change to the English line must
 * change this one in the same commit (tests/compliance.test.ts pins both).
 * Awaiting review by a native speaker and by counsel.
 */
export function voiceDisclosureEs(context: Pick<DisclosureContext, "clinicName">): string {
  return (
    `Le habla el asistente de inteligencia artificial de ${context.clinicName}. ` +
    `Esta llamada la transcriben nuestros proveedores de servicios; nosotros no guardamos audio, y ellos conservan una grabación un día como máximo.`
  );
}

/**
 * California AB 3030 addendum.
 *
 * Applies when a health facility uses generative AI for patient communications
 * about clinical information: a disclaimer plus instructions for reaching a
 * human licensed provider. The duty falls on the clinic, but only our product
 * can discharge it.
 */
export function clinicalAddendum(context: DisclosureContext): string {
  return (
    `This response was generated by AI. ` +
    `To speak with a licensed provider at ${context.clinicName}, say "provider" or call the clinic directly.`
  );
}

/** SMS opener — the same three facts, inside a segment. */
export function smsDisclosure(context: DisclosureContext): string {
  return `${context.clinicName}: you're messaging an AI assistant. Msg&data rates may apply. Reply STOP to opt out, HELP for help.`;
}

/**
 * Meta channels get a WARNING, not a disclosure.
 *
 * Meta states in its own Cloud API terms that it is not a Business Associate
 * and that the API is not HIPAA compliant. So the job on these channels is to
 * be useful without ever confirming anything, and to move the conversation to
 * a channel we can actually secure. "By phone", never "or text": healdesk
 * sends no texts (v1 spec, "SMS cut from v1 entirely"), and a greeting that
 * promised one would be a promise nothing in the product can keep.
 *
 * The same line on Instagram, Messenger and WhatsApp. It opens the first
 * reply of each conversation and no later one (lib/meta/greeting.ts says
 * what a conversation is), which is BAA 1.3.0's promise that the first reply
 * says it is an AI assistant and that the channel is not secure. It goes in
 * front of a reply the guard has already passed: its "don't share medical
 * details" is guidance by the guard's own pattern.
 */
export function metaChannelGreeting(context: DisclosureContext): string {
  return (
    `Hi! I'm an AI assistant for ${context.clinicName}. ` +
    `This channel isn't secure, so please don't share medical details here — ` +
    `I can take your number and the practice will continue by phone.`
  );
}

export function disclosureFor(context: DisclosureContext): string {
  switch (context.channel) {
    case "voice":
      return voiceDisclosure(context);
    case "sms":
      return smsDisclosure(context);
    case "web_chat":
      // The visitor's details go to staff, not the visitor to a live
      // person. v1 has no live staff inbox, so "ask for a person any time"
      // on its own would promise a seat that nobody is sitting in. (The
      // voice opener carried the same promise until 23 October 2026, when
      // the owner cut it to keep the call's first seconds short.)
      return (
        `You're chatting with an AI assistant for ${context.clinicName}. ` +
        `Ask for a person any time and I'll pass your details to the practice team, who will get back to you within a day.`
      );
    case "instagram_dm":
    case "messenger":
    case "whatsapp":
      return metaChannelGreeting(context);
  }
}

/**
 * The written notice, for the clinic's own website and intake form.
 *
 * The lines above are the assistant's; this one is the clinic's. Texas
 * TRAIGA wants the disclosure "written in plain language", Utah wants it in
 * writing before a written exchange, and California AB 3030 wants written
 * communications disclaimed in writing. Each duty falls on the practice, and
 * the terms keep it there (§ 8, "Your own notices"), so healdesk hands every
 * clinic this text word for word (docs/counsel/state-disclosure.md,
 * decision 8). The direct line is left for the clinic to fill: only the
 * clinic knows a number that reaches a person and is not forwarded back to
 * the assistant, and a guessed one is worse than a blank. It is a
 * convenience, not a warranty that it satisfies any state, and the setup
 * email that carries it says so.
 */
export function clinicAiNotice(context: Pick<DisclosureContext, "clinicName">): string {
  return (
    `${context.clinicName} uses an AI assistant to answer calls and messages and to book appointments. ` +
    `It is not a person and gives no medical advice. ` +
    `Calls it answers are transcribed, and its provider holds any recording for no more than a day. ` +
    `To reach a person, call [your direct line].`
  );
}

/**
 * Whether a channel may carry PHI at all.
 *
 * The Meta channels cannot, and no configuration changes that — there is no BAA
 * to be had. They are a front door, not a hallway: the agent greets, shares
 * publicly available information, captures intent, and hands off.
 */
export function channelMayCarryPhi(channel: Channel): boolean {
  return channel === "voice" || channel === "sms" || channel === "web_chat";
}

/**
 * Things the agent must never say on a Meta channel.
 *
 * The line is finer than it looks. Confirming an appointment is an obvious
 * disclosure; so is sympathising with a condition the patient mentioned.
 * "Sorry to hear about your acne" confirms both who they are and why they
 * contacted a dermatologist.
 *
 * This is the one Meta rule of docs/counsel/agreement-changes.md § 6, which
 * the BAA's "What healdesk is not authorised to do" clause and terms § 9
 * also state: the assistant may book and may send the clinic's own hosted
 * payment link on these channels, so the old blanket "anything about
 * payment" entry is gone; a treatment name and any promotion are out,
 * because WhatsApp's policy bars promoting medical and healthcare products
 * and Meta signs no BAA.
 *
 * The Meta front door puts this list into its system prompt word for word,
 * and its reply guard checks every entry it can without the model's help,
 * the clinic's own service names and promotional wording included
 * (lib/meta/front-door.ts). The clinic's never-say list goes in beside it,
 * after it, and adds to it: neither replaces nor reorders anything here.
 */
export const META_CHANNEL_PROHIBITIONS = [
  "Confirming the person is, was, or will be a patient",
  "Any appointment date, time, or provider name",
  "Any treatment name, in a reply or in a payment description",
  "Acknowledging a condition they mentioned, even sympathetically",
  "Balances, insurance status, or anything about payment beyond the clinic's own hosted payment link",
  "Promotions of any kind (WhatsApp's policy bars promoting medical and healthcare products)",
  "Any clinical guidance whatsoever",
] as const;
