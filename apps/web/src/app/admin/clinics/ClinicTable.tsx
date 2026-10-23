import { Chip, ClinicId, Empty } from "@/components/admin/ui";
import {
  availabilityChip,
  calendarChip,
  channelChip,
  CLINIC_FILTERS,
  reminderChip,
  stageChip,
  transcriptsChip,
  usageChip,
  voiceChip,
  type ChipWords,
  type ClinicFilter,
  type ClinicRow,
} from "@/lib/admin/clinic-rows";
import { clinicTabPath, type IssueTab } from "@/lib/admin/issue-link";

/**
 * Every signed clinic's state at a glance (E1 §2, Clinics): one row per
 * clinic, each column a coloured chip with one or two words, a click on the
 * name opening the clinic's panel and a click on a chip opening the tab that
 * owns it. Under 640 px the same rows are cards (owner, 23 October 2026).
 *
 * The words and tones come from lib/admin/clinic-rows.ts, which is where a
 * column that was not measured becomes "not measured yet"; this file only
 * lays them out. Static markup: no JavaScript but the id's copy button.
 */

const COLUMNS: readonly { label: string; tab: IssueTab }[] = [
  { label: "Stage", tab: "setup" },
  { label: "Channels", tab: "setup" },
  { label: "Availability", tab: "setup" },
  { label: "Calendar", tab: "setup" },
  { label: "Voice agent", tab: "setup" },
  { label: "Transcripts", tab: "deliveries" },
  { label: "Usage", tab: "billing" },
  { label: "Last reminder", tab: "deliveries" },
];

const CHANNEL_NAMES = { web: "web", meta: "meta", voice: "voice" } as const;

function Cell({ chip, href }: { chip: ChipWords; href: string }) {
  return (
    <Chip tone={chip.tone} href={href}>
      {chip.words}
    </Chip>
  );
}

function Channels({ row, href }: { row: ClinicRow; href: string }) {
  if (!row.channels) return <Cell chip={{ tone: "muted", words: "not measured yet" }} href={href} />;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {(["web", "meta", "voice"] as const).map((channel) => (
        <Chip key={channel} tone={channelChip(row.channels![channel])} href={href} title={`${CHANNEL_NAMES[channel]}: ${row.channels![channel]}`}>
          {CHANNEL_NAMES[channel]}
        </Chip>
      ))}
    </span>
  );
}

/** The eight state cells of one row, in column order, each linking to its tab. */
function cells(row: ClinicRow): { label: string; node: React.ReactNode }[] {
  const to = (tab: IssueTab) => clinicTabPath(row.clinicId, tab);
  return [
    { label: "Stage", node: <Cell chip={stageChip(row.stage)} href={row.stage?.kind === "setup" ? to("setup") : to("billing")} /> },
    { label: "Channels", node: <Channels row={row} href={to("setup")} /> },
    { label: "Availability", node: <Cell chip={availabilityChip(row.availability)} href={to("setup")} /> },
    { label: "Calendar", node: <Cell chip={calendarChip(row.calendar)} href={to("setup")} /> },
    { label: "Voice agent", node: <Cell chip={voiceChip(row.voice)} href={to("setup")} /> },
    { label: "Transcripts", node: <Cell chip={transcriptsChip(row.transcripts)} href={to("deliveries")} /> },
    { label: "Usage", node: <Cell chip={usageChip(row.usage)} href={to("billing")} /> },
    { label: "Last reminder", node: <Cell chip={reminderChip(row.lastReminder)} href={to("deliveries")} /> },
  ];
}

function Name({ row }: { row: ClinicRow }) {
  return (
    <>
      <a href={clinicTabPath(row.clinicId, "setup")} className="font-semibold underline-offset-2 hover:underline">
        {row.name}
      </a>
      {row.synthetic ? <span className="text-muted ml-2 text-xs font-semibold uppercase">synthetic</span> : null}
      <ClinicId id={row.clinicId} />
    </>
  );
}

export function ClinicFilters({ counts, current }: { counts: Record<ClinicFilter, number>; current: ClinicFilter }) {
  return (
    <nav aria-label="Filter clinics" className="mt-6 flex flex-wrap gap-2">
      {CLINIC_FILTERS.map((f) => {
        const on = f.id === current;
        return (
          <a
            key={f.id}
            href={f.id === "all" ? "/admin/clinics" : `/admin/clinics?filter=${f.id}`}
            aria-current={on ? "page" : undefined}
            className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3.5 text-sm font-semibold transition-colors ${
              on ? "border-ink bg-ink text-white" : "border-line-strong hover:border-ink"
            }`}
          >
            {f.label}
            <span className={on ? "text-white/70" : "text-muted"}>{counts[f.id]}</span>
          </a>
        );
      })}
    </nav>
  );
}

export function ClinicTable({ rows, filter }: { rows: ClinicRow[]; filter: ClinicFilter }) {
  if (rows.length === 0) {
    return (
      <Empty>
        {filter === "all"
          ? "No clinics. They appear here once someone completes checkout."
          : `No clinics under "${CLINIC_FILTERS.find((f) => f.id === filter)?.label ?? filter}".`}
      </Empty>
    );
  }
  return (
    <>
      {/* 640 px and up: the table. */}
      <div className="border-line mt-4 hidden overflow-x-auto rounded-md border bg-white sm:block">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="text-muted text-xs tracking-[0.06em] uppercase">
            <tr>
              <th scope="col" className="border-line border-b px-4 py-3 font-bold">
                Clinic
              </th>
              {COLUMNS.map((c) => (
                <th key={c.label} scope="col" className="border-line border-b px-3 py-3 font-bold">
                  {c.label}
                </th>
              ))}
              <th scope="col" className="border-line border-b px-3 py-3 font-bold">
                Blocking
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.clinicId} className="border-line border-b align-top last:border-b-0">
                <th scope="row" className="px-4 py-3 font-normal whitespace-nowrap">
                  <Name row={row} />
                </th>
                {cells(row).map((cell) => (
                  <td key={cell.label} className="px-3 py-3">
                    {cell.node}
                  </td>
                ))}
                <td className="text-red-deep max-w-[28ch] px-3 py-3 text-sm font-semibold">{row.blocking ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Under 640 px: the same rows as cards. */}
      <ul className="mt-4 grid gap-3 sm:hidden">
        {rows.map((row) => (
          <li key={row.clinicId} className="border-line rounded-md border bg-white p-4 text-sm">
            <Name row={row} />
            {row.blocking ? <p className="text-red-deep mt-2 font-semibold">{row.blocking}</p> : null}
            <dl className="mt-3 grid gap-1.5">
              {cells(row).map((cell) => (
                <div key={cell.label} className="flex flex-wrap items-center justify-between gap-2">
                  <dt className="text-muted text-xs tracking-[0.06em] uppercase">{cell.label}</dt>
                  <dd>{cell.node}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}
