import { getPlatform } from "@healdesk/catalog";
import { desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { auditLog, clinics } from "@/db/schema";
import { listConnections } from "@/lib/connections/store";
import { resolveTenantContext } from "@/lib/session";
import { TenantAccessError, withTenant } from "@/lib/tenant";

import { disconnectPlatform } from "./actions";

/**
 * Clinic detail.
 *
 * Everything here runs inside withTenant, so it is scoped by the database as
 * well as by the query — and reading it is audited, because a clinic's
 * configuration sits alongside its patient data.
 */

export const dynamic = "force-dynamic";

export default async function ClinicPage({
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
      redirect(`/sign-in?next=/c/${clinicSlug}`);
    }
    throw error;
  }

  const data = await withTenant(context, async (tx) => {
    const [clinic] = await tx.db
      .select()
      .from(clinics)
      .where(eq(clinics.id, context.clinicId))
      .limit(1);

    const connections = await listConnections(tx.db, context.clinicId);

    const recentAudit = await tx.db
      .select({
        action: auditLog.action,
        resourceType: auditLog.resourceType,
        actorLabel: auditLog.actorLabel,
        occurredAt: auditLog.occurredAt,
      })
      .from(auditLog)
      .where(eq(auditLog.clinicId, context.clinicId))
      .orderBy(desc(auditLog.occurredAt))
      .limit(15);

    tx.audit.record({
      action: "read",
      resourceType: "clinic",
      resourceId: context.clinicId,
      metadata: { view: "clinic-detail" },
    });

    return { clinic, connections, recentAudit };
  });

  if (!data.clinic) redirect("/");
  const { clinic, connections, recentAudit } = data;
  const platform = clinic.bookingProvider
    ? getPlatform(clinic.bookingProvider)
    : null;

  return (
    <main className="mx-auto max-w-3xl px-6 py-14">
      <a
        href="/"
        className="text-sm font-semibold text-[color:var(--color-muted)]"
      >
        ← All clinics
      </a>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">
        {clinic.name}
      </h1>

      <div className="mt-3 flex flex-wrap gap-2">
        <Tag>{clinic.specialty}</Tag>
        <Tag>{clinic.timezone}</Tag>
        <Tag>{clinic.plan ?? "no plan"}</Tag>
        <Tag
          tone={clinic.dataClassification === "production" ? "warn" : "muted"}
        >
          {clinic.dataClassification}
        </Tag>
        <Tag tone={clinic.attributionMode === "verified" ? "ok" : "muted"}>
          {clinic.attributionMode} attribution
        </Tag>
      </div>

      {/* The gate, surfaced. A clinic marked production without a signed BAA
          cannot receive PHI — the database refuses it — and that state should
          be visible here rather than discovered as a failed insert. */}
      {clinic.dataClassification === "production" && !clinic.baaSignedAt ? (
        <p className="mt-5 rounded-xl border border-[color:var(--color-red)]/30 bg-[color:var(--color-red)]/[0.06] px-4 py-3 text-sm font-semibold">
          Marked production with no signed BAA on file. The database is refusing
          all patient data for this clinic until that is resolved.
        </p>
      ) : null}

      {/* ---------------- Connections ---------------- */}
      <section className="mt-12">
        <h2 className="text-sm font-bold tracking-[0.08em] uppercase">
          Connections
        </h2>

        {connections.length === 0 ? (
          <div className="mt-4 rounded-2xl border border-[color:var(--color-line)] bg-white p-5">
            <p className="text-sm text-[color:var(--color-muted)]">
              {platform
                ? `Nothing connected. Revenue is estimated from this clinic's average appointment value.`
                : "No booking platform selected — revenue is estimated."}
            </p>
            {platform && platform.connection === "readonly_user" ? (
              <a
                href={`/c/${clinicSlug}/connect`}
                className="mt-4 inline-block rounded-full bg-[color:var(--color-ink)] px-5 py-2.5 text-sm font-bold text-white"
              >
                Connect {platform.name}
              </a>
            ) : null}
          </div>
        ) : (
          <ul className="mt-4 grid gap-3">
            {connections.map((connection) => (
              <li
                key={connection.id}
                className="rounded-2xl border border-[color:var(--color-line)] bg-white p-5"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <span className="font-semibold">
                      {getPlatform(connection.provider)?.name ??
                        connection.provider}
                    </span>
                    <Tag
                      tone={
                        connection.status === "active"
                          ? "ok"
                          : connection.status === "error"
                            ? "warn"
                            : "muted"
                      }
                    >
                      {connection.status}
                    </Tag>
                  </div>

                  <form action={disconnectPlatform}>
                    <input type="hidden" name="clinicSlug" value={clinicSlug} />
                    <input
                      type="hidden"
                      name="connectionId"
                      value={connection.id}
                    />
                    <button
                      type="submit"
                      className="text-sm font-semibold text-[color:var(--color-muted)] underline"
                    >
                      Disconnect
                    </button>
                  </form>
                </div>

                {connection.capabilities ? (
                  <p className="mt-3 text-sm text-[color:var(--color-muted)]">
                    {Object.entries(connection.capabilities)
                      .map(([name, has]) => `${has ? "✓" : "✕"} ${name}`)
                      .join("   ")}
                  </p>
                ) : null}

                {connection.lastError ? (
                  <p className="mt-2 text-sm font-semibold text-[color:var(--color-red)]">
                    {connection.lastError}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---------------- Audit ---------------- */}
      <section className="mt-12">
        <h2 className="text-sm font-bold tracking-[0.08em] uppercase">
          Recent access
        </h2>
        <p className="mt-2 text-sm text-[color:var(--color-muted)]">
          Every read and write of this clinic&apos;s patient data, including
          this page view.
        </p>

        {recentAudit.length === 0 ? (
          <p className="mt-4 text-sm text-[color:var(--color-muted)]">
            Nothing recorded yet.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-[color:var(--color-line)] overflow-hidden rounded-2xl border border-[color:var(--color-line)] bg-white text-sm">
            {recentAudit.map((entry, index) => (
              <li
                key={index}
                className="flex flex-wrap items-center gap-x-3 px-5 py-3"
              >
                <span className="font-medium">{entry.action}</span>
                <span className="text-[color:var(--color-muted)]">
                  {entry.resourceType}
                </span>
                <span className="ml-auto text-[color:var(--color-muted)]">
                  {entry.actorLabel}
                </span>
                <span className="text-xs text-[color:var(--color-muted)]">
                  {entry.occurredAt.toISOString().replace("T", " ").slice(0, 16)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function Tag({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "ok" | "warn";
}) {
  const tones = {
    muted: "bg-[color:var(--color-paper-2)] text-[color:var(--color-muted)]",
    ok: "bg-[color:var(--color-ink)]/[0.06] text-[color:var(--color-ink)]",
    warn: "bg-[color:var(--color-red)]/10 text-[color:var(--color-red)]",
  };

  return (
    <span
      className={`ml-2 rounded-full px-2.5 py-1 text-[11px] font-bold tracking-[0.06em] uppercase ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
