import type * as BookingRequests from "@/lib/meta/booking-requests";

import { deskRef } from "./desk-view";

/**
 * The booking requests createBookingRequest made in this test file, oldest
 * first, each as the reference staff decide it by (its clinic and its id),
 * for a test whose request is made deep inside a channel's own flow (a Meta
 * webhook, a call's ingest). A test file wires it in with:
 *
 *   vi.mock("@/lib/meta/booking-requests", async (importOriginal) =>
 *     (await import("./setup/minted-requests")).recordingMints(await importOriginal()),
 *   );
 */
export const mintedRequests: BookingRequests.DeskRef[] = [];

/** The module as it is, with createBookingRequest noting each request it makes. */
export function recordingMints(actual: typeof BookingRequests): typeof BookingRequests {
  return {
    ...actual,
    createBookingRequest: async (...args: Parameters<typeof actual.createBookingRequest>) => {
      const created = await actual.createBookingRequest(...args);
      mintedRequests.push(deskRef(args[0].clinicId, created.id));
      return created;
    },
  };
}

/** The newest request made in this file. */
export function lastMintedRequest(): BookingRequests.DeskRef {
  const ref = mintedRequests.at(-1);
  if (!ref) throw new Error("no booking request was created");
  return ref;
}
