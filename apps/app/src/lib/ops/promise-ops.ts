import { describeError, log } from "@/lib/log";
import { notifyOpsOnce } from "@/lib/ops/notify";

import {
  audit,
  clinicById,
  ok,
  opsProblem,
  stringArg,
  UUID_SHAPED,
  type Operator,
  type OpsOutcome,
} from "./api";
import {
  listSupportRequests,
  SUPPORT_REPLIED_EVENT,
  supportRepliedAt,
  supportRequestExists,
} from "./support-replies";

/**
 * The ops operations for dated promises (WP5), kept beside the ops API's
 * dispatch rather than in it (lib/ops/api.ts names them and calls these).
 *
 *   - `setupRepliesPastDue`, machine to machine like emailQuota: apps/web's
 *     daily cron (api/cron/setup-replies) found setup requests in the
 *     marketing Sheet still unanswered past the day P2 promised a reply by,
 *     and hands over their ids. Each raises `setup_request_reply_past_due`
 *     once, ever, through the ops log, so it lands in the same inbox, the
 *     same dedupe and the same digest as every other alert. The ids are the
 *     Sheet's random request ids; nothing else crosses, and nothing is kept
 *     here but the alert. Not audited: it writes the ops log and no state.
 *   - `listSupportRequests`, a read for /admin/support: the support chat's
 *     escalations of the last 30 days, with the day L25 promised a reply by
 *     and whether one is marked. Ids, a topic code and dates.
 *   - `markSupportReplied`, the operator's mark that hello@ replied to one
 *     (lib/ops/support-replies.ts): one security event naming the clinic and
 *     the request, written by the ops API's own audit, which is the mark.
 *     Refused for a request the clinic never made; a second mark changes
 *     nothing.
 */

/** At most this many ids in one call: the cron's daily list is a handful. */
export const MAX_PAST_DUE_IDS = 50;

export async function opSetupRepliesPastDue(args: Record<string, unknown>): Promise<OpsOutcome> {
  const ids = args.requestIds;
  if (
    !Array.isArray(ids) ||
    ids.length > MAX_PAST_DUE_IDS ||
    !ids.every((id) => typeof id === "string" && UUID_SHAPED.test(id))
  ) {
    return opsProblem(
      `requestIds must be a list of at most ${MAX_PAST_DUE_IDS} setup request ids.`,
      400,
      "invalid_args",
    );
  }
  const unique = [...new Set(ids as string[])];
  for (const requestId of unique) {
    await notifyOpsOnce("setup_request_reply_past_due", { requestId, source: "setup_request" });
  }
  return ok({ raised: unique.length });
}

export type SupportRequestView = {
  clinicId: string;
  clinicSlug: string | null;
  requestId: string;
  topic: string;
  replyByOn: string;
  askedAt: string;
  repliedAt: string | null;
  pastDue: boolean;
};

export async function opListSupportRequests(): Promise<OpsOutcome> {
  const { rows, failures } = await listSupportRequests(new Date());
  const views: SupportRequestView[] = [];
  for (const row of rows.slice(0, 200)) {
    const clinic = await clinicById(row.clinicId);
    views.push({
      clinicId: row.clinicId,
      clinicSlug: clinic?.slug ?? null,
      requestId: row.requestId,
      topic: row.topic,
      replyByOn: row.replyByOn,
      askedAt: row.askedAt.toISOString(),
      repliedAt: row.repliedAt ? row.repliedAt.toISOString() : null,
      pastDue: row.pastDue,
    });
  }
  return ok({ requests: views, unreadClinics: failures });
}

export async function opMarkSupportReplied(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinicId = stringArg(args, "clinicId", 64);
  const requestId = stringArg(args, "requestId", 64);
  if (!clinicId || !UUID_SHAPED.test(clinicId) || !requestId || !UUID_SHAPED.test(requestId)) {
    return opsProblem("A clinic id and a support request id are required.", 400, "invalid_args");
  }
  try {
    if (!(await clinicById(clinicId)) || !(await supportRequestExists(clinicId, requestId))) {
      return ok({ status: "not_found" });
    }
    const already = await supportRepliedAt(clinicId, requestId);
    if (already) return ok({ status: "already", repliedAt: already.toISOString() });
    const recorded = await audit(operator, SUPPORT_REPLIED_EVENT, { clinicId, requestId });
    if (!recorded) return opsProblem("The reply could not be recorded.", 500, "failed");
    return ok({ status: "marked" });
  } catch (error) {
    log.error("support reply not marked", { clinicId, requestId, error: describeError(error) });
    return opsProblem("The reply could not be recorded.", 500, "failed");
  }
}
