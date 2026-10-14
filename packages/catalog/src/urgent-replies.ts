import type { UrgentEmergency } from "./urgent-content";

/**
 * The fixed reply to a complication or an urgent symptom, on every channel
 * (plan Part G; the v1 spec, "Guardrails": "fixed response, immediate
 * escalation to the clinic's address. The fixed response tells the person to
 * call 911 in an emergency and gives the clinic's urgent-help number").
 *
 * Fixed text only, built here so the phone, the website chat and the Meta
 * channels cannot word it three ways. No model writes any of it, and nothing
 * the person said goes into it: the matcher (./urgent-content.ts) hands over
 * which emergency service applies, never the words.
 *
 * In order:
 *   1. The AI line: the assistant says what it is, which is also why it is
 *      handing the person on.
 *   2. The emergency service. For a person, 911: "call 911 now" in writing,
 *      "hang up and call 911" on a call, where the person is still on our
 *      line. For an animal (a veterinary practice), the emergency vet the
 *      practice refers to, by its number (clinic_settings.vet_referral_e164),
 *      never 911.
 *   3. The practice's own number: its urgent-help number as apps/app's
 *      lib/setup/urgent.ts resolves it. A veterinary practice's own number
 *      comes after the emergency vet's, and only while it is open (or when
 *      it has given no referral clinic), since a closed practice cannot see
 *      an emergency.
 *   4. "I've told the team", only when the urgent alert really reaches the
 *      practice (`teamAlerted`). The caller says whether it does; a line that
 *      promises an alert that is not sent is the one thing this must not be.
 *   5. On the website chat only: "Leave a number for the clinic to call you."
 *      The transcript is emailed to the practice when the chat ends. Not on a
 *      call, where the number is already known, and never on a Meta channel,
 *      which carries nothing about a patient.
 *
 * Every number arrives written for its channel (spoken digit by digit on a
 * call), so this file never formats one. Every line must also pass the Meta
 * front door's reply guard as written, which refuses guidance phrasing ("you
 * can", "you should"): hence "Otherwise, please call" for the practice's own
 * number, for an animal as for a person.
 */

export type UrgentReplyChannel = "voice" | "web_chat" | "meta";

export type UrgentReplyInput = {
  channel: UrgentReplyChannel;
  /** From the matcher's finding: 911 for a person, the emergency vet for an animal. */
  emergency: UrgentEmergency;
  clinicName: string;
  /** The practice's urgent-help number, written for the channel; null when it has none. */
  clinicNumber: string | null;
  /** A veterinary practice's emergency referral number, written for the channel. */
  referralNumber?: string | null;
  /** Whether the practice is open now; null when its hours are not known, which counts as open. */
  clinicOpen?: boolean | null;
  /** Whether the urgent alert reaches the practice, so "I've told the team" is true. */
  teamAlerted: boolean;
};

export const URGENT_AI_LINE = "I'm an AI assistant, so I can't help with anything urgent here.";
export const URGENT_TEAM_TOLD_LINE = "I've told the team.";
export const URGENT_LEAVE_NUMBER_LINE = "Leave a number for the clinic to call you.";

function emergencyLine(input: UrgentReplyInput): string {
  const voice = input.channel === "voice";
  if (input.emergency === "911") {
    return voice
      ? "If this is an emergency, hang up and call 911 now."
      : "If this is an emergency, call 911 now.";
  }
  const referral = input.referralNumber ?? null;
  if (referral) {
    return voice
      ? `If this is an emergency, hang up and call the emergency vet on ${referral}.`
      : `If this is an emergency, call the emergency vet now on ${referral}.`;
  }
  return voice
    ? "If this is an emergency, hang up and call your nearest emergency vet."
    : "If this is an emergency, call your nearest emergency vet now.";
}

function clinicLine(input: UrgentReplyInput): string | null {
  const number = input.clinicNumber;
  if (input.emergency === "911") {
    return number
      ? `Otherwise, please call ${input.clinicName} on ${number}.`
      : `Otherwise, please call ${input.clinicName}.`;
  }
  // An animal: the practice's own number while it is open, or whenever there
  // is no referral clinic to send the client to.
  const offered = !input.referralNumber || input.clinicOpen !== false;
  return number && offered ? `Otherwise, please call ${input.clinicName} on ${number}.` : null;
}

export function fixedUrgentReply(input: UrgentReplyInput): string {
  const lines = [URGENT_AI_LINE, emergencyLine(input), clinicLine(input)];
  if (input.teamAlerted) lines.push(URGENT_TEAM_TOLD_LINE);
  if (input.channel === "web_chat") lines.push(URGENT_LEAVE_NUMBER_LINE);
  return lines.filter((line): line is string => Boolean(line)).join(" ");
}
