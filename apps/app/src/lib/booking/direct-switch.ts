import { currentDirectBookingAddendum } from "@healdesk/catalog";

import { env } from "@/lib/env";

/**
 * Whether AYA may book straight into a clinic's calendar (DB-1,
 * docs/design/launch-readiness-2026-10-27/db-1-direct-booking-switch.md §3).
 *
 * Fails closed: it is true only when all three hold, read fresh on every call
 * and never cached, so pulling any one stops the very next booking.
 *
 * 1. The owner's switch, HEALDESK_DIRECT_BOOKING_ENABLED, is the literal
 *    "true" (env.directBookingEnabled(), which stays the raw value for the
 *    console's ticks). Empty, "1", "TRUE" or "true " are all off.
 * 2. Counsel has released the Direct booking addendum in the running build
 *    (`approvedByCounsel === true` in the catalog). An env var alone, set on a
 *    task by mistake or by a hand-registered revision, never turns booking on.
 * 3. HEALDESK_DIRECT_BOOKING_ADDENDUM names exactly the addendum this build
 *    carries. A revised addendum changes the catalog version, so the deployed
 *    value stops matching and booking falls back to staff requests until
 *    Terraform sets the new version and a deploy rolls: the safe default for a
 *    legal document a clinic has not yet seen.
 *
 * Off is the existing manual mode: every channel takes a request for staff,
 * so a false here never strands a patient. mode.ts, calendar-ops.ts, the ops
 * `bookingSwitch` reply and directBookingToolsAllowed() all ask this one
 * function, so the portal, the buy page and the tools cannot disagree.
 */
export function directBookingOpen(): boolean {
  return directBookingSwitchParts().open;
}

/** The three facts behind directBookingOpen(), as booleans only, for the ops `bookingSwitch` reply. */
export type DirectBookingSwitchParts = {
  /** All three below: the one answer every caller uses. */
  open: boolean;
  /** HEALDESK_DIRECT_BOOKING_ENABLED is the literal "true". */
  env: boolean;
  /** The catalog's current addendum is approvedByCounsel. */
  released: boolean;
  /** HEALDESK_DIRECT_BOOKING_ADDENDUM equals the catalog's current version. */
  versionMatches: boolean;
};

export function directBookingSwitchParts(): DirectBookingSwitchParts {
  const addendum = currentDirectBookingAddendum();
  const switchOn = env.directBookingEnabled();
  const released = addendum.approvedByCounsel === true;
  const versionMatches = process.env.HEALDESK_DIRECT_BOOKING_ADDENDUM === addendum.version;
  return { open: switchOn && released && versionMatches, env: switchOn, released, versionMatches };
}
