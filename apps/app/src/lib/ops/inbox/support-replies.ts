import { inArray } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { supportCases } from "@/db/schema";
import { NEEDS_US_STATES } from "@/lib/support/case-vocab";
import { requestIdsOnCases } from "@/lib/support/watch";
import { replyByPassed } from "@/lib/reply-by";

import { listSupportRequests } from "../support-replies";

import type { InboxRow, InboxSource } from "./types";

/**
 * What we owe a clinic in reply, one row per clinic, due the earliest day we
 * promised. Two sources, never counting one promise twice (lane P7e):
 *   - the support cases that still need us (new, drafting, drafted, waiting
 *     for an edit), which are where every chat escalation lands now;
 *   - the chat's escalations recorded on no case (listSupportRequests) with
 *     no reply marked, as before.
 * The topic is not carried: it is the clinic's own category, and the page
 * the row opens shows it. A case with no clinic yet has no row of its own
 * clinic: it is counted under "a case not matched to a clinic".
 */
const UNMATCHED = "unmatched";

type Bucket = { count: number; replyByOn: string; pastDue: boolean };

function add(byClinic: Map<string, Bucket>, key: string, replyByOn: string, pastDue: boolean): void {
  const seen = byClinic.get(key);
  if (!seen) {
    byClinic.set(key, { count: 1, replyByOn, pastDue });
    return;
  }
  seen.count += 1;
  if (replyByOn < seen.replyByOn) seen.replyByOn = replyByOn;
  seen.pastDue ||= pastDue;
}

export const supportRepliesSource: InboxSource = {
  name: "the support replies",
  async read(ctx) {
    const { rows: requests, failures } = await listSupportRequests(ctx.now);
    const onCases = await requestIdsOnCases(requests.map((r) => r.requestId));
    const byClinic = new Map<string, Bucket>();
    for (const request of requests) {
      if (request.repliedAt !== null || onCases.has(request.requestId)) continue;
      add(byClinic, request.clinicId, request.replyByOn, request.pastDue);
    }
    const cases = await unsafeDb
      .select({ clinicId: supportCases.subjectClinicId, replyByOn: supportCases.replyByOn })
      .from(supportCases)
      .where(inArray(supportCases.state, [...NEEDS_US_STATES]));
    for (const c of cases) add(byClinic, c.clinicId ?? UNMATCHED, c.replyByOn, replyByPassed(c.replyByOn, ctx.now));
    const names = byClinic.size > 0 ? await ctx.clinicNames() : new Map<string, string>();
    const rows: InboxRow[] = [...byClinic].map(([clinicId, r]) => {
      const name = clinicId === UNMATCHED ? undefined : names.get(clinicId);
      return {
        id: `support:${clinicId}`,
        kind: "support_reply",
        count: r.count,
        sentence: r.pastDue ? "Support replies past the day promised." : "Support replies owed.",
        clinic: name !== undefined ? { id: clinicId, name } : null,
        button: { label: "Open support", kind: "link", href: "/admin/support#needs-you" },
        tone: "warn",
        dueAt: r.replyByOn,
      };
    });
    return {
      rows,
      partial: failures > 0 ? `${failures} clinic(s) could not be read.` : undefined,
    };
  },
};
