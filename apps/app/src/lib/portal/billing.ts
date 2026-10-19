import {
  agreementKindOfVersion,
  getPlan,
  OVERAGE_BLOCK_UNITS,
  overageBlockCents,
  planForChannels,
  USAGE_ALERT_PERCENT,
  type AgreementKind,
  type BillingInterval,
  type Channel,
  type Plan,
} from "@healdesk/catalog";
import { eq, sql } from "drizzle-orm";

import { baaAcceptances, clinics, type UsageMeter } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { withBillingTenant } from "@/lib/billing/billing-clinic";
import {
  getEntitlementsForUpdate,
  setOverageMode,
  setUsageAlertsEnabled,
} from "@/lib/billing/entitlements";
import { setAutoRenew } from "@/lib/billing/stripe-actions";
import {
  getBillingSummary,
  pendingPlanChangeOf,
  previewNextInvoice,
  readBillingGroup,
  type BillingSummary,
  type PreviewNextInvoiceResult,
} from "@/lib/billing/summary";
import { readAfterCancellation, type AfterCancellation } from "@/lib/offboarding/after-cancellation";
import { withTenant } from "@/lib/tenant";

import { portalCount, portalDay, portalMoney } from "./format";

/**
 * Billing (plan Part F6): this plan's screen over Package C's actions. The
 * screen never works out a bill: every amount it shows comes from
 * lib/billing/summary.ts (the database's view, with overage already in
 * dollars) or from Stripe's own preview, and every change goes through
 * Package C's action for it. What lives here is the reading for the page,
 * the two switches that are columns on the billing row (the allowance and
 * the usage alerts, as the console's billing panel writes them), and the
 * agreement on file.
 */

export type BillingView = {
  summary: BillingSummary | null;
  /** Stripe's preview of the next charge, once the plan has started. */
  nextInvoice: PreviewNextInvoiceResult | null;
  /** A plan change already in flight, which choosing the same plan again finishes. */
  pendingChange: { planId: string; interval: BillingInterval } | null;
  agreement: {
    kind: AgreementKind;
    version: string;
    acceptedAt: Date;
    signatory: string;
  } | null;
  /**
   * "Billed at the AYA Web Chat price until phone is in service", after the
   * start, while the billed package is not the bought one. Package names, not
   * plan names: the steps are the bought ones either way (planForChannels).
   */
  billedUntil: { billedPlanName: string; boughtPlanName: string; waiting: string[] } | null;
  /**
   * Once the service has ended: the export's deadline, or its delivery, and
   * when the data goes, or went (lib/offboarding/after-cancellation.ts).
   * Null while the clinic is in service.
   */
  afterCancellation: AfterCancellation | null;
};

export async function readBillingView(input: {
  clinicId: string;
  actor: ActorContext;
  now?: Date;
}): Promise<BillingView> {
  const now = input.now ?? new Date();
  const summary = await getBillingSummary(input.clinicId, { now });
  const group = await readBillingGroup(input.clinicId, { now, actor: input.actor });
  const pending = group.row ? pendingPlanChangeOf(group.row) : null;
  const nextInvoice = summary?.isPlanStarted
    ? await previewNextInvoice(input.clinicId, { now })
    : null;
  const agreement = await readAgreement(input.clinicId, input.actor);
  const afterCancellation = await readAfterCancellation({
    clinicId: input.clinicId,
    actor: input.actor,
    now,
  });
  return {
    summary,
    nextInvoice,
    pendingChange: pending ? { planId: pending.planId, interval: pending.interval } : null,
    agreement,
    billedUntil: billedUntil(summary),
    afterCancellation,
  };
}

/** The channel words a "not yet in service" line uses. */
const CHANNEL_WORDS = {
  web: "website chat",
  meta: "Instagram, Messenger & WhatsApp",
  voice: "phone",
} as const;

function billedUntil(summary: BillingSummary | null): BillingView["billedUntil"] {
  if (!summary?.isPlanStarted || !summary.billedPlanId || !summary.boughtPlanId) return null;
  if (summary.billedPlanId === summary.boughtPlanId) return null;
  const billed = getPlan(summary.billedPlanId);
  const bought = getPlan(summary.boughtPlanId);
  if (!billed || !bought) return null;
  const waiting = (["web", "meta", "voice"] as const)
    .filter((c) => bought.channels[c] && !billed.channels[c])
    .map((c) => CHANNEL_WORDS[c]);
  return { billedPlanName: billed.packageName, boughtPlanName: bought.packageName, waiting };
}

