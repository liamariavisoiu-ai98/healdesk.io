/**
 * The greetings a clinic starts with (spec, "Phone greeting: pre-filled from
 * the clinic name"; "Chat greeting: pre-filled"). Each is said after the
 * locked AI line (lib/compliance/disclosure.ts), which no greeting can
 * replace or remove. A clinic that never edits its greeting keeps these,
 * built from its current name, so a corrected name corrects the greeting.
 */

/** The phone greeting, said after the locked AI line. */
export function defaultPhoneGreeting(clinicName: string): string {
  return `Thanks for calling ${clinicName}. How can I help you today?`;
}

/** The chat greeting, written after the locked AI line. */
export function defaultChatGreeting(): string {
  return "How can I help you today?";
}
