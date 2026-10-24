import { listSupportRequests } from "../support-replies";

import type { InboxRow, InboxSource } from "./types";

/**
 * The support chat's escalations with no reply marked (listSupportRequests),
 * one row per clinic, due the earliest day L25 promised. The topic is not
 * carried: it is the clinic's own category, and the queue page shows it.
 */
export const supportRepliesSource: InboxSource = {
  name: "the support replies",
  async read(ctx) {
    const { rows: requests, failures } = await listSupportRequests(ctx.now);
    const byClinic = new Map<string, { count: number; replyByOn: string; pastDue: boolean }>();
    for (const request of requests) {
      if (request.repliedAt !== null) continue;
      const seen = byClinic.get(request.clinicId);
      if (!seen) {
        byClinic.set(request.clinicId, { count: 1, replyByOn: request.replyByOn, pastDue: request.pastDue });
        continue;
      }
      seen.count += 1;
      if (request.replyByOn < seen.replyByOn) seen.replyByOn = request.replyByOn;
      seen.pastDue ||= request.pastDue;
    }
    const names = byClinic.size > 0 ? await ctx.clinicNames() : new Map<string, string>();
    const rows: InboxRow[] = [...byClinic].map(([clinicId, r]) => {
      const name = names.get(clinicId);
      return {
        id: `support:${clinicId}`,
        kind: "support_reply",
        count: r.count,
        sentence: r.pastDue ? "Support replies past the day promised." : "Support replies owed.",
        clinic: name !== undefined ? { id: clinicId, name } : null,
        button: { label: "Open support", kind: "link", href: "/admin/queues#support" },
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
