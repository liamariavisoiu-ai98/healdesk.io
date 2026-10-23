import type { UrgentEmergency, UrgentLanguage } from "./urgent-content";

/**
 * The fixed reply to a complication or an urgent symptom, on every channel
 * (plan Part G; the v1 spec, "Guardrails": "fixed response, immediate
 * escalation to the clinic's address. The fixed response tells the person to
 * call 911 in an emergency and gives the clinic's urgent-help number").
 *
 * Fixed text only, built here so the phone, the website chat and the Meta
 * channels cannot word it three ways. No model writes any of it, and nothing
 * the person said goes into it: the matcher (./urgent-content.ts) hands over
 * which emergency service applies and which language to answer in, never the
 * words. English and Spanish, the two languages the screens read.
 *
 * In order:
 *   1. The AI line: the assistant says what it is, which is also why it is
 *      handing the person on.
 *   2. The emergency service. For a person, 911: "call 911 now" in writing,
 *      "hang up and call 911" on a call, where the person is still on our
 *      line. For an animal (a veterinary practice), the emergency vet the
 *      practice refers to, by its number (clinic_settings.vet_referral_e164),
 *      and then, always, 911 for a person who is hurt or in danger: whoever
 *      wrote may be the one in trouble. At a veterinary practice a person's
 *      emergency leads with 911 and still gives the emergency vet: every
 *      urgent reply there carries both, whichever emergency the matcher read.
 *   3. The practice's own number: its urgent-help number as apps/app's
 *      lib/setup/urgent.ts resolves it, never on a call the number that
 *      forwards back to the assistant. On a call with no such number,
 *      nothing: "please call the practice" to a caller already calling it
 *      sends them in a circle. On a call the adapter is putting through to
 *      a line that reaches a person (`transferring`, owner, 23 October
 *      2026), "stay on the line and I'll put you through" instead, said
 *      last, after "I've told the team". A veterinary practice's own number
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
  /** From the matcher's finding: the language the person wrote in. English when absent. */
  language?: UrgentLanguage;
  clinicName: string;
  /** The practice's urgent-help number, written for the channel; null when it has none. */
  clinicNumber: string | null;
  /**
   * Whether the practice's patients are animals. At a veterinary practice
   * every urgent reply carries the emergency vet, whichever emergency led:
   * the matcher can read an animal's emergency as a person's ("he stopped
   * breathing"), and the client must never lose the number that helps.
   */
  veterinary?: boolean;
  /** A veterinary practice's emergency referral number, written for the channel. */
  referralNumber?: string | null;
  /** Whether the practice is open now; null when its hours are not known, which counts as open. */
  clinicOpen?: boolean | null;
  /** Whether the urgent alert reaches the practice, so "I've told the team" is true. */
  teamAlerted: boolean;
  /**
   * On a call, whether the caller is being put through to the practice's
   * line that reaches a person as this is said (owner, 23 October 2026): the
   * reply then ends "stay on the line and I'll put you through" in place of
   * the practice's number. Ignored off a call and at a veterinary practice.
   */
  transferring?: boolean;
};

type Lines = {
  ai: string;
  call911: (voice: boolean) => string;
  person911: (voice: boolean) => string;
  vet: (voice: boolean, referral: string | null) => string;
  /** The emergency vet after 911, when a person's emergency leads at a veterinary practice. */
  vetForAnimal: (referral: string | null) => string;
  clinic: (name: string, number: string | null) => string;
  /** On a call being put through to the practice: in place of its number. */
  transfer: (name: string) => string;
  told: string;
  leaveNumber: string;
};

const LINES: Readonly<Record<UrgentLanguage, Lines>> = {
  en: {
    ai: "I'm an AI assistant, so I can't help with anything urgent here.",
    call911: (voice) =>
      voice
        ? "If this is an emergency, hang up and call 911 now."
        : "If this is an emergency, call 911 now.",
    person911: (voice) =>
      voice
        ? "If a person is hurt or in danger, hang up and call 911 now."
        : "If a person is hurt or in danger, call 911 now.",
    vet: (voice, referral) =>
      referral
        ? voice
          ? `If this is an emergency, hang up and call the emergency vet on ${referral}.`
          : `If this is an emergency, call the emergency vet now on ${referral}.`
        : voice
          ? "If this is an emergency, hang up and call your nearest emergency vet."
          : "If this is an emergency, call your nearest emergency vet now.",
    vetForAnimal: (referral) =>
      referral
        ? `If an animal needs emergency care, call the emergency vet on ${referral}.`
        : "If an animal needs emergency care, call your nearest emergency vet.",
    clinic: (name, number) =>
      number ? `Otherwise, please call ${name} on ${number}.` : `Otherwise, please call ${name}.`,
    transfer: (name) => `Otherwise, stay on the line and I'll put you through to ${name} now.`,
    told: "I've told the team.",
    leaveNumber: "Leave a number for the clinic to call you.",
  },
  es: {
    ai: "Soy un asistente de IA, así que no puedo ayudar con nada urgente aquí.",
    call911: (voice) =>
      voice
        ? "Si es una emergencia, cuelgue y llame al 911 ahora."
        : "Si es una emergencia, llame al 911 ahora.",
    person911: (voice) =>
      voice
        ? "Si una persona está herida o en peligro, cuelgue y llame al 911 ahora."
        : "Si una persona está herida o en peligro, llame al 911 ahora.",
    vet: (voice, referral) =>
      referral
        ? voice
          ? `Si es una emergencia, cuelgue y llame al veterinario de urgencias al ${referral}.`
          : `Si es una emergencia, llame ahora al veterinario de urgencias al ${referral}.`
        : voice
          ? "Si es una emergencia, cuelgue y llame al veterinario de urgencias más cercano."
          : "Si es una emergencia, llame ahora al veterinario de urgencias más cercano.",
    vetForAnimal: (referral) =>
      referral
        ? `Si un animal necesita atención de urgencia, llame al veterinario de urgencias al ${referral}.`
        : "Si un animal necesita atención de urgencia, llame al veterinario de urgencias más cercano.",
    clinic: (name, number) =>
      number ? `Si no, llame a ${name} al ${number}.` : `Si no, llame a ${name}.`,
    transfer: (name) => `Si no, no cuelgue y le comunico ahora con ${name}.`,
    told: "Ya avisé al equipo.",
    leaveNumber: "Deje un número para que la clínica le llame.",
  },
};

