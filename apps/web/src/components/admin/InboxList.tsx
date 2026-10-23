"use client";

import { ActionButton, Chip, ClinicId } from "@/components/admin/ui";
import type { OpsResult } from "@/lib/admin/ops-client";
import type { InboxButton, InboxRow, OpsInbox } from "@/lib/admin/strip-types";

/**
 * Home's one list (E1 §2): each row is a count, one sentence, the clinic when
 * there is one (name and copyable id) and one button; nothing else. The empty
 * state is one line with the time of the read. A source that could not be
 * read is one line too, "Could not read X", and never a quiet zero.
 *
 * Presentational: the page reads, this draws. The op button's work goes
 * through the page's server action (lib/admin/inbox-ops.ts), ids only.
 */

export type RunInboxOp = (button: Extract<InboxButton, { kind: "op" }>) => Promise<OpsResult<{ status: string; message?: string; auditRecorded?: boolean }>>;

/** "09:12", the UTC clock of the read. */
function clock(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "an unknown time" : `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")} UTC`;
}

function Button({ button, run }: { button: InboxButton; run: RunInboxOp }) {
  if (button.kind === "link") {
    return (
      <a href={button.href} className="border-line-strong hover:border-ink inline-flex min-h-9 shrink-0 items-center rounded-full border px-4 text-sm font-bold transition-colors">
        {button.label}
      </a>
    );
  }
  return <ActionButton label={button.label} run={() => run(button)} done={() => "Done."} />;
}

export function InboxRowView({ row, run }: { row: InboxRow; run: RunInboxOp }) {
  return (
    <li id={row.id} className="border-line flex flex-wrap items-start gap-x-4 gap-y-2 rounded-md border bg-white px-4 py-3 text-sm">
      <Chip tone={row.tone}>{String(row.count)}</Chip>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{row.sentence}</p>
        {row.clinic ? (
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
            <span className="text-muted">{row.clinic.name}</span>
            <ClinicId id={row.clinic.id} />
          </div>
        ) : null}
      </div>
      <Button button={row.button} run={run} />
    </li>
  );
}

export function InboxList({ inbox, run }: { inbox: OpsInbox; run: RunInboxOp }) {
  return (
    <div className="mt-6">
      {inbox.unreadable.map((u) => (
        <p key={u.source} role="status" className="text-red-deep mt-2 text-sm font-semibold">
          Could not read {u.source}: {u.reason}
        </p>
      ))}
      {inbox.rows.length === 0 ? (
        <p className="text-muted mt-4 text-sm">Nothing needs you. Last checked {clock(inbox.checkedAt)}.</p>
      ) : (
        <ul className="mt-4 grid gap-2">
          {inbox.rows.map((row) => (
            <InboxRowView key={row.id} row={row} run={run} />
          ))}
        </ul>
      )}
      {inbox.rows.length > 0 ? <p className="text-muted mt-3 text-xs">Last checked {clock(inbox.checkedAt)}.</p> : null}
    </div>
  );
}
