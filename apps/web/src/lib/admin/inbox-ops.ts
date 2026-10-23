import { EXTEND_DEADLINE_MAX_DAYS, isInboxButtonOp } from "@/lib/admin/inbox-button-ops";
import { isUuid } from "@/lib/admin/issue-link";
import {
  deleteRecordedCall,
  extendSetupDeadline,
  goLive,
  markSupportReplied,
  requestSiteReread,
  rerunPracticeQuestions,
  resendTranscript,
  setUsageAlerts,
  type OpsResult,
} from "@/lib/admin/ops-client";
import type { InboxButton, OpsInbox } from "@/lib/admin/strip-types";

/**
 * The one button on a Home row, when it is an operation rather than a link:
 * a closed switch from the op's name (lib/admin/inbox-button-ops.ts) to the
 * typed ops-client function, with every argument checked as an id, an enum
 * or a bounded number before anything is signed.
 *
 * The browser never sends a button. The page's server action receives a row
 * id, rebuilds the inbox on the server and runs the button of the row it
 * finds there (`runInboxRow`), so the arguments are always the server's own;
 * a forged button, or a row id that names no op row, is refused by name.
 *
 * Server-only: it imports ops-client.
 */

export type InboxOpOutcome = { status: string; message?: string; auditRecorded?: boolean };

const refused = (message: string): OpsResult<InboxOpOutcome> => ({ ok: true, data: { status: "refused", message } });

function id(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return isUuid(value) ? value.toLowerCase() : null;
}

/** Run one op button. Exported for its tests; the page goes through `runInboxRow`. */
export async function runInboxOp(button: Extract<InboxButton, { kind: "op" }>): Promise<OpsResult<InboxOpOutcome>> {
  if (!isInboxButtonOp(button.op)) return refused(`This console cannot run "${String(button.op)}" yet: open the clinic instead.`);
  const args = button.args;
  const clinicId = id(args, "clinicId");
  if (!clinicId) return refused("That row names no clinic id, so nothing ran.");

  switch (button.op) {
    case "resendTranscript": {
      const conversationId = id(args, "conversationId");
      if (!conversationId) return refused("That row names no conversation id, so nothing ran.");
      return resendTranscript(clinicId, conversationId);
    }
    case "goLive":
      return goLive(clinicId);
    case "extendSetupDeadline": {
      const days = Number(args.days);
      const fromDeadline = args.fromDeadline;
      if (
        !Number.isInteger(days) ||
        days < 1 ||
        days > EXTEND_DEADLINE_MAX_DAYS ||
        typeof fromDeadline !== "string" ||
        Number.isNaN(Date.parse(fromDeadline))
      ) {
        return refused(`That extension names no whole number of days from 1 to ${EXTEND_DEADLINE_MAX_DAYS}, or no deadline, so nothing ran.`);
      }
      return extendSetupDeadline(clinicId, { days, fromDeadline });
    }
    case "rerunPracticeQuestions":
      return rerunPracticeQuestions(clinicId);
    case "requestSiteReread":
      return requestSiteReread(clinicId);
    case "deleteRecordedCall": {
      const alertId = id(args, "alertId");
      if (!alertId) return refused("That row names no alert id, so nothing ran.");
      return deleteRecordedCall(clinicId, alertId);
    }
    case "markSupportReplied": {
      const requestId = id(args, "requestId");
      if (!requestId) return refused("That row names no request id, so nothing ran.");
      return markSupportReplied(clinicId, requestId);
    }
    case "setUsageAlerts":
      return setUsageAlerts(clinicId, args.on === true);
  }
}

/**
 * The row's button, run from the inbox the server just built: the browser
 * sent only the row's id. A row that is not there, or whose button is a
 * link, runs nothing.
 */
export async function runInboxRow(inbox: OpsInbox, rowId: unknown): Promise<OpsResult<InboxOpOutcome>> {
  if (typeof rowId !== "string" || rowId.length === 0 || rowId.length > 200) return refused("That row could not be read, so nothing ran.");
  const row = inbox.rows.find((r) => r.id === rowId);
  if (!row) return refused("That row is no longer on the list. Reload and look again; nothing ran.");
  if (row.button.kind !== "op") return refused("That row has a link, not an action, so nothing ran.");
  return runInboxOp(row.button);
}