export const URGENT_AI_LINE = LINES.en.ai;
export const URGENT_TEAM_TOLD_LINE = LINES.en.told;
export const URGENT_LEAVE_NUMBER_LINE = LINES.en.leaveNumber;
export const URGENT_PERSON_LINE = LINES.en.person911(false);

export function fixedUrgentReply(input: UrgentReplyInput): string {
  const t = LINES[input.language ?? "en"];
  const voice = input.channel === "voice";
  const referral = input.referralNumber ?? null;
  // An animal's emergency is a veterinary practice's by definition.
  const veterinary = input.veterinary === true || input.emergency === "veterinary";
  const lines: (string | null)[] = [t.ai];
  if (input.emergency === "911") {
    lines.push(t.call911(voice));
    if (veterinary) lines.push(t.vetForAnimal(referral));
  } else {
    lines.push(t.vet(voice, referral), t.person911(voice));
  }
  // The practice's own number. At a veterinary practice that has given an
  // emergency referral clinic, only while it is open: a closed practice
  // cannot see an emergency, and the emergency vet can. Everywhere else
  // always, because the urgent-help number is the one that reaches a person.
  const withheld = veterinary && referral !== null && input.clinicOpen === false;
  // On a call the caller is already on the practice's published number,
  // which forwards to the assistant: "please call the practice" with no
  // other number sends them round in a circle (test call of 23 October
  // 2026). The call is put through to a line that reaches a person where
  // the adapter has one (`transferring`); otherwise the reply is 911 alone.
  const transferring = voice && input.transferring === true && !veterinary;
  if (transferring) {
    // Said last, because the call is put through as it ends.
    if (input.teamAlerted) lines.push(t.told);
    lines.push(t.transfer(input.clinicName));
    return lines.filter((line): line is string => Boolean(line)).join(" ");
  }
  if (!withheld) {
    if (input.clinicNumber) lines.push(t.clinic(input.clinicName, input.clinicNumber));
    else if (!veterinary && !voice) lines.push(t.clinic(input.clinicName, null));
  }
  if (input.teamAlerted) lines.push(t.told);
  if (input.channel === "web_chat") lines.push(t.leaveNumber);
  return lines.filter((line): line is string => Boolean(line)).join(" ");
}

// -----------------------------------------------------------------------------
// A message in a language no screen reads
// -----------------------------------------------------------------------------

export type OtherLanguageReplyInput = {
  channel: UrgentReplyChannel;
  clinicName: string;
  /** The practice's urgent-help number, written for the channel; null when it has none. */
  clinicNumber: string | null;
  /** A veterinary practice's emergency referral number: given for an animal, beside 911 for a person. */
  referralNumber?: string | null;
  /** Whether the practice's patients are animals. */
  veterinary?: boolean;
};

/**
 * The fixed reply to a message in a language other than English or Spanish
 * (./message-language.ts): the urgent screen cannot read it, so no model
 * answers it. In English, then in Spanish: what the assistant is and which
 * languages it answers in, 911 in an emergency (and at a veterinary practice
 * the emergency vet too), and the practice's number.
 */
export function otherLanguageReply(input: OtherLanguageReplyInput): string {
  const voice = input.channel === "voice";
  const referral = input.referralNumber ?? null;
  const en = [
    "I'm an AI assistant, and I can only help in English or Spanish.",
    voice
      ? "If this is an emergency, hang up and call 911 now."
      : "If this is an emergency, call 911 now.",
    input.veterinary
      ? referral
        ? `For an animal's emergency, call the emergency vet on ${referral}.`
        : null
      : null,
    LINES.en.clinic(input.clinicName, input.clinicNumber),
  ];
  const es = [
    "Soy un asistente de IA y solo puedo ayudar en inglés o en español.",
    voice
      ? "Si es una emergencia, cuelgue y llame al 911 ahora."
      : "Si es una emergencia, llame al 911 ahora.",
    input.veterinary
      ? referral
        ? `Si un animal tiene una emergencia, llame al veterinario de urgencias al ${referral}.`
        : null
      : null,
    LINES.es.clinic(input.clinicName, input.clinicNumber),
  ];
  return [...en, ...es].filter((line): line is string => Boolean(line)).join(" ");
}
