import { annualTotalUsd, getPlan } from "@healdesk/catalog";
import { and, eq, gte, lt } from "drizzle-orm";

import { entitlements } from "@/db/schema";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import { getTransport, type EmailTransport } from "@/lib/reporting/deliver";
import { claimDelivery, listRecipients, recordDelivery } from "@/lib/reporting/recipients";
import { withTenant } from "@/lib/tenant";

import { JOB_ANNUAL_RENEWAL_REMINDER, runJob } from "./jobs";

/**
 * The 30-day annual renewal notice the terms of service promise.
 *
 * Daily: an annual clinic whose current period ends between 30 and 31 days
 * from now gets one email naming the package, the renewal date, the amount,
 * and how to cancel. The delivery ledger (kind "renewal", period = the
 * renewal date) makes it once per period whatever the job does. No usage
 * figures, no patient data: phiClass "none", any transport.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export async function sendRenewalReminders(
  now: Date,
  transport: EmailTransport = getTransport("none"),
): Promise<{ considered: number; sent: number; skipped: number; failed: number }> {
  const out = { considered: 0, sent: 0, skipped: 0, failed: 0 };
  const actor = { type: "service", serviceName: "annual-renewal-reminder" } as const;
  const from = new Date(now.getTime() + 30 * DAY_MS);
  const to = new Date(now.getTime() + 31 * DAY_MS);

  for (const clinic of await listClinics()) {
    try {
      const outcome = await withTenant({ clinicId: clinic.id, actor }, async (tx) => {
        const [row] = await tx.db
          .select({
            planCode: entitlements.planCode,
            periodEnd: entitlements.currentPeriodEnd,
            status: entitlements.status,
          })
          .from(entitlements)
          .where(
            and(
              eq(entitlements.clinicId, tx.clinicId),
              eq(entitlements.billingInterval, "year"),
              gte(entitlements.currentPeriodEnd, from),
              lt(entitlements.currentPeriodEnd, to),
            ),
          )
          .limit(1);
        if (!row || !row.periodEnd || row.status === "canceled" || row.status === "canceling") return "skipped" as const;
        const plan = getPlan(row.planCode);
        if (!plan) return "skipped" as const;
        const renewalDate = row.periodEnd.toISOString().slice(0, 10);
        const recipients = await listRecipients(tx);
        if (recipients.length === 0) return "skipped" as const;

        let sentAny = false;
        for (const recipient of recipients) {
          const claim = await claimDelivery(tx, { kind: "renewal", periodKey: renewalDate, recipient: recipient.email });
          if (!claim) continue;
          const result = await transport.send(
            { to: recipient.email, clinicId: tx.clinicId, clinicName: clinic.name },
            {
              subject: `Your ${plan.name} plan renews on ${renewalDate}`,
              text:
                `Hi,\n\nThis is the 30-day notice our terms promise. Your annual ${plan.name} subscription for ${clinic.name} ` +
                `renews on ${renewalDate} for ${usd.format(annualTotalUsd(plan))}, charged to the card on file.\n\n` +
                `Nothing to do if you want to keep going. To cancel before then, open the billing portal from any invoice email ` +
                `and choose "cancel at end of period", or reply to this email from the address on the account.\n\n` +
                `Thank you for the year.\n`,
              html: "",
              phiClass: "none",
            },
          );
          await recordDelivery(
            tx,
            claim,
            result.status === "sent" ? { status: "sent", messageId: result.messageId } : { status: result.status, reason: result.reason },
          );
          if (result.status === "sent") sentAny = true;
          else if (result.status === "failed") return "failed" as const;
        }
        return sentAny ? ("sent" as const) : ("skipped" as const);
      });
      out.considered += 1;
      out[outcome] += 1;
    } catch (error) {
      out.failed += 1;
      log.error("renewal reminder failed", { clinicId: clinic.id, error: describeError(error) });
    }
  }
  return out;
}

export async function runAnnualRenewalReminderJob(options: { now?: Date; transport?: EmailTransport } = {}) {
  const now = options.now ?? new Date();
  return runJob(
    JOB_ANNUAL_RENEWAL_REMINDER,
    async () => {
      const r = await sendRenewalReminders(now, options.transport);
      return `Considered ${r.considered}: ${r.sent} reminded, ${r.skipped} skipped` + (r.failed ? `, ${r.failed} failed` : "") + ".";
    },
    now,
  );
}
