import type { PasskeyEnrolDecision } from "@/lib/factors/authority";

/**
 * The Protect page's three states, and the human route's line, shared by the
 * page, its client half and its actions. Pure: no React, no database.
 *
 *   - `open`: this session may add a device now (the first passkey before
 *     go-live, a live step-up, the human route's link, or the paying
 *     browser's first enrolment);
 *   - `needs_proof`: the sign-in has a device, so another device's passkey
 *     can step this session up, over the phone's QR flow if need be;
 *   - `no_device`: it has none (Protect was skipped, or every device was
 *     removed) and patient data can exist, so only a code from the
 *     authenticator backup or the human route can add one. Never a link to
 *     the step-up page, which with no passkey only links back here.
 */
export type ProtectMode = "open" | "needs_proof" | "no_device";

export function protectMode(decision: PasskeyEnrolDecision): ProtectMode {
  if (decision.allowed) return "open";
  return decision.hasPasskey ? "needs_proof" : "no_device";
}

/** The human route (plan Part D3; lib/factors/recovery.ts), as the clinic is told it. */
export const HUMAN_ROUTE =
  "No device or code at hand? Email hello@healdesk.io: we'll call your clinic back on its published number, then email your clinic's address a link that lets this device be added.";
