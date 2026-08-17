import { getAdapter, limitationsOf } from "@healdesk/connectors";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { redirect } from "next/navigation";

import {
  providerConnections,
  reconciliationExceptions,
  syncRuns,
} from "@/db/schema";
import { resolveTenantContext } from "@/lib/session";
import { TenantAccessError, withTenant } from "@/lib/tenant";

import { ClinicNav } from "../ClinicNav";

/**
 * Sync health and the exception queue.
 *
 * The queue is the reason this page exists. Money the matcher could not place
 * goes into a table, and a table nobody looks at is the same as deleting it —
 * so it gets a screen, ordered by amount, with the open items first. When a
 * clinic asks "why is the figure lower than my own books", this is the answer,
 * itemised, before they have to ask.
 *
 * Sync runs sit above it because the usual cause of a shrinking figure is not a
 * matching problem at all: it is a connection that quietly stopped working
 * three weeks ago while the reports kept arriving.
 */

export const dynamic = "force-dynamic";

export default async function SyncPage({
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
      redirect(`/sign-in?next=/c/${clinicSlug}/sync`);
    }
    throw error;
  }

  const data = await withTenant(context, async (tx) => {
    const connections = await tx.db
      .select({
        id: providerConnections.id,
        provider: providerConnections.provider,
        status: providerConnections.status,
        lastVerifiedAt: providerConnections.lastVerifiedAt,
        lastError: providerConnections.lastError,
      })
      .from(providerConnections)
      .where(eq(providerConnections.clinicId, context.clinicId));

    const runs = await tx.db
      .select({
        id: syncRuns.id,
        resource: syncRuns.resource,
        status: syncRuns.status,
        cursorAt: syncRuns.cursorAt,
        itemsSeen: syncRuns.itemsSeen,
        itemsWritten: syncRuns.itemsWritten,
        notes: syncRuns.notes,
        error: syncRuns.error,
        startedAt: syncRuns.startedAt,
        finishedAt: syncRuns.finishedAt,
      })
      .from(syncRuns)
      .where(eq(syncRuns.clinicId, context.clinicId))
      .orderBy(desc(syncRuns.startedAt))
      .limit(20);

    const open = await tx.db
      .select({
        id: reconciliationExceptions.id,
        kind: reconciliationExceptions.kind,
        summary: reconciliationExceptions.summary,
        amountAtRiskUsd: reconciliationExceptions.amountAtRiskUsd,
        firstSeenAt: reconciliationExceptions.firstSeenAt,
        lastSeenAt: reconciliationExceptions.lastSeenAt,
      })
      .from(reconciliationExceptions)
      .where(
        and(
          eq(reconciliationExceptions.clinicId, context.clinicId),
          isNull(reconciliationExceptions.resolvedAt),
        ),
      )
      // Biggest money first. An operator with ten minutes should spend them on
      // the $4,000 mismatch, not the $80 one.
      .orderBy(sql`${reconciliationExceptions.amountAtRiskUsd} desc nulls last`)
      .limit(100);

    const [totals] = await tx.db
      .select({
        atRisk: sql<string>`coalesce(sum(${reconciliationExceptions.amountAtRiskUsd}), 0)::text`,
      })
      .from(reconciliationExceptions)
      .where(
        and(
          eq(reconciliationExceptions.clinicId, context.clinicId),
          isNull(reconciliationExceptions.resolvedAt),
        ),
      );

    tx.audit.record({
      action: "read",
      resourceType: "reconciliation_exception",
      resultCount: open.length,
      metadata: { view: "sync-health" },
    });

    return { connections, runs, open, atRisk: totals?.atRisk ?? "0" };
  });

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <a href="/" className="text-sm font-semibold text-[color:var(--color-muted)]">
        ← All clinics
      </a>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">
        Sync &amp; reconciliation
      </h1>
      <ClinicNav slug={clinicSlug} active="sync" />

      {/* ---------------- Connections ---------------- */}
      <section className="mt-10">
        <h2 className="text-sm font-bold tracking-[0.08em] uppercase">
          Connections ({data.connections.length})
        </h2>

        {data.connections.length === 0 ? (
          <p className="mt-4 text-sm text-[color:var(--color-muted)]">
            Nothing connected. This clinic&rsquo;s revenue figures are estimates
            from its average appointment value.
          </p>
        ) : (
          <div className="mt-4 grid gap-3">
            {data.connections.map((connection) => {
              const adapter = getAdapter(connection.provider);
              const limitations = adapter ? limitationsOf(adapter.capabilities) : [];

              return (
                <div
                  key={connection.id}
                  className="rounded-2xl border border-[color:var(--color-line)] bg-white p-5"
                >
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-semibold">{connection.provider}</span>
                    <span
                      className={[
                        "rounded-full px-2.5 py-1 text-[11px] font-bold uppercase",
                        connection.status === "active"
                          ? "bg-[color:var(--color-ink)]/[0.06]"
                          : "bg-[color:var(--color-red)]/10 text-[color:var(--color-red)]",
                      ].join(" ")}
                    >
                      {connection.status}
                    </span>
                    <span className="ml-auto text-[color:var(--color-muted)]">
                      {connection.lastVerifiedAt
                        ? `checked ${connection.lastVerifiedAt.toISOString().slice(0, 10)}`
                        : "never checked"}
                    </span>
                  </div>

                  {!adapter ? (
                    <p className="mt-3 text-sm text-[color:var(--color-muted)]">
                      No adapter for this platform yet, so nothing is being
                      synced from it.
                    </p>
                  ) : null}

                  {connection.lastError ? (
                    <p className="mt-3 text-sm text-[color:var(--color-red)]">
                      {connection.lastError}
                    </p>
                  ) : null}

                  {/* Rendered verbatim. A limitation that gets summarised into
                      a status badge stops being information. */}
                  {limitations.length > 0 ? (
                    <ul className="mt-3 grid gap-1.5 text-sm text-[color:var(--color-muted)]">
                      {limitations.map((note) => (
                        <li key={note}>· {note}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ---------------- Exception queue ---------------- */}
      <section className="mt-12">
        <h2 className="text-sm font-bold tracking-[0.08em] uppercase">
          Open exceptions ({data.open.length})
        </h2>
        <p className="mt-2 max-w-[62ch] text-sm text-[color:var(--color-muted)]">
          Money and visits we could not place. Everything here is excluded from
          the reported total and declared as a caveat on the report — a figure
          that quietly drops what it cannot explain is the failure this product
          exists to replace.
        </p>

        {Number(data.atRisk) > 0 ? (
          <p className="mt-3 text-sm font-semibold">
            ${Number(data.atRisk).toLocaleString("en-US", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}{" "}
            unattributed.
          </p>
        ) : null}

        {data.open.length === 0 ? (
          <p className="mt-4 text-sm text-[color:var(--color-muted)]">
            Nothing outstanding.
          </p>
        ) : (
          <div className="mt-4 grid gap-3">
            {data.open.map((exception) => (
              <div
                key={exception.id}
                className="rounded-2xl border border-[color:var(--color-line)] bg-white p-5"
              >
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="rounded-full bg-[color:var(--color-paper-2)] px-2.5 py-1 text-[11px] font-bold uppercase">
                    {exception.kind.replace(/_/g, " ")}
                  </span>
                  {exception.amountAtRiskUsd ? (
                    <span className="font-semibold">
                      ${Number(exception.amountAtRiskUsd).toFixed(2)}
                    </span>
                  ) : null}
                  <span className="ml-auto text-[color:var(--color-muted)]">
                    first seen {exception.firstSeenAt.toISOString().slice(0, 10)}
                  </span>
                </div>
                {/* Summaries are written to be free of patient identifiers, so
                    this screen stays readable without widening the blast
                    radius of a shoulder-surf. */}
                <p className="mt-2 text-sm text-[color:var(--color-muted)]">
                  {exception.summary}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ---------------- Runs ---------------- */}
      <section className="mt-12">
        <h2 className="text-sm font-bold tracking-[0.08em] uppercase">
          Recent sync runs
        </h2>
        <p className="mt-2 max-w-[62ch] text-sm text-[color:var(--color-muted)]">
          A connection that stops working is worse than one that never worked:
          the reports keep arriving and quietly shrink. A stale cursor here is
          the first place that shows up.
        </p>

        {data.runs.length === 0 ? (
          <p className="mt-4 text-sm text-[color:var(--color-muted)]">
            Nothing has run yet.
          </p>
        ) : (
          <div className="mt-4 grid gap-3">
            {data.runs.map((run) => (
              <div
                key={run.id}
                className="rounded-2xl border border-[color:var(--color-line)] bg-white p-4"
              >
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-semibold">{run.resource}</span>
                  <span
                    className={[
                      "rounded-full px-2.5 py-1 text-[11px] font-bold uppercase",
                      run.status === "ok"
                        ? "bg-[color:var(--color-ink)]/[0.06]"
                        : run.status === "failed"
                          ? "bg-[color:var(--color-red)]/10 text-[color:var(--color-red)]"
                          : "bg-[color:var(--color-paper-2)] text-[color:var(--color-muted)]",
                    ].join(" ")}
                  >
                    {run.status}
                  </span>
                  <span className="text-[color:var(--color-muted)]">
                    {run.itemsWritten} written of {run.itemsSeen} seen
                  </span>
                  <span className="ml-auto text-[color:var(--color-muted)]">
                    {run.startedAt.toISOString().replace("T", " ").slice(0, 16)}
                  </span>
                </div>

                {run.error ? (
                  <p className="mt-2 text-sm text-[color:var(--color-red)]">
                    {run.error}
                  </p>
                ) : null}

                {run.notes && run.notes.length > 0 ? (
                  <ul className="mt-2 grid gap-1 text-sm text-[color:var(--color-muted)]">
                    {run.notes.map((note) => (
                      <li key={note}>· {note}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
