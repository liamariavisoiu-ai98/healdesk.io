import { toE164 } from "@healdesk/connectors";

/**
 * Healdesk's own test phones (HEALDESK_TEST_NUMBERS): the numbers an operator
 * rings a clinic's line from to hear AYA, after go-live as well as during the
 * forwarding test. A call from one is Healdesk's, never the clinic's patient:
 * it is not billed as minutes and is never phone's first answer
 * (lib/voice/ingest.ts voiceMeteringFor, lib/channels/events.ts).
 *
 * A comma-separated list of numbers, read at use time and kept as E.164; empty
 * by default, and an entry that is not a number is left out. Business
 * numbers, never a patient's.
 */
export function healdeskTestNumbers(): string[] {
  const raw = process.env.HEALDESK_TEST_NUMBERS ?? "";
  return raw
    .split(/[,;\n]+/)
    .map((entry) => (entry.trim() ? toE164(entry.trim()) : null))
    .filter((n): n is string => typeof n === "string" && /^\+[1-9]\d{6,14}$/.test(n));
}

/** Whether a caller's number is one of Healdesk's own test phones. */
export function isHealdeskTestNumber(phone: string | null | undefined): boolean {
  if (!phone) return false;
  const caller = toE164(phone) ?? phone.trim();
  return healdeskTestNumbers().includes(caller);
}
