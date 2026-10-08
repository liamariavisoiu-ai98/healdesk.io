import { unsafeDb } from "@/db";
import { findLiveStepUp } from "@/lib/factors/step-ups";

import type { PortalContext } from "./access";
import { sessionBinding } from "./step-up";

/**
 * Who did a portal change, as far as a shared sign-in can say (plan Part D3):
 * the device whose passkey is live on this session, or, without one, the
 * sign-in itself. The label goes on audit rows, on the setup wizard's
 * progress and on clinic_settings_history; it is a device's name as staff gave
 * it, never a person's.
 *
 * Reading it never counts as activity: only a patient page or a sensitive
 * change touches the step-up (lib/portal/step-up.ts).
 */

/** The label when no passkey is live on the session. */
export const SIGN_IN_ACTOR_LABEL = "the clinic's sign-in";

export type PortalActor = {
  label: string;
  /** Whether a passkey step-up is live on this session, for changes that need one. */
  steppedUp: boolean;
};

export async function portalActor(ctx: PortalContext): Promise<PortalActor> {
  const binding = await sessionBinding(ctx);
  const live = binding ? await findLiveStepUp(unsafeDb, binding, { touch: false }) : null;
  return live
    ? { label: live.deviceLabel, steppedUp: true }
    : { label: SIGN_IN_ACTOR_LABEL, steppedUp: false };
}
