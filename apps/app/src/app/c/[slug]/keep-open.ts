"use server";

import { requirePortal } from "@/lib/portal/access";
import { stepUpStatus, touchStepUp, type StepUp } from "@/lib/portal/step-up";

/**
 * What PatientPageGuard asks the server (plan Part D2). Each answer is about
 * the step-up the page was rendered under, `stepUpId`: if this session's live
 * step-up is another one, or none, the answer is no, and the page goes to the
 * step-up page, which comes straight back with a fresh render if a step-up is
 * live. A yes carries the deadline as two absolute times on the database's
 * clock, so the browser counts down from their difference and never from a
 * figure a cached page could carry.
 */

export type PatientPageClock =
  { ok: true; stepUpId: string; expiresAt: string; now: string; capped: boolean } | { ok: false };

function clock(live: StepUp | null, stepUpId: unknown): PatientPageClock {
  if (!live || live.stepUpId !== stepUpId) return { ok: false };
  return {
    ok: true,
    stepUpId: live.stepUpId,
    expiresAt: live.expiresAt.toISOString(),
    now: live.checkedAt.toISOString(),
    capped: live.capped,
  };
}

/** Whether the page may still show what it holds. Not activity: a tab coming back is not a person. */
export async function patientPageStatus(slug: string, stepUpId: string): Promise<PatientPageClock> {
  const portal = await requirePortal(String(slug));
  return clock(await stepUpStatus(portal), stepUpId);
}

/**
 * "Keep open": activity on the page's step-up, if it is still live, and its
 * new deadline. Never revives one that lapsed or whose passkey was removed,
 * and never past the 8-hour limit.
 */
export async function keepPatientPageOpen(
  slug: string,
  stepUpId: string,
): Promise<PatientPageClock> {
  const portal = await requirePortal(String(slug));
  return clock(await touchStepUp(portal), stepUpId);
}
