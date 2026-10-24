import { clinicHealth, type HealthFlag } from "../health";

import type { InboxRow, InboxSource, Tone } from "./types";

/**
 * The first-weeks flags (listClinicHealth, lib/ops/health.ts): a clinic in
 * its first 60 days live that someone should phone today, one row per flag
 * and clinic. Counts and dates only; the clinic is named by the row, never
 * inside the sentence. clinicHealth reads each clinic's conversations and
 * writes its access row ("clinic_health"), attributed to the operator. A
 * clinic it could not read makes this source partial, never silent.
 */

const FLAGS: Record<HealthFlag, { sentence: string; tone: Tone; page: "care" | "onboarding" | "billing" }> = {
  no_calls_after_day_7: {
    sentence: "No conversations since going live, past day 7: check the call forwarding.",
    tone: "warn",
    page: "onboarding",
  },
  first_win: {
    sentence: "First booking by AYA, and nobody has phoned the clinic since.",
    tone: "info",
    page: "care",
  },
  quiet_week: {
    sentence: "No conversations in the last 7 days.",
    tone: "warn",
    page: "care",
  },
  near_allowance: {
    sentence: "Usage is at the allowance alert mark.",
    tone: "warn",
    page: "billing",
  },
};

export const healthFlagsSource: InboxSource = {
  name: "the first-weeks flags",
  async read(ctx) {
    const report = { failed: 0 };
    const clinics = await clinicHealth(ctx.now, { type: "service", serviceName: ctx.operator.email }, report);
    const rows: InboxRow[] = [];
    for (const clinic of clinics) {
      for (const flag of clinic.flags) {
        const words = FLAGS[flag];
        rows.push({
          id: `health:${flag}:${clinic.clinicId}`,
          kind: "health_flag",
          count: 1,
          sentence: words.sentence,
          clinic: { id: clinic.clinicId, name: clinic.name },
          button: { label: "Open clinic", kind: "link", href: `/admin/ops/${clinic.clinicId}/${words.page}` },
          tone: words.tone,
          dueAt: null,
        });
      }
    }
    return { rows, partial: report.failed > 0 ? `${report.failed} clinic(s) could not be read.` : undefined };
  },
};
