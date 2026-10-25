"use client";

import { onDay, whenWords } from "@/components/admin/approval-words";
import { generatedByWords, HEADLINE_WORDS } from "@/components/admin/pack-words";
import { ActionButton, Failure, Section } from "@/components/admin/ui";
import type { CompliancePackHeadline, CompliancePackSummaryView, GenerateCompliancePackOutcome, OpsResult } from "@/lib/admin/ops-client";

/**
 * The list of stored compliance packs (ops automation lane P6j; the
 * operations are lane P6h's, apps/app lib/ops/pack-ops.ts): the recent
 * weeks, newest first, each either a link to its stored pack with the five
 * headline numbers (a number that could not be read says so, never a zero)
 * or "not stored" with "Make this week's pack", which asks apps/app to make
 * and store that week's pack now (generateCompliancePack). apps/app refuses
 * a week that has not ended, a week already stored (a stored pack is never
 * made again) and, inside the week's first two days, a week with a section
 * it cannot read. Older stored packs follow.
 */

export type MakePack = (week: string) => Promise<OpsResult<GenerateCompliancePackOutcome>>;

export const MAKE_WORDS = "Makes and stores this week's pack now from the host's records, read as of the week's end. A stored pack is never made again.";

/** What apps/app answered once the pack was stored. */
export function madeWords(data: Extract<GenerateCompliancePackOutcome, { status: "stored" }>): string {
  return `Stored the pack for the week of ${onDay(data.weekStart)}${data.unreadSections > 0 ? `, with ${data.unreadSections} ${data.unreadSections === 1 ? "section" : "sections"} that could not be read, marked as missing` : ""}. Open it from the list.`;
}

function headlineCells(headline: CompliancePackHeadline | null): React.ReactNode {
  return (Object.keys(HEADLINE_WORDS) as (keyof CompliancePackHeadline)[]).map((key) => {
    const value = headline === null ? null : headline[key];
    return (
      <td key={key} className="py-1.5 pr-3 text-right tabular-nums" title={HEADLINE_WORDS[key].label}>
        {value === null ? <span className="text-muted">not read</span> : value}
      </td>
    );
  });
}

export function PackList({ weeks, packs, onMake }: { weeks: string[]; packs: OpsResult<CompliancePackSummaryView[]>; onMake: MakePack }) {
  const stored = new Map(packs.ok ? packs.data.map((p) => [p.weekStart, p]) : []);
  const recent = new Set(weeks);
  const older = packs.ok ? packs.data.filter((p) => !recent.has(p.weekStart)) : [];
  return (
    <Section id="packs" title="Packs by week">
      {!packs.ok ? <Failure failure={packs} what="the stored packs" /> : null}
      <p className="text-muted text-sm">
        One pack a week, stored at 07:00 New York on the Monday after it by the compliance-pack job while that job is on. The headline numbers are as the pack recorded them; open a week for every section.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-muted text-[13.2px] font-bold tracking-[0.06em] uppercase">
              <th className="py-1 pr-3">Week of</th>
              <th className="py-1 pr-3">Stored</th>
              {(Object.keys(HEADLINE_WORDS) as (keyof CompliancePackHeadline)[]).map((key) => (
                <th key={key} className="py-1 pr-3 text-right">
                  {HEADLINE_WORDS[key].label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-line divide-y">
            {weeks.map((week) => {
              const pack = stored.get(week);
              if (pack) return <PackRow key={week} pack={pack} />;
              return (
                <tr key={week}>
                  <td className="py-1.5 pr-3 font-semibold">{onDay(week)}</td>
                  <td className="py-1.5 pr-3" colSpan={6}>
                    {packs.ok ? (
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="text-muted">Not stored.</span>
                        <ActionButton
                          label="Make this week's pack"
                          confirm={MAKE_WORDS}
                          run={() => onMake(week)}
                          done={(data) => (data.status === "stored" ? madeWords(data) : null)}
                        />
                      </div>
                    ) : (
                      <span className="text-muted">Not known: the stored packs could not be read.</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {older.map((pack) => (
              <PackRow key={pack.weekStart} pack={pack} />
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function PackRow({ pack }: { pack: CompliancePackSummaryView }) {
  return (
    <tr>
      <td className="py-1.5 pr-3">
        <a href={`/admin/compliance/pack/${pack.weekStart}`} className="font-semibold underline underline-offset-2">
          {onDay(pack.weekStart)}
        </a>
      </td>
      <td className="py-1.5 pr-3">
        {whenWords(pack.generatedAt)} by {generatedByWords(pack.generatedBy)}
      </td>
      {headlineCells(pack.headline)}
    </tr>
  );
}
