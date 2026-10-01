import { and, count, eq, gte, inArray, lt } from "drizzle-orm";

import { appointments, conversations } from "@/db/schema";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import { getTransport, type EmailTransport } from "@/lib/reporting/deliver";
import { claimDelivery, deliveredAlready, listRecipients, recordDelivery } from "@/lib/reporting/recipients";
import { withTenant } from "@/lib/tenant";

import { JOB_WEEKLY_RECAP, runJob } from "./jobs";

/**
 * The weekly recap: the first feedback a clinic gets, seven days in, not
 * thirty. Aggregate only — counts, never a person — so it goes through the
 * same recipient list and ledger as the monthly report and is safe on any
 * transport.
 *
 * When: on the clinic's own Monday between 08:00 and 09:59 local time, for
 * the seven days ending Sunday; and, in the first month, on day 7 after
 * go-live regardless of weekday, because the first one is the one that
 * sells. A recap over a week with no conversations at all sends nothing —
 * an email saying zero is worse than silence.
 *
 * What it may claim is fixed by the v1 spec ("What v1 can prove, and what it
 * cannot"): conversations handled, calls answered that would otherwise have
 * rung out, and appointments booked. Never revenue, never "collected", never
 * "recovered": attribution is phase two. TODO(v1): deposits collected and
 * booked value (bookings times the clinic's own listed prices) belong here
 * too, once an appointment carries its deposit's paid time and a snapshot of
 * the listed price at booking; neither exists yet, so neither is shown.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

function localParts(at: Date, timezone: string): { weekday: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "numeric", hour12: false }).formatToParts(at);
  const weekdayName = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayName);
  return { weekday, hour };
}

/** ISO-week key for the ledger, e.g. "2026-W37". */
export function weekKey(at: Date): string {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export type WeeklyFigures = { handled: number; answeredWouldHaveRungOut: number; booked: number };

/**
 * The reasons that mean a call reached the assistant because nobody at the
 * clinic could take it. Not `missed_call_callback`: v1 places no calls, and
 * that legacy value is never counted as a call answered.
 */
const RANG_OUT_REASONS = ["after_hours", "line_busy", "rang_unanswered"] as const;

export async function sendDueRecaps(now: Date, transport?: EmailTransport): Promise<{ sent: number; skipped: number; failed: number }> {
  const out = { sent: 0, skipped: 0, failed: 0 };
  const actor = { type: "service", serviceName: "weekly-recap" } as const;

  for (const clinic of await listClinics()) {
    try {
      if (clinic.dataClassification !== "production" || !clinic.wentLiveAt || clinic.destroyedAt) {
        out.skipped += 1;
        continue;
      }
      const { weekday, hour } = localParts(now, clinic.timezone);
      const daysLive = (now.getTime() - clinic.wentLiveAt.getTime()) / DAY_MS;
      const firstWeek = daysLive >= 7 && daysLive < 8;
      const monday = weekday === 1 && hour >= 8 && hour < 10 && daysLive >= 7;
      if (!firstWeek && !monday) {
        out.skipped += 1;
        continue;
      }
      const periodKey = firstWeek ? "first-week" : weekKey(now);
      const end = now;
      const start = new Date(now.getTime() - 7 * DAY_MS);

      const sent = await withTenant({ clinicId: clinic.id, actor }, async (tx) => {
        if (await deliveredAlready(tx, { kind: "weekly", periodKey })) return "skipped" as const;
        const recipients = await listRecipients(tx);
        if (recipients.length === 0) return "skipped" as const;

        const inWeek = and(eq(conversations.clinicId, tx.clinicId), gte(conversations.startedAt, start), lt(conversations.startedAt, end));
        const [handled] = await tx.db.select({ value: count() }).from(conversations).where(inWeek);
        const [rangOut] = await tx.db
          .select({ value: count() })
          .from(conversations)
          .where(and(inWeek, eq(conversations.channel, "voice"), inArray(conversations.recoveryReason, [...RANG_OUT_REASONS])));
        const [booked] = await tx.db
          .select({ value: count() })
          .from(appointments)
          .innerJoin(conversations, eq(appointments.conversationId, conversations.id))
          .where(and(eq(appointments.clinicId, tx.clinicId), inWeek));
        tx.audit.record({ action: "read", resourceType: "conversation", resultCount: handled?.value ?? 0, metadata: { purpose: "weekly_recap" } });

        const figures: WeeklyFigures = { handled: handled?.value ?? 0, answeredWouldHaveRungOut: rangOut?.value ?? 0, booked: booked?.value ?? 0 };
        if (figures.handled === 0) return "skipped" as const;

        const text =
          `Hi,\n\nYour week with AYA at ${clinic.name}:\n\n` +
          `  Conversations handled:   ${figures.handled}\n` +
          `  Calls answered that would otherwise have rung out:   ${figures.answeredWouldHaveRungOut}\n` +
          `  Appointments booked from those conversations:   ${figures.booked}\n\n` +
          `Reply to this email with anything that looked wrong on a call and we will pull it up.\n`;

        let any = false;
        for (const recipient of recipients) {
          const claim = await claimDelivery(tx, { kind: "weekly", periodKey, recipient: recipient.email });
          if (!claim) continue;
          const result = await (transport ?? getTransport("none")).send(
            { to: recipient.email, clinicId: tx.clinicId, clinicName: clinic.name },
            { subject: `${clinic.name}: your week with AYA`, text, html: "", phiClass: "none" },
          );
          await recordDelivery(tx, claim, result.status === "sent" ? { status: "sent", messageId: result.messageId } : { status: result.status, reason: result.reason });
          if (result.status === "sent") any = true;
          else if (result.status === "failed") return "failed" as const;
        }
        return any ? ("sent" as const) : ("skipped" as const);
      });
      out[sent] += 1;
    } catch (error) {
      out.failed += 1;
      log.error("weekly recap failed", { clinicId: clinic.id, error: describeError(error) });
    }
  }
  return out;
}

export async function runWeeklyRecapJob(options: { now?: Date; transport?: EmailTransport } = {}) {
  const now = options.now ?? new Date();
  return runJob(
    JOB_WEEKLY_RECAP,
    async () => {
      const r = await sendDueRecaps(now, options.transport);
      return `${r.sent} recap(s) sent, ${r.skipped} skipped` + (r.failed ? `, ${r.failed} failed` : "") + ".";
    },
    now,
  );
}
