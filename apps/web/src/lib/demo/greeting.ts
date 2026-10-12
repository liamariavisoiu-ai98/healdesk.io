/**
 * The first thing a clinic's AYA says in a chat, before the demo's own notice.
 *
 * It lives apart from clinic-prompts.ts because the homepage's "See it in your
 * own branding" shows it in the preview widget, in the browser, and the prompt
 * module carries the whole of the demo's instructions. Both read it from here,
 * so what the preview shows is what the demo built from the same site opens
 * with, and it says it is an AI assistant, as the opening line has to on every
 * channel.
 */
export function greetingLead(clinicName: string): string {
  return `Hi! I'm ${clinicName}'s AI assistant. Ask me anything a patient would: treatments, prices, hours, how to book.`;
}
