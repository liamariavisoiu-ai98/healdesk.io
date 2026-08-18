"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { clinics } from "@/db/schema";
import {
  DAY_KEYS,
  DAY_LABELS,
  OpeningHoursError,
  parseOpeningHours,
  type TimeRange,
} from "@/lib/clinic/opening-hours";
import { resolveTenantContext } from "@/lib/session";
import { withTenant } from "@/lib/tenant";

/**
 * Saving a clinic's opening hours.
 *
 * Worth being careful with despite looking like a settings form, because this
 * value decides what the monthly report is allowed to claim. Hours that are
 * wrong in the "we close earlier than we do" direction cause calls the clinic's
 * own staff answered to be counted as recovered — overstating the one figure
 * the customer checks us on.
 *
 * So the form is parsed strictly and rejected loudly rather than coerced, and
 * "closed" has to be said explicitly rather than being what you get by leaving
 * a field blank.
 */

export type HoursState =
  | { status: "idle" }
  | { status: "saved" }
  | { status: "error"; message: string; field?: string };

export async function saveOpeningHours(
  _previous: HoursState,
  formData: FormData,
): Promise<HoursState> {
  const clinicSlug = String(formData.get("clinicSlug") ?? "");

  // A server action is a POST endpoint in its own right. The page that rendered
  // this form is not evidence about who is submitting it, so the session and
  // the clinic grant are both re-resolved here.
  const context = await resolveTenantContext(clinicSlug);

  const draft: Record<string, TimeRange[]> = {};

  for (const day of DAY_KEYS) {
    if (formData.get(`${day}-closed`) === "on") {
      draft[day] = [];
      continue;
    }

    const ranges: TimeRange[] = [];
    // Two ranges per day is enough for the lunchtime closure that is common in
    // single-room practices, and more than that has never been asked for.
    for (const slot of [0, 1]) {
      const open = String(formData.get(`${day}-open-${slot}`) ?? "").trim();
      const close = String(formData.get(`${day}-close-${slot}`) ?? "").trim();

      if (!open && !close) continue;
      if (!open || !close) {
        return {
          status: "error",
          field: day,
          message: `${DAY_LABELS[day]} has an opening time without a closing time, or the other way round. Give both, or tick Closed.`,
        };
      }
      ranges.push([open, close] as const);
    }

    if (ranges.length === 0) {
      return {
        status: "error",
        field: day,
        message: `${DAY_LABELS[day]} has no hours. Enter them, or tick Closed — we won't assume.`,
      };
    }

    draft[day] = ranges;
  }

  let hours;
  try {
    hours = parseOpeningHours(draft);
  } catch (error) {
    if (error instanceof OpeningHoursError) {
      return { status: "error", message: error.message, field: error.field };
    }
    throw error;
  }

  await withTenant(context, async (tx) => {
    await tx.db
      .update(clinics)
      .set({ openingHours: hours, updatedAt: new Date() })
      .where(eq(clinics.id, context.clinicId));

    // Not PHI, but it changes what we may claim in a revenue report, so it
    // belongs in the same trail as anything else that moves that number.
    tx.audit.record({
      action: "update",
      resourceType: "clinic",
      resourceId: context.clinicId,
      metadata: { field: "opening_hours" },
    });
  });

  revalidatePath(`/c/${clinicSlug}/hours`);
  return { status: "saved" };
}