// -----------------------------------------------------------------------------
// The plan's steps, in words (the pricing sheet of 13 October 2026)
// -----------------------------------------------------------------------------

const METER_WORDS: Record<UsageMeter, readonly [string, string]> = {
  voice_minutes: ["voice minute", "voice minutes"],
  chat_conversations: ["chat conversation", "chat conversations"],
};

/** "voice minute" / "voice minutes", for one meter's lines. */
export function meterWords(meter: UsageMeter): readonly [string, string] {
  return METER_WORDS[meter];
}

/**
 * What a plan includes each month across every location: its steps times the
 * locations, which pool (BD5). "500 voice minutes and 300 chat conversations".
 */
export function includedLine(plan: Plan, locations: number): string {
  const n = Math.max(1, locations);
  return [
    ...(plan.includedVoiceMinutes > 0
      ? [portalCount(plan.includedVoiceMinutes * n, ...METER_WORDS.voice_minutes)]
      : []),
    ...(plan.includedChatConversations > 0
      ? [portalCount(plan.includedChatConversations * n, ...METER_WORDS.chat_conversations)]
      : []),
  ].join(" and ");
}

/**
 * The extra-100 price on one meter, at the BOUGHT plan's rate (the rate the
 * summary's overage is billed at): "$104 for each started block of 100 extra
 * voice minutes". Null for a meter the plan does not sell. The screen prints
 * it beside the word "provisional", because the rates are (CLAUDE.md,
 * "Claims and copy"), and never as a per-unit rate.
 */
export function extraBlockLine(plan: Plan, meter: UsageMeter): string | null {
  const rate =
    meter === "voice_minutes" ? plan.overagePerVoiceMinuteUsd : plan.overagePerChatConversationUsd;
  const included =
    meter === "voice_minutes" ? plan.includedVoiceMinutes : plan.includedChatConversations;
  if (rate <= 0 || included <= 0) return null;
  return `${portalMoney(overageBlockCents(rate))} for each started block of ${OVERAGE_BLOCK_UNITS} extra ${METER_WORDS[meter][1]}`;
}

/**
 * Whether a meter has crossed the usage-alert mark (USAGE_ALERT_PERCENT, 90%
 * since 13 October 2026), so the screen can say what the email says: move up
 * a step, or let extra blocks bill.
 */
export function pastAlertMark(meter: { used: number; included: number }): boolean {
  return meter.included > 0 && meter.used * 100 >= USAGE_ALERT_PERCENT * meter.included;
}

/**
 * The agreement on file: the organisation's newest bound, unterminated
 * acceptance (app_agreement_in_effect, 0048), read inside the clinic's
 * tenant, where the policy on baa_acceptances shows only its own
 * organisation's. Contract metadata, never patient data.
 */
