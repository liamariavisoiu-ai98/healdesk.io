import { sql } from "drizzle-orm";
import { redirect } from "next/navigation";

import { unsafeDb } from "@/db";
import { listJobs } from "@/lib/scheduler/jobs";
import { requireSession } from "@/lib/session";
import { TenantAccessError } from "@/lib/tenant";

import { toggleJob } from "./actions";

/**
 * The ops console.
 *
 * Internal only — there is no public sign-up, and the proxy redirects anyone
 * without a session. Deliberately plain: this is a control surface for the
 * team, not a product surface, and the important thing is that the state it
 * shows is true.
 */

export const dynamic = "force-dynamic";

export default async function ConsolePage() {
  try {
    await requireSession();
  } catch (error) {
    if (error instanceof TenantAccessError) redirect("/sign-in");
    throw error;
  }

  const [jobs, clinics] = await Promise.all([
    listJobs(),
    // Via the SECURITY DEFINER function: with no tenant set the runtime role
    // sees no clinics at all, which is the isolation working rather than a bug.
    // Deliberately includes the slug so the list can link into each clinic —
    // and nothing else, because anything patient-level must go through
    // withTenant() and be audited.
    unsafeDb
      .execute<{ id: string; slug: string; name: string; timezone: string }>(
        sql`select id, slug, name, timezone from app_clinics_overview()`,
      )
      .then((r) => (r as unknown as { rows?: unknown[] }).rows ?? r)
      .then(
        (r) =>
          r as { id: string; slug: string; name: string; timezone: string }[],
      ),
  ]);

  return (
    <main className="mx-auto max-w-4xl px-6 py-14">
      <p className="text-xs font-bold tracking-[0.14em] text-[color:var(--color-muted)] uppercase">
        healdesk ops
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Console</h1>

      {/* ---------------- Scheduled jobs ---------------- */}
      <section className="mt-12">
        <h2 className="text-sm font-bold tracking-[0.08em] uppercase">
          Scheduled jobs
        </h2>
        <p className="mt-2 max-w-[62ch] text-sm text-[color:var(--color-muted)]">
          Everything here is off until someone turns it on. Leave them off until
          there are real tenants — a report job running against an empty or
          half-configured estate either does nothing or does something
          embarrassing.
        </p>

        <div className="mt-5 grid gap-3">
          {jobs.map((job) => (
            <div
              key={job.name}
              className="rounded-2xl border border-[color:var(--color-line)] bg-white p-5"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2.5">
                    <span
                      aria-hidden
                      className={[
                        "size-2 rounded-full",
                        job.enabled
                          ? "bg-[color:var(--color-red)]"
                          : "bg-[color:var(--color-line-strong)]",
                      ].join(" ")}
                    />
                    <span className="font-semibold">{job.name}</span>
                    <span
                      className={[
                        "rounded-full px-2.5 py-0.5 text-[11px] font-bold tracking-[0.06em] uppercase",
                        job.enabled
                          ? "bg-[color:var(--color-red)]/10 text-[color:var(--color-red)]"
                          : "bg-[color:var(--color-paper-2)] text-[color:var(--color-muted)]",
                      ].join(" ")}
                    >
                      {job.enabled ? "On" : "Off"}
                    </span>
                  </div>
                  <p className="mt-1.5 text-sm text-[color:var(--color-muted)]">
                    {job.cadence}
                  </p>
                </div>

                <form action={toggleJob}>
                  <input type="hidden" name="name" value={job.name} />
                  <input
                    type="hidden"
                    name="enabled"
                    value={String(!job.enabled)}
                  />
                  <button
                    type="submit"
                    className={[
                      "rounded-full px-5 py-2.5 text-sm font-bold transition-colors",
                      job.enabled
                        ? "border border-[color:var(--color-line-strong)] hover:border-[color:var(--color-ink)]"
                        : "bg-[color:var(--color-ink)] text-white",
                    ].join(" ")}
                  >
                    {job.enabled ? "Turn off" : "Turn on"}
                  </button>
                </form>
              </div>

              <dl className="mt-4 grid gap-1.5 border-t border-[color:var(--color-line)] pt-4 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-[color:var(--color-muted)]">Last run</dt>
                  <dd className="font-medium">
                    {job.lastRunAt
                      ? job.lastRunAt.toISOString().replace("T", " ").slice(0, 16)
                      : "Never"}
                  </dd>
                </div>
                {job.lastRunStatus ? (
                  <div className="flex justify-between gap-4">
                    <dt className="text-[color:var(--color-muted)]">Result</dt>
                    <dd className="text-right font-medium">
                      {job.lastRunStatus}
                      {job.lastRunNote ? ` — ${job.lastRunNote}` : ""}
                    </dd>
                  </div>
                ) : null}
                {job.runningSince ? (
                  <div className="flex justify-between gap-4">
                    <dt className="text-[color:var(--color-muted)]">Running</dt>
                    <dd className="font-medium">
                      since {job.runningSince.toISOString().slice(11, 16)}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </div>
          ))}
        </div>
      </section>

      {/* ---------------- Clinics ---------------- */}
      <section className="mt-14">
        <h2 className="text-sm font-bold tracking-[0.08em] uppercase">
          Clinics ({clinics.length})
        </h2>

        {clinics.length === 0 ? (
          <p className="mt-4 rounded-2xl border border-[color:var(--color-line)] bg-white p-5 text-sm text-[color:var(--color-muted)]">
            No clinics yet. They appear here once someone completes checkout.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-[color:var(--color-line)] overflow-hidden rounded-2xl border border-[color:var(--color-line)] bg-white">
            {clinics.map((clinic) => (
              <li key={clinic.id}>
                <a
                  href={`/c/${clinic.slug}`}
                  className="flex items-center justify-between gap-4 px-5 py-3.5 hover:bg-[color:var(--color-paper-2)]"
                >
                  <span className="font-medium">{clinic.name}</span>
                  <span className="text-sm text-[color:var(--color-muted)]">
                    {clinic.timezone}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-3 text-xs text-[color:var(--color-muted)]">
          Names and timezones only. Anything patient-level requires opening a
          clinic, which is scoped and audited.
        </p>
      </section>
    </main>
  );
}
