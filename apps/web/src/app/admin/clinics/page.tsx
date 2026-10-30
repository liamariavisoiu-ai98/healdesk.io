import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { HostStandbyPage } from "@/components/admin/HostStandbyNotice";
import { Failure } from "@/components/admin/ui";
import { CLINIC_FILTERS, clinicFilter, filterClinicRows, type ClinicFilter } from "@/lib/admin/clinic-rows";
import { loadClinicRows, stripReaderPresent } from "@/lib/admin/clinic-strip";
import { requireOperator } from "@/lib/admin/operator";
import { isHostUnreachable } from "@/lib/host/state";

import { ClinicFilters, ClinicTable } from "./ClinicTable";

/**
 * /admin/clinics: every signed clinic's state at a glance (E1 §2), one row
 * each, newest first as apps/app lists them, synthetic clinics behind their
 * own filter chip (owner, 23 October 2026).
 *
 * Four reads, settled independently: the clinic list, the cards (channel
 * states), the health rows (usage under sixty days live) and the strip
 * (lane A2's `listClinicStrip`, behind lib/admin/clinic-strip.ts). A read
 * that failed costs its columns, which print "not measured yet", and is
 * named once above the table; it never takes the list down with it. The
 * guard is on this page, not the layout: a layout is not a security boundary.
 */

export const metadata: Metadata = { title: "Clinics" };
export const dynamic = "force-dynamic";

export default async function ClinicsPage({ searchParams }: { searchParams: Promise<{ filter?: string | string[] }> }) {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const { filter: rawFilter } = await searchParams;
  const filter = clinicFilter(rawFilter);

  const { clinics, cards, health, strip, rows } = await loadClinicRows();
  if ([clinics, cards, health].every(isHostUnreachable)) return <HostStandbyPage title="Clinics" />;
  // The strip read landed and answered: its columns, and which clinics are synthetic, are measured.
  const stripRead = stripReaderPresent() && strip !== null && strip.ok;

  const counts = Object.fromEntries(CLINIC_FILTERS.map((f) => [f.id, filterClinicRows(rows, f.id).length])) as Record<ClinicFilter, number>;

  return (
    <main className="mx-auto w-full max-w-page px-4 py-10 sm:px-8 lg:px-14">
      <h1 className="font-display text-2xl leading-tight font-semibold tracking-[-0.02em]">Clinics</h1>

      {!clinics.ok ? <Failure failure={clinics} what="the clinic list" /> : null}
      {!cards.ok ? <Failure failure={cards} what="the clinics' channel states" /> : null}
      {!health.ok ? <Failure failure={health} what="the clinics' first-weeks usage" /> : null}
      {strip && !strip.ok ? <Failure failure={strip} what="the clinic strip (availability, calendar, voice agent, transcripts, usage, reminders)" /> : null}
      {clinics.ok ? (
        <>
          <ClinicFilters counts={counts} current={filter} stripRead={stripRead} />
          <ClinicTable rows={filterClinicRows(rows, filter)} filter={filter} stripRead={stripRead} />
        </>
      ) : null}
    </main>
  );
}