export async function readAgreement(
  clinicId: string,
  actor: ActorContext,
): Promise<BillingView["agreement"]> {
  return withTenant({ clinicId, actor }, async (tx) => {
    const [clinic] = await tx.db
      .select({ organizationId: clinics.organizationId })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    if (!clinic) return null;
    const found = await tx.db.execute<{ agreement_id: string }>(
      sql`select agreement_id from app_agreement_in_effect(${clinic.organizationId})`,
    );
    const id = found.rows[0]?.agreement_id;
    if (!id) return null;
    const [row] = await tx.db
      .select({
        version: baaAcceptances.documentVersion,
        acceptedAt: baaAcceptances.acceptedAt,
        signatory: baaAcceptances.acceptedByName,
      })
      .from(baaAcceptances)
      .where(eq(baaAcceptances.id, id))
      .limit(1);
    if (!row) return null;
    return {
      kind: agreementKindOfVersion(row.version),
      version: row.version.replace(/^(baa|dpa)\//, ""),
      acceptedAt: row.acceptedAt,
      signatory: row.signatory,
    };
  });
}

// -----------------------------------------------------------------------------
// The three switches
// -----------------------------------------------------------------------------

export type BillingSwitchKey = "overage_mode" | "usage_alerts" | "auto_renew";

export function isBillingSwitchKey(value: unknown): value is BillingSwitchKey {
  return value === "overage_mode" || value === "usage_alerts" || value === "auto_renew";
}

export type BillingSwitchResult = { ok: true; toast: string } | { ok: false; message: string };

/**
 * One of Billing's three switches (spec, "Every switch in the portal",
 * Billing): when the monthly allowance runs out, usage alerts, auto-renew.
 * The allowance and the alerts are columns on the billing clinic's row,
 * written as the console's panel writes them (lib/ops/billing.ts), under the
 * row's lock; auto-renew is Package C's setAutoRenew, which also tells
 * Stripe. The step-up is the caller's (the server action).
 */
export async function setBillingSwitch(
  ctx: { clinicId: string; actorLabel: string; userId: string },
  key: BillingSwitchKey,
  value: unknown,
): Promise<BillingSwitchResult> {
  const actor: ActorContext = { type: "user", userId: ctx.userId, label: ctx.actorLabel };
  switch (key) {
    case "overage_mode": {
      if (value !== "allow" && value !== "hard_cap") {
        return { ok: false, message: "Choose what happens when the allowance runs out." };
      }
      const done = await withBillingTenant(ctx.clinicId, actor, async (tx) => {
        const row = await getEntitlementsForUpdate(tx.db, tx.clinicId);
        if (!row) return false;
        if (row.overageMode !== value) {
          await setOverageMode(tx.db, tx.clinicId, value);
          tx.audit.record({
            action: "update",
            resourceType: "entitlements",
            resourceId: tx.clinicId,
            metadata: { field: "overage_mode", mode: value },
          });
        }
        return true;
      });
      if (!done)
        return { ok: false, message: "We couldn't find a billing account for this clinic." };
      return {
        ok: true,
        toast:
          value === "allow"
            ? "When the allowance runs out, AYA keeps answering and the extra is billed in blocks of 100."
            : "When the allowance runs out, calls go to your direct line and website chat shows a contact form until it renews. Nothing extra is billed.",
      };
    }

    case "usage_alerts": {
      if (typeof value !== "boolean") return { ok: false, message: "Choose on or off." };
      const done = await withBillingTenant(ctx.clinicId, actor, async (tx) => {
        const row = await getEntitlementsForUpdate(tx.db, tx.clinicId);
        if (!row) return false;
        if (row.usageAlertsEnabled !== value) {
          await setUsageAlertsEnabled(tx.db, tx.clinicId, value);
          tx.audit.record({
            action: "update",
            resourceType: "entitlements",
            resourceId: tx.clinicId,
            metadata: { field: "usage_alerts", on: value },
          });
        }
        return true;
      });
      if (!done)
        return { ok: false, message: "We couldn't find a billing account for this clinic." };
      return {
        ok: true,
        toast: value
          ? `Usage alerts on. We email you at ${USAGE_ALERT_PERCENT}% and 100% of the allowance.`
          : `Usage alerts off. We won't email you at ${USAGE_ALERT_PERCENT}% and 100%. If AYA ever stops at the allowance, you still hear about it.`,
      };
    }

    case "auto_renew": {
      if (typeof value !== "boolean") return { ok: false, message: "Choose on or off." };
      // Whether the plan has started decides what Off means (spec, Billing):
      // after the start it ends at the period's end; before it, it never starts.
      const started = (await getBillingSummary(ctx.clinicId))?.isPlanStarted ?? false;
      const result = await setAutoRenew({
        clinicId: ctx.clinicId,
        on: value,
        actorLabel: ctx.actorLabel,
      });
      if (result.status !== "ok") return { ok: false, message: result.message };
      if (value) {
        return {
          ok: true,
          toast: started
            ? "Auto-renew on. Your plan carries on as before."
            : "Auto-renew on. Your plan starts the day AYA first answers, as before.",
        };
      }
      const day = result.closesOn
        ? portalDay(result.closesOn, await clinicTimeZone(ctx.clinicId, actor))
        : null;
      return {
        ok: true,
        toast: started
          ? `Auto-renew off. Your plan ends ${day ? `on ${day}` : "at the end of the period you've paid for"}; turn it back on any time before then.`
          : `Auto-renew off. Your plan won't start, and nothing more is charged.${day ? ` Turn it back on any time before ${day}.` : ""}`,
      };
    }
  }
}

/** The clinic's own time zone, for a date a toast names. */
async function clinicTimeZone(clinicId: string, actor: ActorContext): Promise<string> {
  return withTenant({ clinicId, actor }, async (tx) => {
    const [row] = await tx.db
      .select({ timezone: clinics.timezone })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    return row?.timezone ?? "America/New_York";
  });
}

/**
 * The plan a clinic's channels in service would be billed as, at the bought
 * plan's steps, for a line that names it.
 */
export function planForChannelsName(bought: Plan, channels: readonly Channel[]): string | null {
  return planForChannels(bought, channels)?.name ?? null;
}
