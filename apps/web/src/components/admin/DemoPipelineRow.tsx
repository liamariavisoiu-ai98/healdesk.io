import { claimedShare, DEMO_SOURCES, PIPELINE_ROWS, type DemoPipeline, type PipelineWindow } from "@/lib/demo/pipeline";

/**
 * The demo pipeline in one strip of plain words, at the top of /admin/demos:
 *
 *   Demos · 7 days: 12 requested → 9 built → 2 claimed (22%) · 30 days: 40
 *   requested → 31 built → 6 claimed (19%) · 20 expired unclaimed · now: 3
 *   live · 1 held · 2 failed · 1 stalled
 *   Claimed per built, last 30 days, by source: operator 4/20 · outreach 2/9 · homepage 0/2
 *
 * The numbers are lib/demo/pipeline.ts's; this decides whether the reader is
 * told them. A register that could not be read prints an em-dash in every
 * place a number would go and says so underneath, never a zero: a quiet
 * month and a failed read must not look alike (the rule every admin panel
 * keeps, components/admin/honesty.test.ts). A share with nothing built to
 * convert from is an em-dash too, not 0%.
 *
 * Presentational, so the admin home can place the same strip from its own
 * loader. No chart: eight numbers a person can read at a glance.
 */

/** Shown wherever a number could not be measured. Never a zero. */
const ABSENT = "—";

const PERCENT = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });

function num(value: number | null | undefined): string {
  return typeof value === "number" ? String(value) : ABSENT;
}

function shareOf(window: PipelineWindow | null): string {
  const share = window ? claimedShare(window) : null;
  return share === null ? ABSENT : PERCENT.format(share);
}

const SOURCE_LABEL: Record<(typeof DEMO_SOURCES)[number], string> = {
  operator: "operator",
  outreach: "outreach",
  homepage: "homepage",
};

export type DemoPipelineRowProps = {
  /** Null when the register could not be read: every number prints as an em-dash. */
  pipeline: DemoPipeline | null;
};

export function DemoPipelineRow({ pipeline }: DemoPipelineRowProps) {
  const week = pipeline?.windows.find((w) => w.days === 7) ?? null;
  const month = pipeline?.windows.find((w) => w.days === 30) ?? null;
  const now = pipeline?.now ?? null;

  return (
    <section aria-label="Demo pipeline" className="border-line mt-6 rounded-md border bg-white px-4 py-3 text-[14.4px] sm:px-5">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-semibold">Demos</span>
        <span aria-hidden="true">·</span>
        <span>
          7 days: {num(week?.requested)} requested → {num(week?.built)} built → {num(week?.claimed)} claimed ({shareOf(week)})
        </span>
        <span aria-hidden="true">·</span>
        <span>
          30 days: {num(month?.requested)} requested → {num(month?.built)} built → {num(month?.claimed)} claimed ({shareOf(month)}) ·{" "}
          {num(month?.expired)} expired unclaimed
        </span>
        <span aria-hidden="true">·</span>
        <span>
          now: {num(now?.live)} live · {num(now?.held)} held · {num(now?.failed)} failed · {num(now?.stalled)} stalled
        </span>
      </p>
      <p className="text-muted mt-1">
        Claimed per built, last 30 days, by source:{" "}
        {DEMO_SOURCES.map((source, i) => {
          const own = month?.bySource.find((b) => b.source === source) ?? null;
          return (
            <span key={source}>
              {i > 0 ? " · " : ""}
              {SOURCE_LABEL[source]} {num(own?.claimed)}/{num(own?.built)}
            </span>
          );
        })}
        {pipeline?.truncated ? ` · newest ${PIPELINE_ROWS} rows only, so the 30-day numbers are a floor` : ""}
      </p>
      {pipeline === null ? (
        <p className="text-red-deep mt-1 font-semibold">The register could not be read, so nothing here is measured.</p>
      ) : null}
    </section>
  );
}
