/** Whether real patients' calls may be answered: only HEALDESK_VOICE_REAL_CALLS=1 (lib/voice/test-calls.ts). */
export function voiceRealCallsAllowed(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.HEALDESK_VOICE_REAL_CALLS?.trim() === "1";
}
