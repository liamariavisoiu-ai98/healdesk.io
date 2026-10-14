"use server";

import { requirePortal } from "@/lib/portal/access";
import { touchStepUp } from "@/lib/portal/step-up";

/**
 * "Keep open" on a patient page (plan Part D2): counts as activity on this
 * session's passkey step-up, if it is still live, and says how long it now
 * has. Never revives one that has lapsed or whose passkey was removed, and
 * never past the 8-hour limit: then the page closes and asks for the passkey
 * again.
 */

export type KeepOpen = { ok: true; expiresInMs: number } | { ok: false };

export async function keepPatientPageOpen(slug: string): Promise<KeepOpen> {
  const portal = await requirePortal(String(slug));
  const live = await touchStepUp(portal);
  return live ? { ok: true, expiresInMs: live.expiresInMs } : { ok: false };
}
