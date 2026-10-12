/**
 * Who asked for a deletion, on its own so the client console can import it
 * (lib/admin/ops-client.ts is server-only; see incident-classes.ts).
 *
 * Chosen, never typed: apps/app keeps it with the record of the deletion and
 * in its audit row, both of which outlive the deletion, and a CHECK there
 * (erasure_requests_requested_by_check) refuses anything else. A name typed
 * into a free-text "who asked" was the one copy of a person a deletion could
 * leave behind (review of 12 October 2026).
 */
export const ERASURE_REQUESTERS = {
  practice: "The practice",
  person_via_practice: "The person, through the practice",
  representative_via_practice: "A legal representative, through the practice",
} as const;

export type ErasureRequester = keyof typeof ERASURE_REQUESTERS;
