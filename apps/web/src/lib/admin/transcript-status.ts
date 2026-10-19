/**
 * The transcript outbox's statuses, in a module a client component may import:
 * ops-client holds the signing secret and must never reach a browser bundle,
 * so the values the Ops page needs on both sides live here, with only types
 * crossing from ops-client (apps/app db/schema.ts is the source).
 */
export const TRANSCRIPT_STATUSES = ["open", "pending", "sent", "bounced", "delivered", "expired", "unconfirmed"] as const;
export type TranscriptStatus = (typeof TRANSCRIPT_STATUSES)[number];

/** The statuses whose sealed copy still exists, so "send again" has something to send (the engine's HOLDING). */
export const TRANSCRIPT_RESENDABLE: readonly TranscriptStatus[] = ["pending", "sent", "bounced"];

/** The windows the receipts page offers, in days; the engine allows 1 to 366. */
export const TRANSCRIPT_WINDOWS = [7, 30, 90] as const;

/** The window a `?days=` asks for: one of the offered windows, else 30. Anything else never reaches the engine. */
export function transcriptWindow(raw: string | string[] | undefined): number {
  const asked = Number(Array.isArray(raw) ? raw[0] : raw);
  return TRANSCRIPT_WINDOWS.find((w) => w === asked) ?? 30;
}
