import { redirect } from "next/navigation";

import { buildMonthlyReport } from "@/lib/attribution/report";
import { assertNoPhiInReport, PhiInEmailError } from "@/lib/reporting/deliver";
import { renderMonthlyReport } from "@/lib/reporting/render";
import { resolveTenantContext } from "@/lib/session";
import { TenantAccessError } from "@/lib/tenant";

import { ClinicNav } from "../ClinicNav";

/**
 * Report preview.
 *
 * Shows exactly what would be sent, before anything is. Two reasons this earns
 * its place rather than being a nicety:
 *
 *   1. Nobody should discover what the first customer email looks like by
 *      receiving a copy of it.
 *   2. It runs the PHI guard in front of a human. If the guard ever fires, this
 *      page says so loudly instead of the failure surfacing as a silent
 *      non-delivery at month end.
 */

export const dynamic = "force-dynamic";

export default async function ReportPreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ clinicSlug: string }>;
  searchParams: Promise<{ month?: string }>;
}) {
  const { clinicSlug } = await params;
  const { month } = await searchParams;

  let context;
  try {
    context = await resolveTenantContext(clinicSlug);
  } catch (error) {
    if (error instanceof TenantAccessError) {
      redirect(`/sign-in?next=/c/${clinicSlug}/report`);
    }
    throw error;
  }

  // ?month=2026-07 previews a specific month; otherwise the one just ended.
  const within = month && /^\d{4}-\d{2}$/.test(month)
    ? new Date(`${month}-15T12:00:00Z`)
    : undefined;

  const report = await buildMonthlyReport(context.clinicId, { within });
  const rendered = renderMonthlyReport(report);

  let phiError: string | null = null;
  try {
    assertNoPhiInReport(rendered);
  } catch (error) {
    phiError =
      error instanceof PhiInEmailError ? error.message : "Unknown guard failure";
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <a href="/" className="text-sm font-semibold text-[color:var(--color-muted)]">
        ← All clinics
      </a>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">
        Report preview
      </h1>
      <ClinicNav slug={clinicSlug} active="report" />

      <form method="get" className="mt-6 flex items-end gap-3">
        <label className="block">
          <span className="text-[11px] font-bold tracking-[0.06em] uppercase">
            Month
          </span>
          <input
            name="month"
            type="month"
            defaultValue={month ?? report.period.key}
            className="mt-1.5 rounded-lg border border-[color:var(--color-line)] bg-white px-3 py-2 text-sm outline-none"
          />
        </label>
        <button
          type="submit"
          className="rounded-full bg-[color:var(--color-ink)] px-5 py-2.5 text-sm font-bold text-white"
        >
          Preview
        </button>
      </form>

      {phiError ? (
        <p className="mt-6 rounded-xl border border-[color:var(--color-red)]/30 bg-[color:var(--color-red)]/[0.06] px-4 py-3 text-sm font-semibold">
          ⚠️ The PHI guard would block this send. {phiError}
        </p>
      ) : (
        <p className="mt-6 text-sm text-[color:var(--color-muted)]">
          ✓ Passes the PHI guard — no identifiers, safe for a shared inbox.
          {report.partial
            ? " This period is still in progress, so the figures will move."
            : ""}
        </p>
      )}

      {/* ---------------- Rendered email ---------------- */}
      <section className="mt-8">
        <h2 className="text-sm font-bold tracking-[0.08em] uppercase">
          Subject
        </h2>
        <p className="mt-2 rounded-xl border border-[color:var(--color-line)] bg-white px-4 py-3 text-sm font-medium">
          {rendered.subject}
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-bold tracking-[0.08em] uppercase">
          As it will look
        </h2>
        <div className="mt-3 overflow-hidden rounded-2xl border border-[color:var(--color-line)]">
          {/* srcDoc rather than dangerouslySetInnerHTML: the email is a whole
              document with its own styles, and an iframe keeps them from
              leaking into the console. */}
          <iframe
            title="Report preview"
            srcDoc={rendered.html}
            className="h-[560px] w-full border-0 bg-white"
            sandbox=""
          />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-bold tracking-[0.08em] uppercase">
          Plain text version
        </h2>
        <pre className="mt-3 overflow-x-auto rounded-2xl border border-[color:var(--color-line)] bg-white p-5 font-sans text-sm whitespace-pre-wrap">
          {rendered.text}
        </pre>
      </section>

      <p className="mt-8 text-xs text-[color:var(--color-muted)]">
        Nothing is sent from this page. Delivery runs from the monthly-report
        job, which is switched off until ops turns it on.
      </p>
    </main>
  );
}
