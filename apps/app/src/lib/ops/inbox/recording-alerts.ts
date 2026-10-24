import { listRecordingAlerts, MAX_LISTED_ALERTS } from "@/lib/voice/recording-alerts";

import type { InboxRow, InboxSource } from "./types";

/**
 * Calls Retell still held after they ended and nobody has deleted yet
 * (listRecordingAlerts), one row per clinic. A call's data left with the
 * vendor is a privacy promise not yet kept; it blocks nothing, so it is not red.
 * listRecordingAlerts writes an access row for each clinic with alerts,
 * attributed to the operator. It lists at most MAX_LISTED_ALERTS (per clinic and in all),
 * resolved ones included (lib/voice/recording-alerts.ts is not this lane's to
 * filter), so a read that reaches the cap is reported as partial.
 */
export const recordingAlertsSource: InboxSource = {
  name: "the Retell deletions",
  async read(ctx) {
    const { alerts, unreadClinics } = await listRecordingAlerts(ctx.actor, ctx.request);
    const byClinic = new Map<string, number>();
    for (const alert of alerts) {
      if (alert.resolvedAt !== null) continue;
      byClinic.set(alert.clinicId, (byClinic.get(alert.clinicId) ?? 0) + 1);
    }
    const names = byClinic.size > 0 ? await ctx.clinicNames() : new Map<string, string>();
    const rows: InboxRow[] = [...byClinic].map(([clinicId, count]) => {
      const name = names.get(clinicId);
      return {
        id: `recording:${clinicId}`,
        kind: "recording_alert",
        count,
        sentence: "Calls Retell still holds: delete them.",
        clinic: name !== undefined ? { id: clinicId, name } : null,
        button: { label: "Open Retell deletions", kind: "link", href: "/admin/recordings" },
        tone: "warn",
        dueAt: null,
      };
    });
    const notes: string[] = [];
    if (unreadClinics > 0) notes.push(`${unreadClinics} clinic(s) could not be read.`);
    if (alerts.length >= MAX_LISTED_ALERTS) {
      notes.push(`Only ${MAX_LISTED_ALERTS} alerts were read, resolved ones included.`);
    }
    return { rows, partial: notes.length > 0 ? notes.join(" ") : undefined };
  },
};
