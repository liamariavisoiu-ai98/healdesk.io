import { describeError, log } from "@/lib/log";

import { listClinics } from "../clinics";
import { ok, opsProblem, type Operator, type OpsOutcome } from "../api";

import { INBOX_SOURCES } from "./sources";
import type { InboxContext, InboxRow, InboxSource, OpsInbox, Tone } from "./types";

/**
 * Run every inbox source and order what they found.
 *
 * Each source is read on its own: one that throws is logged by its name and
 * the error's kind (never its message, which can carry a statement's bound
 * values) and reported in `unreadable`, and the others still render. Nothing
 * that was not read becomes a zero.
 *
 * Order: the earliest `dueAt` first (rows with none after every dated one),
 * then tone (bad, warn, info, then the rest), then the larger count, then id,
 * so the same read always lists the same way.
 */
export async function readOpsInbox(
  operator: Operator,
  options: { now?: Date; sources?: readonly InboxSource[] } = {},
): Promise<OpsInbox> {
  const now = options.now ?? new Date();
  let names: Promise<ReadonlyMap<string, string>> | null = null;
  const ctx: InboxContext = {
    now,
    operator,
    actor: { type: "service", serviceName: operator.email },
    request: operator.request,
    clinicNames() {
      names ??= listClinics().then((list) => new Map(list.map((c) => [c.id, c.name])));
      return names;
    },
  };

  const rows: InboxRow[] = [];
  const unreadable: OpsInbox["unreadable"] = [];
  for (const source of options.sources ?? INBOX_SOURCES) {
    try {
      const result = await source.read(ctx);
      rows.push(...result.rows);
      if (result.partial) unreadable.push({ source: source.name, reason: result.partial });
    } catch (error) {
      log.error("ops inbox source unreadable", { resource: source.name, error: describeError(error) });
      unreadable.push({ source: source.name, reason: "The read failed." });
    }
  }

  return { rows: orderInbox(rows), checkedAt: now.toISOString(), unreadable };
}

const TONE_RANK: Record<Tone, number> = { bad: 0, warn: 1, info: 2, ok: 3, muted: 4 };

export function orderInbox(rows: readonly InboxRow[]): InboxRow[] {
  const due = (row: InboxRow) => {
    const at = row.dueAt ? Date.parse(row.dueAt) : Number.NaN;
    return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
  };
  return [...rows].sort(
    (a, b) =>
      due(a) - due(b) ||
      TONE_RANK[a.tone] - TONE_RANK[b.tone] ||
      b.count - a.count ||
      a.id.localeCompare(b.id),
  );
}

/**
 * The ops operation: no arguments, and any argument is refused. A read that
 * changes nothing, but not one that writes nothing: two sources call
 * readers that record an access row as they always do (clinicHealth's
 * "clinic_health" read of conversations, and listRecordingAlerts' read of
 * a clinic's open Retell alerts), each attributed to the operator, never to
 * a job. The queues source writes none.
 */
export async function opOpsInbox(args: Record<string, unknown>, operator: Operator): Promise<OpsOutcome> {
  if (Object.keys(args).length > 0) return opsProblem("opsInbox takes no arguments.", 400, "invalid_args");
  return ok(await readOpsInbox(operator));
}
