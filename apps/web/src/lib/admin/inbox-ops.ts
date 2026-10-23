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
import type { InboxButton } from "@/lib/admin/strip-types";

/**
 * The one button on a Home row, when it is an operation rather than a link
 * (`InboxButton`, kind "op"): a closed switch from the op's name to the typed
 * ops-client function, with every argument checked as an id, an enum or a
 * number before anything is signed. An op this console does not know is
 * refused by name, so a row apps/app sends ahead of this file reads as "not
 * yet" rather than running something unintended. Nothing is dispatched by
 * string into ops-client.
 *
 * Server-only: it imports ops-client.
 */

export type InboxOpOutcome = { status: string; message?: string; auditRecorded?: boolean };

const refused = (message: string): OpsResult<InboxOpOutcome> => ({ ok: true, data: { status: "refused", message } });

function id(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return isUuid(value) ? value.toLowerCase() : null;
}

export async function runInboxOp(button: Extract<InboxButton, { kind: "op" }>): Promise<OpsResult<InboxOpOutcome>> {
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
      if (!Number.isInteger(days) || days < 1 || days > 90 || typeof fromDeadline !== "string" || Number.isNaN(Date.parse(fromDeadline))) {
        return refused("That extension names no whole number of days or no deadline, so nothing ran.");
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
    default:
      return refused(`This console cannot run "${button.op}" yet: open the clinic instead.`);
  }
}
