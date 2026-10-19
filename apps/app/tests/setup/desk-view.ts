import type { ActorContext } from "@/lib/audit";
import {
  deskFreeTimes,
  isOpenRequest,
  readBookingRequest,
  type DeskRef,
  type ResolvedBookingRequest,
} from "@/lib/meta/booking-requests";
import { withTenant } from "@/lib/tenant";

/**
 * How the booking tests reach a request now that the single-use desk link is
 * gone: by its id in its clinic, as the portal's Bookings screen does
 * (lib/portal/bookings.ts), with a test actor in place of the device whose
 * passkey opened the screen. The screen's own sign-in, step-up and access
 * rows are tested in tests/bookings-screen.test.ts.
 */
export const DESK_ACTOR: ActorContext = { type: "service", serviceName: "desk-test" };

export function deskRef(clinicId: string, requestId: string): DeskRef {
  return { clinicId, requestId, actor: DESK_ACTOR };
}

export type DeskView = ResolvedBookingRequest & {
  /** The free times staff may pick from while it is open (deskFreeTimes); null when closed or not writable. */
  calendar: { writable: boolean; slots: { at: string; label: string }[] } | null;
};

/**
 * One request as the screen reads it, with its free times read after the
 * transaction has committed, as freeTimesFor reads them; null for an id this
 * clinic does not hold.
 */
export async function deskView(ref: DeskRef): Promise<DeskView | null> {
  const req = await withTenant({ clinicId: ref.clinicId, actor: ref.actor }, (tx) => readBookingRequest(tx, ref.requestId));
  if (!req) return null;
  const calendar = isOpenRequest(req) ? await deskFreeTimes(ref.clinicId, req, { actor: ref.actor }) : null;
  return { ...req, calendar };
}
