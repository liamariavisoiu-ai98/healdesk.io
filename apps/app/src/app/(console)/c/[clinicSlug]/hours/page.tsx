import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { clinics } from "@/db/schema";
import { resolveTenantContext } from "@/lib/session";
import { TenantAccessError, withTenant } from "@/lib/tenant";

import { ClinicNav } from "../ClinicNav";

import { HoursForm } from "./HoursForm";

/**
 * Opening hours.
 *
 * Reads as a settings page and is really a reporting-accuracy page. It is the
 * only input to `recovery_reason = 'after_hours'`, which is the largest
 * category of contacts a clinic genuinely would have lost — so while this is
 * empty, every monthly report understates by the calls that arrived at 9pm.
 *
 * The banner says exactly that, rather than the usual "complete your profile"
 * nudge. A clinic that knows filling this in makes its own numbers more
 * accurate will do it; one told it is missing a setting will not.
 */

export const dynamic = "force-dynamic";

export default async function HoursPage({
  params,
}: {
  params: Promise<{ clinicSlug: string }>;
}) {
  const { clinicSlug } = await params;

  let context;
  try {
    context = await resolveTenantContext(clinicSlug);
  } catch (error) {
    if (error instanceof TenantAccessError) {
      redirect(`/sign-in?next=/c/${clinicSlug}/hours`);
    }
    throw error;
  }

  const clinic = await withTenant(context, async (tx) => {
    const [row] = await tx.db
      .select({
        name: clinics.name,
        timezone: clinics.timezone,
        openingHours: clinics.openingHours,
      })
      .from(clinics)
      .where(eq(clinics.id, context.clinicId))
      .limit(1);
    return row;
  });

  if (!clinic) redirect("/");

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="font-display text-2xl font-medium">{clinic.name}</h1>
      <ClinicNav slug={clinicSlug} active="hours" />

      <section className="mt-8">
        <h2 className="font-display text-xl font-medium">
          When is your front desk open?
        </h2>
        <p className="mt-2 max-w-[62ch] text-sm text-[color:var(--color-muted)]">
          We use this for one thing: deciding whether a call arrived when nobody
          at your practice could have answered it. Those calls are the clearest
          case of us recovering something you would otherwise have lost, and we
          only count them once we know your hours.
        </p>

        {clinic.openingHours ? null : (
          <p className="mt-4 rounded-xl border border-[color:var(--color-line-strong)] bg-[color:var(--color-wash,#FBF6F1)] px-4 py-3 text-sm">
            <strong>Not set yet.</strong> Until these are filled in we will not
            count any call as out-of-hours — so your reports are currently
            understating what the agent recovered, rather than guessing at your
            schedule.
          </p>
        )}

        <HoursForm
          clinicSlug={clinicSlug}
          timezone={clinic.timezone}
          initial={clinic.openingHours ?? null}
        />
      </section>
    </main>
  );
}
