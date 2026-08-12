import { and, desc, eq, gte, ilike, lte, type SQL } from "drizzle-orm";
import { redirect } from "next/navigation";

import { auditLog } from "@/db/schema";
import { resolveTenantContext } from "@/lib/session";
import { TenantAccessError, withTenant } from "@/lib/tenant";

import { ClinicNav } from "../ClinicNav";

/**
 * Audit log search.
 *
 * The question an investigator actually asks is "who accessed this patient's
 * record on 3 March", so search is by actor, action, resource and date — not
 * free text. Free text over an audit log invites someone to search for a
 * patient name, which is precisely what must never be in there.
 *
 * Reading the audit log is itself a PHI-adjacent access and is audited. That
 * looks recursive and is intentional: an audit trail nobody can inspect without
 * leaving a trace is the one an insider uses.
 */

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

const ACTIONS = ["read", "create", "update", "delete", "export", "decrypt"];

export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ clinicSlug: string }>;
  searchParams: Promise<{
    actor?: string;
    action?: string;
    resource?: string;
    from?: string;
    to?: string;
  }>;
}) {
  const { clinicSlug } = await params;
  const filters = await searchParams;

  let context;
  try {
    context = await resolveTenantContext(clinicSlug);
  } catch (error) {
    if (error instanceof TenantAccessError) {
      redirect(`/sign-in?next=/c/${clinicSlug}/audit`);
    }
    throw error;
  }

  const entries = await withTenant(context, async (tx) => {
    const conditions: SQL[] = [eq(auditLog.clinicId, context.clinicId)];

    if (filters.actor?.trim()) {
      conditions.push(ilike(auditLog.actorLabel, `%${filters.actor.trim()}%`));
    }
    if (filters.action && ACTIONS.includes(filters.action)) {
      conditions.push(eq(auditLog.action, filters.action));
    }
    if (filters.resource?.trim()) {
      conditions.push(
        ilike(auditLog.resourceType, `%${filters.resource.trim()}%`),
      );
    }
    if (filters.from && isDate(filters.from)) {
      conditions.push(gte(auditLog.occurredAt, new Date(filters.from)));
    }
    if (filters.to && isDate(filters.to)) {
      // Inclusive of the whole day, which is what someone typing a date means.
      const end = new Date(filters.to);
      end.setUTCHours(23, 59, 59, 999);
      conditions.push(lte(auditLog.occurredAt, end));
    }

    const rows = await tx.db
      .select()
      .from(auditLog)
      .where(and(...conditions))
      .orderBy(desc(auditLog.occurredAt))
      .limit(PAGE_SIZE);

    tx.audit.record({
      action: "read",
      resourceType: "audit_log",
      resultCount: rows.length,
      metadata: { view: "audit-search", filtered: conditions.length > 1 },
    });

    return rows;
  });

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <a href="/" className="text-sm font-semibold text-[color:var(--color-muted)]">
        ← All clinics
      </a>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">Audit</h1>
      <ClinicNav slug={clinicSlug} active="audit" />

      <form
        method="get"
        className="mt-6 grid gap-3 rounded-2xl border border-[color:var(--color-line)] bg-white p-5 sm:grid-cols-5"
      >
        <Field label="Who" name="actor" defaultValue={filters.actor} />
        <label className="block">
          <span className="text-[11px] font-bold tracking-[0.06em] uppercase">
            Action
          </span>
          <select
            name="action"
            defaultValue={filters.action ?? ""}
            className="mt-1.5 w-full rounded-lg border border-[color:var(--color-line)] bg-white px-3 py-2 text-sm outline-none"
          >
            <option value="">Any</option>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <Field label="Resource" name="resource" defaultValue={filters.resource} />
        <Field label="From" name="from" type="date" defaultValue={filters.from} />
        <Field label="To" name="to" type="date" defaultValue={filters.to} />

        <div className="sm:col-span-5">
          <button
            type="submit"
            className="rounded-full bg-[color:var(--color-ink)] px-5 py-2.5 text-sm font-bold text-white"
          >
            Search
          </button>
          <a
            href={`/c/${clinicSlug}/audit`}
            className="ml-4 text-sm font-semibold text-[color:var(--color-muted)]"
          >
            Clear
          </a>
        </div>
      </form>

      <p className="mt-4 text-sm text-[color:var(--color-muted)]">
        {entries.length === PAGE_SIZE
          ? `Showing the most recent ${PAGE_SIZE}. Narrow the dates to see further back.`
          : `${entries.length} ${entries.length === 1 ? "entry" : "entries"}.`}
      </p>

      {entries.length === 0 ? (
        <p className="mt-6 text-sm text-[color:var(--color-muted)]">
          Nothing matches.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-2xl border border-[color:var(--color-line)] bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[color:var(--color-line)]">
                {["When", "Who", "Action", "Resource", "Count", "IP"].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-3 text-left text-[11px] font-bold tracking-[0.06em] text-[color:var(--color-muted)] uppercase"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr
                  key={entry.id}
                  className="border-b border-[color:var(--color-line)] last:border-0"
                >
                  <td className="px-4 py-3 whitespace-nowrap">
                    {entry.occurredAt.toISOString().replace("T", " ").slice(0, 19)}
                  </td>
                  <td className="px-4 py-3">
                    {entry.actorLabel}
                    <span className="ml-1.5 text-[color:var(--color-muted)]">
                      ({entry.actorType})
                    </span>
                  </td>
                  <td className="px-4 py-3">{entry.action}</td>
                  <td className="px-4 py-3">
                    {entry.resourceType}
                    {entry.resourceId ? (
                      <span className="ml-1.5 text-[color:var(--color-muted)]">
                        {entry.resourceId.slice(0, 8)}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">{entry.resultCount ?? ""}</td>
                  <td className="px-4 py-3 text-[color:var(--color-muted)]">
                    {entry.ipAddress ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

function Field({
  label,
  name,
  defaultValue,
  type = "text",
}: {
  label: string;
  name: string;
  defaultValue?: string;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-bold tracking-[0.06em] uppercase">
        {label}
      </span>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue}
        className="mt-1.5 w-full rounded-lg border border-[color:var(--color-line)] bg-white px-3 py-2 text-sm outline-none focus:border-[color:var(--color-orange)]"
      />
    </label>
  );
}

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}
