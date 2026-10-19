import type * as BookingRequests from "@/lib/meta/booking-requests";

/**
 * The single-use desk tokens createBookingRequest minted in this test file,
 * oldest first.
 *
 * Since 19 October 2026 no email carries one: the clinic's booking alert
 * (L7) is a pointer into the signed-in portal, and notifyDesk, which mailed
 * the /booking/<token> link, is gone. The tests of that page and of
 * decideBookingRequest take the token where it is minted instead, until the
 * Bookings screen retires the page. A test file wires it in with:
 *
 *   vi.mock("@/lib/meta/booking-requests", async (importOriginal) =>
 *     (await import("./setup/minted-tokens")).recordingMints(await importOriginal()),
 *   );
 */
export const mintedTokens: string[] = [];

/** The module as it is, with createBookingRequest noting each token it mints. */
export function recordingMints(actual: typeof BookingRequests): typeof BookingRequests {
  return {
    ...actual,
    createBookingRequest: async (...args: Parameters<typeof actual.createBookingRequest>) => {
      const created = await actual.createBookingRequest(...args);
      mintedTokens.push(created.token);
      return created;
    },
  };
}

/** The newest token minted in this file. */
export function lastMintedToken(): string {
  const token = mintedTokens.at(-1);
  if (!token) throw new Error("no booking request was created");
  return token;
}
