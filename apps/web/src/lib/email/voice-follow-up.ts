import { isSafeTypedText } from "@healdesk/catalog";

import type { CheckoutMode } from "@/lib/checkout-mode";
import { POLICY } from "@/lib/legal";
import { site } from "@/lib/site";

import {
  commercialFooter,
  firstName,
  nameForSubject,
  SUBJECT_MAX,
  type RenderedEmail,
} from "./setup-emails";

/**
 * The two emails AYA's demo call sends when the owner on the line agrees
 * (app/api/voice-demo/follow-up): the link to set up the package she named,
 * to the owner, and the request itself, to hello@.
 *
 * ## The owner's email opens what the mode allows
 *
 * While the purchase is by invitation (lib/checkout-mode.ts, "pilot"), only a
 * setup link minted in /admin opens it (plan A2), and /get-started shows a
 * visitor with none "Tell us about your clinic". Until 19 October 2026 this
 * email called that page "the link to set up" the package, a promise the page
 * did not keep. In that mode it now says what the page is: where to ask, and
 * that a person replies with the setup link, whose acknowledgement (P2) gives
 * the day. It names no day itself, because the day depends on when they ask.
 * In public mode the link opens the purchase, and the email says so.
 *
 * ## Commercial
 *
 * It is P4's equivalent (a setup link, with the package's offer behind it),
 * and P4 is commercial under Annex X1.10, so it carries the one-click opt-out
 * and the footer every commercial email does: why it came, that replies reach
 * a person and should leave out patient details, and the sender's identity
 * with the US mailing address. The opt-out names the address's lead row
 * (leadForCommercialEmail in lib/leads.ts), which is where it is kept.
 */

export type VoiceSetupLink = {
  /** The page the email links to: the buy flow, at the plan or package she named when it exists. */
  url: string;
  /** The catalog name of what she named, or null when it matched nothing. */
  plan: string | null;
};

const PILOT_OPENING = "Your next step with healdesk: ";
const PUBLIC_OPENING = "Your healdesk setup link: ";

/** Why the owner gets it (X1.9). */
const WHY =
  "You're getting this because you asked AYA, healdesk's assistant, to email you on a demo call.";

/** To the owner, on "start": the link, worded for what the link opens in this mode. */
export function voiceSetupLinkEmail(input: {
  name: string;
  clinic: string;
  link: VoiceSetupLink;
  mode: CheckoutMode;
  unsubscribeUrl: string;
}): RenderedEmail {
  const { name, link, mode } = input;
  // The clinic's name as AYA heard it, from a caller nobody has checked: in
  // a commercial email to an address only spoken, it is printed only when it
  // is a name (the catalog's isSafeTypedText), never a link or a number.
  const clinic = isSafeTypedText(input.clinic, 160) ? input.clinic.trim() : "";
  // Their first name as heard, or none: firstName() refuses anything that is not one.
  const first = name ? firstName(name) : "there";
  const greeting = first === "there" ? "Hi," : `Hi ${first},`;
  const what = `${link.plan ?? "healdesk"}${clinic ? ` for ${clinic}` : ""}`;
  const opening = mode === "pilot" ? PILOT_OPENING : PUBLIC_OPENING;
  const subject = link.plan
    ? `${opening}${nameForSubject(link.plan, SUBJECT_MAX - opening.length)}`
    : opening.replace(/: $/, "");

  const body =
    mode === "pilot"
      ? [
          greeting,
          "",
          `As promised on the call with ${site.agent}, here is where to start setting up ${what}:`,
          "",
          link.url,
          "",
          "Tell us about your clinic there. A person reads every request and replies with your own setup link, which opens the purchase; the email confirming your request gives the day we'll reply.",
          "",
          "Setup then takes about fifteen minutes of your attention. Each channel goes live on its own: the phone once call forwarding is set.",
          "",
          "If you'd rather talk it through first, reply to this email and a person will answer.",
        ]
      : [
          greeting,
          "",
          `As promised on the call with ${site.agent}, here is the link to set up ${what}:`,
          "",
          link.url,
          "",
          "It takes about fifteen minutes of your attention. Each channel goes live on its own: the phone once call forwarding is set.",
          "",
          "If you'd rather talk it through first, reply to this email and a person will answer.",
        ];
  return { subject, text: body.join("\n") + commercialFooter(WHY, input.unsubscribeUrl) };
}

/** What AYA is told once the owner's email has gone, so what she says matches what they got. */
export function voiceSetupLinkSaid(link: VoiceSetupLink, mode: CheckoutMode): string {
  return mode === "pilot"
    ? `Sent. The link to start setting up ${link.plan ?? "healdesk"} is in their inbox: they tell us about their clinic there, and the team replies with their setup link.`
    : `Sent. The setup link${link.plan ? ` for ${link.plan}` : ""} is in their inbox.`;
}

