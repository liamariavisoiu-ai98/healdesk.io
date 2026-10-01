import { currentDirectBookingAddendum } from "@healdesk/catalog";
import { eq } from "drizzle-orm";

import { agentConfigs, clinics } from "@/db/schema";
import { env } from "@/lib/env";
import type { TenantTx } from "@/lib/tenant";

import { writableConnection } from "./calendar";

/**
 * Whether the assistant may book a caller straight into the calendar
 * (design of 23 September 2026, §E.1).
 *
 * TODO(v1, launch plan steps 1.5 and 1.7): v1 books straight into the
 * clinic's Google Calendar on every channel, with "Auto-confirm bookings" on
 * by default (v1 spec, "Every switch in the portal"). When the Google
 * Calendar adapter lands, the decision this function makes should be the
 * clinic's Auto-confirm switch and manual booking mode (a one-way system, or
 * a broken calendar connection), not the two addendum gates below — the
 * counsel approval of the direct-booking addendum and the practice's
 * election of it. They are left in place for now because they are wired
 * through the database (the `clinics_direct_requires_election` CHECK in
 * drizzle/0040 makes booking_mode = 'direct' unrepresentable without an
 * election), the setup link, the console's booking-mode switch and the
 * agreement text, and whether the v1 BAA covers writing a booking into the
 * clinic's own calendar without that addendum is a question for counsel,
 * not code. Until the adapter exists the calendar gate fails for every real
 * clinic anyway: the only registered adapter that can write is the test
 * fixture.
 *
 * Six gates, all read fresh on every call and never cached, because the
 * failure this guards against is a clinic that was switched to direct
 * booking on Monday and withdrew on Tuesday, or a kill switch pulled at
 * noon, still booking at one. Each gate is independent and each is held by a
 * different party — the environment (ops), counsel (the addendum flag), the
 * practice (its election, made unrepresentable without one by a CHECK), the
 * connection (a writable calendar with a recorded PHI basis), the go-live
 * function (production) and the approved script — so no single mistake
 * opens the door.
 *
 * The console's `setBookingMode { mode: "direct" }` and the voice tool routes
 * both call this, and both surface `missing` verbatim: the operator should
 * read the same sentence the route refused on.
 */
export type DirectBookingCheck = { ok: true } | { ok: false; reason: string; missing: string[] };

export async function directBookingAllowed(tx: TenantTx): Promise<DirectBookingCheck> {
  const missing: string[] = [];
  const codes: string[] = [];
  const miss = (code: string, sentence: string) => {
    codes.push(code);
    missing.push(sentence);
  };

  if (!env.directBookingEnabled()) miss("env_off", "HEALDESK_DIRECT_BOOKING_ENABLED is not set to \"true\" in this environment.");
  if (!currentDirectBookingAddendum().approvedByCounsel) miss("addendum_not_approved", "The direct-booking addendum has not been approved by counsel.");

  const [clinic] = await tx.db
    .select({ bookingMode: clinics.bookingMode, dataClassification: clinics.dataClassification, withdrawnAt: clinics.directBookingWithdrawnAt })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!clinic) return { ok: false, reason: "not_found", missing: ["No such clinic."] };
  if (clinic.bookingMode !== "direct") miss("mode_not_direct", "The practice has not elected direct booking (booking mode is desk_confirms).");
  if (clinic.dataClassification !== "production") miss("not_production", "The clinic is not in production.");

  const writable = await writableConnection(tx);
  if (!writable) miss("no_writable_calendar", "No active, writable calendar connection with a recorded PHI basis (none can exist until the Google Calendar adapter is built).");

  const [agent] = await tx.db.select({ approvedAt: agentConfigs.approvedAt }).from(agentConfigs).where(eq(agentConfigs.clinicId, tx.clinicId)).limit(1);
  if (!agent?.approvedAt) miss("agent_not_approved", "The agent script has not been approved.");

  return missing.length ? { ok: false, reason: codes[0]!, missing } : { ok: true };
}
