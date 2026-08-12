import { redirect } from "next/navigation";

import { blockersFor, listClinics } from "@/lib/ops/clinics";
import { listJobs } from "@/lib/scheduler/jobs";
import { requireSession } from "@/lib/session";
import { TenantAccessError } from "@/lib/tenant";

import { toggleJob } from "./actions";

/**
 * The ops console.
 *
 * Internal only — no public sign-up, and the proxy redirects anyone without a
 * session. Deliberately plain: this is a control surface for the team, and the
 * important property is that what it shows is true.
 */

export const dynamic = "force-dynamic";

export default async function ConsolePage() {
  try {
    await requireSession();
  } catch (error) {
    if (error instanceof TenantAccessError) redirect("/sign-in");
    throw error;
  }

  const [jobs, clinics] = await Promise.all([listJobs(), listClinics()]);

  const blocked = clinics.filter((c) =>
    blockersFor(c).some((b) => b.level === "blocked"),
  );

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Console</h1>

      {blocked.length > 0 ? (
        <p className="mt-5 rounded-xl border border-[color:var(--color-red)]/30 bg-[color:var(--color-red)]/[0.06] px-4 py-3 text-sm font-semibold">
          {blocked.length} {blocked.length === 1 ? "clinic is" : "clinics are"}{" "}
          blocked from handling patient data. See below.
        </p>
      ) : null}

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
                    <Tag tone={job.enabled ? "warn" : "muted"}>
                      {job.enabled ? "On" : "Off"}
                    </Tag>
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
          <ul className="mt-4 grid gap-3">
            {clinics.map((clinic) => {
              const blockers = blockersFor(clinic);
              const worst = blockers.find((b) => b.level === "blocked");

              return (
                <li key={clinic.id}>
                  <a
                    href={`/c/${clinic.slug}`}
                    className="block rounded-2xl border border-[color:var(--color-line)] bg-white p-5 transition-colors hover:border-[color:var(--color-line-strong)]"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{clinic.name}</span>
                      <Tag>{clinic.specialty}</Tag>
                      <Tag
                        tone={
                          clinic.dataClassification === "production"
                            ? "ok"
                            : "muted"
                        }
                      >
                        {clinic.dataClassification}
                      </Tag>
                      <Tag
                        tone={
                          clinic.isCoveredEntity === null
                            ? "warn"
                            : clinic.isCoveredEntity
                              ? "ok"
                              : "muted"
                        }
                      >
                        {clinic.isCoveredEntity === null
                          ? "CE unknown"
                          : clinic.isCoveredEntity
                            ? "covered entity"
                            : "not a CE"}
                      </Tag>
                      <Tag tone={clinic.baaSignedAt ? "ok" : "muted"}>
                        {clinic.baaSignedAt ? "BAA signed" : "no BAA"}
                      </Tag>
                      <span className="ml-auto text-sm text-[color:var(--color-muted)]">
                        {clinic.timezone}
                      </span>
                    </div>

                    {worst ? (
                      <p className="mt-3 text-sm font-semibold text-[color:var(--color-red)]">
                        {worst.message}
                      </p>
                    ) : blockers.length ? (
                      <p className="mt-3 text-sm text-[color:var(--color-muted)]">
                        {blockers[0]!.message}
                      </p>
                    ) : null}
                  </a>
                </li>
              );
            })}
          </ul>
        )}

        <p className="mt-3 text-xs text-[color:var(--color-muted)]">
          Configuration only. Anything patient-level requires opening a clinic,
          which is scoped and audited.
        </p>
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
      className={`rounded-full px-2.5 py-1 text-[11px] font-bold tracking-[0.06em] uppercase ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
