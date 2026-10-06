import type { PortalContext } from "./access";

/**
 * The second factor in front of patient pages and sensitive changes (plan
 * Part D2-D4). A signature until the factors land, so the screens that need
 * it are written against it now.
 */

/**
 * `patient_pages`: Conversations, Bookings and transcripts, held open for 15
 * minutes idle and 8 hours at most. `sensitive_change`: the direct line and
 * transfer number, the clinic's address, shortening retention, Stripe
 * connect and disconnect, adding or removing a device, exports.
 */
export type StepUpPurpose = "patient_pages" | "sensitive_change";

/** The passkey that stepped up, and its device's name, which the access log records. */
export type StepUp = { passkeyId: string; deviceLabel: string; at: Date };

/**
 * A passkey step-up on this device, fresh enough for `purpose`; throws when
 * there is none, and the page asks for one. The returned device label is
 * what the access log and a channel event's `actor` record, so a shared
 * sign-in still says which device did what.
 *
 * Lands with the factors in M2; patient pages enforce it from M5. Until then
 * it throws.
 */
export async function requireStepUp(ctx: PortalContext, purpose: StepUpPurpose): Promise<StepUp> {
  void ctx;
  void purpose;
  throw new Error("requireStepUp lands with the factors (M2)");
}
