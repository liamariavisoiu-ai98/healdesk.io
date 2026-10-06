/**
 * The clinic portal's door (plan Part D4). A signature until sign-in lands,
 * so pages, server actions and Package C and D's portal actions are written
 * against it now.
 */

/** Who is asking, about which clinic. v1 has one sign-in per clinic and no roles. */
export type PortalContext = {
  userId: string;
  clinicId: string;
  clinicSlug: string;
};

/**
 * The signed-in user's context on clinic `slug`, or "not found".
 *
 * It runs on every portal page and server action, never once in a layout:
 * a layout does not re-run on client navigation and never runs for a route
 * handler. Membership is checked through `app_user_clinic_grants` (0043)
 * alone, with no roles: the clinic's one sign-in can do everything, and
 * patient pages also need `requireStepUp` (step-up.ts). Any other user, and
 * a request with no session, gets the same "not found" as a slug that does
 * not exist, so the portal cannot be used to list clinics.
 *
 * Lands with sign-in in M2. Until then it throws, so nothing can be built on
 * a guard that lets everyone in.
 */
export async function requirePortal(slug: string): Promise<PortalContext> {
  void slug;
  throw new Error("requirePortal lands with sign-in (M2)");
}
