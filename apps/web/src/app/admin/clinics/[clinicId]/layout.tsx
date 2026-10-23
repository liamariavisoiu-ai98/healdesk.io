import { notFound, redirect } from "next/navigation";

import { Chip, ClinicId, Failure } from "@/components/admin/ui";
import { stageChip } from "@/lib/admin/clinic-rows";
import { loadClinicRows } from "@/lib/admin/clinic-strip";
import { isUuid } from "@/lib/admin/issue-link";
import { requireOperator } from "@/lib/admin/operator";
import { isHostUnreachable } from "@/lib/host/state";

import { ClinicTabs } from "./ClinicTabs";

/**
 * The clinic panel's shell (E1 §2): one header with the clinic's name, its
 * id to copy, its stage, its specialty and the first thing blocking it, then
 * the five tabs. Each tab below owns one concern and keeps the panel it
 * always had, with the same props, so the panels' tests pass unchanged; only
 * this shell is new.
 *
 * The header is read from the same four reads the Clinics table uses
 * (lib/admin/clinic-strip.ts), so the stage chip here is the chip there. A
 * read that fails costs the header its words, not the tab its panel: the
 * tab reads its own view and says its own failure.
 *
 * Not a security boundary: every tab page calls `requireOperator()` itself
 * (app/admin/layout.tsx says why a layout cannot be one). The call here is
 * for the reads, which ops-client refuses without a session anyway, and it
 * sends a signed-out reader to the door before any header is drawn.
 */
export default async function ClinicLayout({ params, children }: { params: Promise<{ clinicId: string }>; children: React.ReactNode }) {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const { clinicId } = await params;
  if (!isUuid(clinicId)) notFound();
  const id = clinicId.toLowerCase();

  const reads = await loadClinicRows();
  const row = reads.rows.find((r) => r.clinicId === id) ?? null;
  // A list that was read and does not hold this id: there is no such clinic.
  if (reads.clinics.ok && !row) notFound();
  const standby = isHostUnreachable(reads.clinics);
  const stage = row ? stageChip(row.stage) : null;

  return (
    <main className="mx-auto w-full max-w-[1240px] px-4 py-10 sm:px-8 lg:px-14">
      <header>
        <a href="/admin/clinics" className="text-muted text-sm underline underline-offset-2">
          ← Clinics
        </a>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="font-display text-[28px] leading-tight font-semibold tracking-[-0.02em]">{row?.name ?? "Clinic"}</h1>
          {stage ? <Chip tone={stage.tone}>{stage.words}</Chip> : null}
          {row?.synthetic ? <Chip tone="muted">synthetic</Chip> : null}
          {row?.specialty ? <span className="text-muted text-sm">{row.specialty}</span> : null}
        </div>
        <ClinicId id={id} />
        {row?.blocking ? <p className="text-red-deep mt-2 text-sm font-semibold">{row.blocking}</p> : null}
        {!reads.clinics.ok && !standby ? <Failure failure={reads.clinics} what="the clinic's name and stage" /> : null}
        <ClinicTabs clinicId={id} />
      </header>
      {children}
    </main>
  );
}