export type VoiceFollowUpRequest = {
  topic: string;
  name: string;
  clinic: string;
  practice: string;
  email: string;
  preferredTime: string;
  recommended: string;
  notes: string;
  summary: string;
  callId: string;
};

/** To hello@: the request, and on "start" what the owner was sent. Reply-to is the owner. */
export function voiceFollowUpInternal(
  request: VoiceFollowUpRequest,
  sent: { link: VoiceSetupLink; mode: CheckoutMode } | null,
): RenderedEmail {
  const who = `${request.name || "unnamed"}${request.clinic ? ` (${request.clinic})` : ""}`;
  const opening =
    request.topic === "start"
      ? "Demo call: ready to start, "
      : request.topic === "sales_session"
        ? "Demo call: session with the team, "
        : `Demo call: ${request.topic} question, `;
  const sentLine = !sent
    ? "Nothing has been sent to them; the first message is ours to send, by email."
    : sent.mode === "pilot"
      ? `They have been sent the link above to ask for setup, and nothing else. Once they ask, send their setup link from ${site.url}/admin/setup.`
      : "They have been sent the setup link above and nothing else.";
  return {
    subject: `${opening}${nameForSubject(who, SUBJECT_MAX - opening.length)}`,
    text: [
      `Asked for:     ${request.topic.replace("_", " ")}`,
      `Name:          ${request.name || "(not given)"}`,
      `Clinic:        ${request.clinic || "(not given)"}`,
      `Practice type: ${request.practice || "(not given)"}`,
      `Email:         ${request.email}`,
      `Good time:     ${request.preferredTime || "(not given)"}, in their words, time zone unconfirmed`,
      `Recommended:   ${request.recommended || "(none)"}`,
      sent ? `Sent them:     ${sent.link.url}` : "",
      "",
      `What they want: ${request.notes || "(not given)"}`,
      "",
      `What they told AYA: ${request.summary || "(no summary)"}`,
      "",
      `They asked for this on AYA's demo call ${request.callId}, and agreed to be emailed about this request only.`,
      sentLine,
      "Do not phone them: the number on a demo call was given for that call only.",
    ]
      .filter((line, i, all) => line !== "" || all[i - 1] !== "")
      .join("\n"),
  };
}

/**
 * To hello@: a call back a clinic owner asked for on a demo call
 * (lib/demo/callbacks.ts). Business contact data: the number they gave to
 * be called on, their first name, the clinic and the one line Aya wrote of
 * what they want to talk about, never anything else said on the call. No
 * reply-to: the owner's address is on the demo, linked below, and the
 * request is answered by phone.
 */
export function demoCallbackInternal(input: {
  clinicName: string;
  firstName: string;
  phoneE164: string;
  topic: string;
  test: boolean;
  offerEndsAt: Date | null;
  /** The demo page itself, which shows what Aya knew. */
  demoUrl: string;
  leadEmail: string | null;
}): RenderedEmail {
  const opening = `${input.test ? "[Test] " : ""}Demo call: call back ${input.firstName || "them"}, `;
  const offer =
    input.offerEndsAt && input.offerEndsAt.getTime() > Date.now()
      ? `${input.offerEndsAt.toISOString().replace("T", " ").slice(0, 16)} UTC`
      : "none live";
  return {
    subject: `${opening}${nameForSubject(input.clinicName || "a clinic", SUBJECT_MAX - opening.length)}`,
    text: [
      input.test ? "An operator's own test call from /admin, not a prospect." : "",
      `Call:          ${input.phoneE164}`,
      `Name:          ${input.firstName || "(not given)"}`,
      `Clinic:        ${input.clinicName || "(not given)"}`,
      `Email:         ${input.leadEmail ?? "(none on the demo)"}`,
      `To talk about: ${input.topic || "(not given)"}, in Aya's words`,
      `Discount ends: ${offer}`,
      `Demo:          ${input.demoUrl}`,
      `Queue:         ${site.url}/admin/queues#demo-callbacks`,
      "",
      "They asked Aya on the demo call for someone from the team to call them, gave this number and confirmed it when she read it back. Call them on it about this, and nothing else; mark it called in Queues when done, which deletes the number.",
      `If nobody marks it, the number is deleted after ${POLICY.demoCallbackRetentionDays} days, as the Privacy page says.`,
    ]
      .filter((line, i) => line !== "" || i > 0)
      .join("\n"),
  };
}
