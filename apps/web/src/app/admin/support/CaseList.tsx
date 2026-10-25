import { onDay, whenWords } from "@/components/admin/approval-words";
import {
  ageWords,
  CASE_SECTIONS,
  CLOSED_REASON_WORDS,
  hiddenWords,
  inboundWords,
  REPLY_WAITING,
  replyByWords,
  sectionOf,
  SOURCE_WORDS,
  STATE_WORDS,
  topicWords,
  URGENCY_TONE,
  URGENCY_WORDS,
  type CaseSectionId,
} from "@/components/admin/support-words";
import { Failure, Section, Tag } from "@/components/admin/ui";
import { clinicTabPath } from "@/lib/admin/issue-link";
import type { OpsResult, SupportCaseRowView, SupportCasesView, SupportReplyApprovalItem } from "@/lib/admin/ops-client";

/**
 * The Support console's list (ops automation Phase 7, lane P7d; the cases
 * are lane P7a's, apps/app lib/ops/support-case-ops.ts listSupportCases):
 * every case across clinics in four sections, in the order the owner works
 * them: "Needs you" (apps/app's NEEDS_US_STATES: new, drafting, drafted,
 * needs_edit), "Waiting on the clinic", "Snoozed", and "Closed (30 days)"
 * folded shut. A row is the clinic's name, linked to its Care tab, the
 * case's ref as selectable text, its source, topic and symptom in words, an
 * urgency badge, its age, its reply-by day (red once past while it still
 * needs us), its assignee, and the counts of patient details hidden when
 * any were (none on a chat case: it carries no words). A row whose reply
 * waits in the approval inbox for the owner's Send says so.
 *
 * Never a word of a conversation or an email: the list carries ids, states,
 * dates and counts, and has nowhere to put text (owner decision D15).
 */

export type WaitingReplies = OpsResult<{ items: SupportReplyApprovalItem[]; partial: string[] }>;

/** The cases whose reply waits for the owner's Send, by case id (the items' packets name their case). */
export function waitingByCase(waiting: WaitingReplies): ReadonlySet<string> {
  if (!waiting.ok) return new Set();
  return new Set(waiting.data.items.flatMap((item) => (item.packet ? [item.packet.facts.caseId] : [])));
}

function CaseRow({ row, replyWaiting }: { row: SupportCaseRowView; replyWaiting: boolean }) {
  const hidden = hiddenWords(row.hidden);
  return (
    <li className="border-line rounded-md border bg-white p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {row.clinicId ? (
          <a href={clinicTabPath(row.clinicId, "care")} className="font-semibold underline underline-offset-2">
            {row.clinicName ?? "A clinic with no printable name"}
          </a>
        ) : (
          <span className="font-semibold">No clinic yet</span>
        )}
        <code className="font-mono text-[15px] select-all">{row.ref}</code>
        <Tag tone={URGENCY_TONE[row.urgency]}>{URGENCY_WORDS[row.urgency]}</Tag>
        <a href={`/admin/support/${row.id}`} className="text-sm font-semibold underline underline-offset-2">
          Open case
        </a>
      </div>
      <p className="mt-1 text-[15.6px]">{topicWords(row.category, row.symptom)}</p>
      <p className="text-muted mt-1 text-sm">
        {SOURCE_WORDS[row.source]} · {STATE_WORDS[row.state]} · {ageWords(row.ageHours)} ·{" "}
        <span className={row.pastDue ? "text-red-deep font-semibold" : undefined}>{replyByWords(row)}</span>
        {row.assigneeLabel ? ` · with ${row.assigneeLabel}` : ""}
      </p>
      {row.state === "snoozed" && row.snoozedUntil ? <p className="text-muted mt-1 text-sm">Comes back {whenWords(row.snoozedUntil)}.</p> : null}
      {row.state === "closed" && row.closedAt ? (
        <p className="text-muted mt-1 text-sm">
          Closed {onDay(row.closedAt)}{row.closedReason ? `: ${CLOSED_REASON_WORDS[row.closedReason]}` : ""}.
        </p>
      ) : null}
      {hidden ? <p className="text-red-deep mt-1 text-sm font-semibold">{hidden}</p> : null}
      {replyWaiting ? <p className="text-done mt-1 text-sm font-semibold">{REPLY_WAITING}</p> : null}
      <p className="text-muted mt-1 text-sm">{inboundWords(row)}</p>
    </li>
  );
}

function Rows({ rows, waiting }: { rows: SupportCaseRowView[]; waiting: ReadonlySet<string> }) {
  return (
    <ul className="mt-3 grid gap-3">
      {rows.map((row) => (
        <CaseRow key={row.id} row={row} replyWaiting={waiting.has(row.id)} />
      ))}
    </ul>
  );
}

type Groups = ReadonlyMap<CaseSectionId, SupportCaseRowView[]>;

/** One open section: its title with the count, its rows, or its one empty line. The id is written literally so the link guards can read it. */
function Group({ id, groups, waiting }: { id: Exclude<CaseSectionId, "closed">; groups: Groups; waiting: ReadonlySet<string> }) {
  const section = CASE_SECTIONS.find((s) => s.id === id)!;
  const rows = groups.get(id)!;
  return (
    <Section id={id} title={`${section.title} (${rows.length})`}>
      {rows.length === 0 ? <p className="text-sm">{section.empty}</p> : <Rows rows={rows} waiting={waiting} />}
    </Section>
  );
}

export function CaseList({ cases, waiting }: { cases: OpsResult<SupportCasesView>; waiting: WaitingReplies }) {
  if (!cases.ok) return <Failure failure={cases} what="the support cases" />;
  const byCase = waitingByCase(waiting);
  const groups = new Map<CaseSectionId, SupportCaseRowView[]>(CASE_SECTIONS.map((s) => [s.id, []]));
  for (const row of cases.data.rows) groups.get(sectionOf(row.state))!.push(row);
  const closed = CASE_SECTIONS.find((s) => s.id === "closed")!;
  const closedRows = groups.get("closed")!;
  return (
    <>
      {cases.data.truncated ? (
        <p role="status" className="text-red-deep mt-4 text-sm font-semibold">
          The list is cut at {cases.data.count} cases; the ones that need you come first, the most urgent at the top.
        </p>
      ) : null}
      {!waiting.ok ? <Failure failure={waiting} what="the replies waiting for your Send" /> : null}
      <Group id="needs-you" groups={groups} waiting={byCase} />
      <Group id="waiting-on-the-clinic" groups={groups} waiting={byCase} />
      <Group id="snoozed" groups={groups} waiting={byCase} />
      <section id="closed" className="border-line mt-8 scroll-mt-24 rounded-md border bg-white p-5">
        <details>
          <summary className="cursor-pointer text-sm font-bold tracking-[0.08em] uppercase">
            {closed.title} ({closedRows.length})
          </summary>
          {closedRows.length === 0 ? <p className="text-muted mt-3 text-sm">{closed.empty}</p> : <Rows rows={closedRows} waiting={byCase} />}
        </details>
      </section>
    </>
  );
}
