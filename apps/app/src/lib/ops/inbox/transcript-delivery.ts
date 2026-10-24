import { listUndeliveredTranscripts } from "../transcript-watch-ops";

import type { InboxSource } from "./types";

/**
 * Where the transcript row opens: the System page's "Transcript copies not
 * delivered" section (lane P5b builds it with this anchor). One constant, so
 * moving the section is a one-line change.
 */
export const TRANSCRIPTS_PAGE = "/admin/system#transcripts";

/**
 * Transcript copies that never reached their clinic (listUndeliveredTranscripts,
 * lib/ops/transcript-watch-ops.ts): one row for all clinics, when any has a
 * copy still waiting more than 72 hours after it was queued, one that
 * bounced, or one deleted unsent (after 30 days, or 72 hours after a send
 * the mail service never answered). A deleted copy is lost for good, so any
 * makes the row red; waiting or bounced copies can still arrive, amber.
 * Counts only; the clinic is named by the row when there is one, never
 * inside the sentence. A clinic that could not be read makes the source
 * partial, never a zero.
 */
export const transcriptDeliverySource: InboxSource = {
  name: "the transcript deliveries",
  async read(ctx) {
    const { clinics, unreadClinics } = await listUndeliveredTranscripts({
      actor: ctx.actor,
      request: ctx.request,
      now: ctx.now,
    });
    const partial = unreadClinics > 0 ? `${unreadClinics} clinic(s) could not be read.` : undefined;
    const sum = (key: "overdue" | "bounced" | "expired" | "unconfirmed") =>
      clinics.reduce((n, c) => n + c.counts[key], 0);
    const overdue = sum("overdue");
    const bounced = sum("bounced");
    const expired = sum("expired");
    const unconfirmed = sum("unconfirmed");
    const total = overdue + bounced + expired + unconfirmed;
    if (total === 0) return { rows: [], partial };
    const parts = [
      overdue > 0 ? `${overdue} waiting more than 72 hours` : null,
      bounced > 0 ? `${bounced} bounced` : null,
      expired > 0 ? `${expired} deleted unsent after 30 days` : null,
      unconfirmed > 0 ? `${unconfirmed} deleted after 72 hours with no answer from the mail service` : null,
    ].filter((part): part is string => part !== null);
    const affected = clinics.filter(
      (c) => c.counts.overdue + c.counts.bounced + c.counts.expired + c.counts.unconfirmed > 0,
    );
    const only = affected.length === 1 ? affected[0]! : null;
    return {
      rows: [
        {
          id: "transcripts:undelivered",
          kind: "queue",
          count: total,
          sentence: `Transcript copies not delivered${only ? "" : ` to ${affected.length} clinics`}: ${parts.join(", ")}.`,
          clinic: only ? { id: only.clinicId, name: only.clinicName } : null,
          button: { label: "Open transcript deliveries", kind: "link", href: TRANSCRIPTS_PAGE },
          tone: expired + unconfirmed > 0 ? "bad" : "warn",
          dueAt: null,
        },
      ],
      partial,
    };
  },
};
