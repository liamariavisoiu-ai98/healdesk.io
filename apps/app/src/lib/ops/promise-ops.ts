import { describeError, log } from "@/lib/log";
import { printableBusinessName } from "@/lib/ops/alert-wording/allow-list";
import { notifyOpsOnce, type OpsFields } from "@/lib/ops/notify";
import { requestIdsOnCases } from "@/lib/support/watch";

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
 *     Sheet's random request ids. Since 23 October 2026 (lane N1, the
 *     owner's decision) a newer apps/web also sends `requests`, each id with
 *     the requester's business name and the day our reply was promised by,
 *     so the alert can say who is waiting and since when: the name is
 *     business contact data, never a person's name, address or number, and
 *     one printableBusinessName refuses is dropped and the alert goes
 *     without it. `requestIds` alone is still accepted, from an older
 *     apps/web. Nothing is kept here but the alert. Not audited: it writes
 *     the ops log and no state.
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

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** What may be printed about one request: the business name and the promised day, each only when safe. */
function requestDisplay(value: unknown): { id: string; display: OpsFields } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || !UUID_SHAPED.test(entry.id)) return null;
  const display: Record<string, string> = {};
  const business = printableBusinessName(entry.business);
  if (business) display.business = business;
  if (typeof entry.promisedOn === "string" && ISO_DAY.test(entry.promisedOn) && !Number.isNaN(Date.parse(entry.promisedOn))) {
    display.promisedOn = entry.promisedOn;
  }
  return { id: entry.id, display };
}

export async function opSetupRepliesPastDue(args: Record<string, unknown>): Promise<OpsOutcome> {
  const ids = args.requestIds;
  const requests = args.requests;
  const invalid = () =>
    opsProblem(
      `requestIds must be a list of at most ${MAX_PAST_DUE_IDS} setup request ids.`,
      400,
      "invalid_args",
    );
  if (
    !Array.isArray(ids) ||
    ids.length > MAX_PAST_DUE_IDS ||
    !ids.every((id) => typeof id === "string" && UUID_SHAPED.test(id))
  ) {
    return invalid();
  }
  // `requests` is optional: an older apps/web sends the ids alone. One that is
  // sent must be well formed; a field inside it that is not safe is dropped.
  const display = new Map<string, OpsFields>();
  if (requests !== undefined) {
    if (!Array.isArray(requests) || requests.length > MAX_PAST_DUE_IDS) return invalid();
    for (const request of requests) {
      const read = requestDisplay(request);
      if (!read) return invalid();
      display.set(read.id.toLowerCase(), read.display);
    }
  }
  const unique = [...new Set(ids as string[])];
  for (const requestId of unique) {
    await notifyOpsOnce(
      "setup_request_reply_past_due",
      { requestId, source: "setup_request" },
      display.get(requestId.toLowerCase()) ?? {},
    );
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

/**
 * Queues › Support's list: the chat's promises that have no support case. A
 * chat escalation now opens a case (lane P7a), and the case is the promise:
 * it is worked, snoozed, drafted, alerted and closed on /admin/support, so
 * listing it here as well, beside a "Mark replied" that does not touch the
 * case, said one promise twice. A request the case code never saw (one from
 * before cases, or one whose case could not be opened) stays here with its
 * mark, which still works, and the old watch still alerts it.
 */
export async function opListSupportRequests(): Promise<OpsOutcome> {
  const { rows: all, failures } = await listSupportRequests(new Date());
  const onCases = await requestIdsOnCases(all.map((r) => r.requestId));
  const rows = all.filter((r) => !onCases.has(r.requestId));
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
