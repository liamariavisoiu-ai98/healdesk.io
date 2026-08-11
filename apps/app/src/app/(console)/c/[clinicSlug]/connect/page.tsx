import {
  getConnectionGuide,
  getPlatform,
  personaliseGuide,
} from "@healdesk/catalog";
import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";

import { clinics } from "@/db/schema";
import { resolveTenantContext } from "@/lib/session";
import { TenantAccessError, withTenant } from "@/lib/tenant";

import { ConnectWizard } from "./ConnectWizard";

export const dynamic = "force-dynamic";

export default async function ConnectPage({
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
      redirect(`/sign-in?next=/c/${clinicSlug}/connect`);
    }
    throw error;
  }

  const clinic = await withTenant(context, async (tx) => {
    const [row] = await tx.db
      .select({
        name: clinics.name,
        bookingProvider: clinics.bookingProvider,
      })
      .from(clinics)
      .where(eq(clinics.id, context.clinicId))
      .limit(1);
    return row;
  });

  if (!clinic?.bookingProvider) notFound();

  const platform = getPlatform(clinic.bookingProvider);
  const guide = getConnectionGuide(clinic.bookingProvider);

  // OAuth platforms don't use this wizard — they get a single approve button,
  // which needs developer accounts we don't have yet.
  if (!platform || !guide) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-14">
        <h1 className="text-2xl font-semibold tracking-tight">
          Nothing to set up yet
        </h1>
        <p className="mt-3 text-[color:var(--color-muted)]">
          {platform
            ? `${platform.name} connects with a single approval rather than a setup wizard. We'll email you when that's ready.`
            : "This clinic has no booking platform selected."}
        </p>
      </main>
    );
  }

  const personalised = personaliseGuide(guide, clinicSlug);

  return (
    <main className="mx-auto max-w-2xl px-6 py-14">
      <p className="text-xs font-bold tracking-[0.14em] text-[color:var(--color-muted)] uppercase">
        {clinic.name}
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">
        Connect {platform.name}
      </h1>
      <p className="mt-3 max-w-[58ch] text-[color:var(--color-muted)]">
        About {personalised.estimatedMinutes} minutes. You&apos;ll create a
        read-only account for us — we never ask for your own login, and we
        can&apos;t change anything in {platform.name}.
      </p>

      <div className="mt-8">
        <ConnectWizard
          guide={personalised}
          platformName={platform.name}
          clinicSlug={clinicSlug}
        />
      </div>
    </main>
  );
}
