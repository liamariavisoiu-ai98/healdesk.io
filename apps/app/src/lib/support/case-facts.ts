import { and, desc, gt, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { opsAlerts } from "@/db/schema";
import type { ActorContext, RequestContext } from "@/lib/audit";
import { listTranscriptDeliveries } from "@/lib/conversations/transcript-outbox";
import { describeError, log } from "@/lib/log";
import { withTenant } from "@/lib/tenant";

import { readAccountState } from "./account-reader";
import type { AccountState } from "./account-state";

/**
 * The facts panel of a support case (design E5 §2.1 "Triage" and §2.5): the
 * clinic's state as the console shows it beside the case, read from the
 * existing readers, ids, states, counts and dates only. Never the clinic's
 * own words and never a patient (owner, D15).
 *
 *   - `account`: get_account_state's facts (readAccountState, the reader the
 *     chat answers from and the escalation emails to hello@), less the
 *     clinic's phone numbers, which the console shows on the clinic's own
 *     pages: a flag says whether each is set;
 *   - `alerts`: the ops alerts raised about the clinic in the last 14 days,
 *     as event names and times;
 *   - `transcripts`: how the clinic's transcript emails stand over the same
 *     14 days, as counts by status.
 *
 * Each part reads on its own: one that fails is null, and the rest still
 * show. Lane P7b's drafter reads the same facts for its tools.
 */

export const FACTS_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const ALERTS_MAX = 50;

export type CaseAccountFacts = Omit<AccountState, "publishedPhoneE164" | "directLineE164" | "clinicName"> & {
  isPublishedPhoneSet: boolean;
  isDirectLineSet: boolean;
};

export type CaseFacts = {
  days: number;
  account: CaseAccountFacts | null;
  alerts: { event: string; raisedAt: string; lastRaisedAt: string; repeats: number }[] | null;
  transcripts: Record<string, number> | null;
};

/** The console's projection of the account state: no phone number crosses, a flag does. */
export function accountFacts(account: AccountState): CaseAccountFacts {
  const { publishedPhoneE164, directLineE164, clinicName: _name, ...rest } = account;
  void _name;
  return { ...rest, isPublishedPhoneSet: publishedPhoneE164 !== null, isDirectLineSet: directLineE164 !== null };
}

export async function readCaseFacts(input: {
  clinicId: string;
  actor: ActorContext;
  request?: RequestContext;
  now: Date;
}): Promise<CaseFacts> {
  const since = new Date(input.now.getTime() - FACTS_DAYS * DAY_MS);

  const account = await readAccountState({ clinicId: input.clinicId, userId: null, actor: input.actor, now: input.now })
    .then((read) => (read ? accountFacts(read.account) : null))
    .catch((error: unknown) => {
      log.warn("support case facts: account not read", { clinicId: input.clinicId, error: describeError(error) });
      return null;
    });

  const alerts = await unsafeDb
    .select({
      event: opsAlerts.event,
      raisedAt: opsAlerts.raisedAt,
      lastRaisedAt: opsAlerts.lastRaisedAt,
      repeats: opsAlerts.repeats,
    })
    .from(opsAlerts)
    .where(and(sql`${opsAlerts.fields}->>'clinicId' = ${input.clinicId}`, gt(opsAlerts.lastRaisedAt, since)))
    .orderBy(desc(opsAlerts.lastRaisedAt), desc(opsAlerts.id))
    .limit(ALERTS_MAX)
    .then((rows) =>
      rows.map((r) => ({
        event: r.event,
        raisedAt: r.raisedAt.toISOString(),
        lastRaisedAt: r.lastRaisedAt.toISOString(),
        repeats: r.repeats,
      })),
    )
    .catch((error: unknown) => {
      log.warn("support case facts: alerts not read", { clinicId: input.clinicId, error: describeError(error) });
      return null;
    });

  const transcripts = await withTenant(
    { clinicId: input.clinicId, actor: input.actor, request: input.request },
    async (tx) => {
      const listed = await listTranscriptDeliveries(tx, FACTS_DAYS, 1);
      tx.audit.record({
        action: "read",
        resourceType: "transcript_email",
        resultCount: 0,
        metadata: { purpose: "support_case_facts", sinceDays: FACTS_DAYS },
      });
      return { ...listed.counts } as Record<string, number>;
    },
  ).catch((error: unknown) => {
    log.warn("support case facts: transcripts not read", { clinicId: input.clinicId, error: describeError(error) });
    return null;
  });

  return { days: FACTS_DAYS, account, alerts, transcripts };
}
