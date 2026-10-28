import { eq } from "drizzle-orm";

import { clinicChangeEvents, clinicSettings } from "@/db/schema";
import { getClinicSettings } from "@/lib/billing/settings";
import { readMetaPlatformSwitches } from "@/lib/channels/meta-platforms";
import { readChannelStates } from "@/lib/channels/state";
import { describeError, log } from "@/lib/log";
import { readSetupSettings } from "@/lib/setup/settings";
import type { TenantTx } from "@/lib/tenant";

import type { ChangeOrigin } from "./change-events";
import { SETTING_ENTRIES, settingValueToken } from "./setting-words";

/**
 * A clinic's Settings changes, for ops (owner, 28 October 2026: "Ops gets an
 * email for every submitted change to a clinic's profile, from any source").
 *
 * The one writer of every switch (lib/portal/settings.ts saveSetting, and
 * lib/booking/mode.ts setAutoConfirm for Auto-confirm) reads the value before
 * and after its write and records a `setting` row in the clinic change feed
 * (clinic_change_events) in its own transaction, so a refused or rolled-back
 * save records nothing. The minute sweep (lib/clinic/change-events.ts
 * runClinicChangeAlerts) then raises one ops alert per row, after commit,
 * keyed on the row: one email to the ops address and one Slack post, however
 * often the sweep runs. The clinic's own email for a change of where calls
 * go (O4, lib/notices/setting-changed.ts) is a different recipient and stays
 * as it was.
 *
 * The row carries the key and, for a switch or a choice, the closed tokens
 * before and after ("on", "off", a choice's id); a text setting (a greeting,
 * a number) carries its key alone. Never the words, never a number.
 */

/** The raw value of every setting the recorder knows, as the portal would show it. */
export async function readSettingSnapshot(tx: TenantTx, now: Date = new Date()): Promise<Record<string, unknown>> {
  const setup = await readSetupSettings(tx.db, tx.clinicId);
  const billing = await getClinicSettings(tx);
  const channels = await readChannelStates(tx.db, tx.clinicId, now);
  const meta = await readMetaPlatformSwitches(tx.db, tx.clinicId);
  // The contract's two payment columns (lane A, drizzle): read by name from
  // the row, so this reads them once they exist and their defaults before.
  const [row] = await tx.db.select().from(clinicSettings).where(eq(clinicSettings.clinicId, tx.clinicId)).limit(1);
  const raw = (row ?? {}) as Record<string, unknown>;
  const enabled = (channel: string) => channels.find((c) => c.channel === channel)?.enabled ?? false;
  return {
    channel_web: enabled("web"),
    channel_voice: enabled("voice"),
    channel_instagram: meta.instagram,
    channel_messenger: meta.messenger,
    channel_whatsapp: meta.whatsapp,
    coverage_mode: setup.coverageMode,
    tone: setup.tone,
    phone_greeting: setup.phoneGreeting,
    chat_greeting: setup.chatGreeting,
    short_name: setup.shortName,
    languages: JSON.stringify(setup.languages),
    suggest_add_ons: setup.suggestAddOns,
    mention_promotions: setup.mentionPromotions,
    deposits_enabled: billing.depositsEnabled,
    book_voice_without_deposit: billing.bookVoiceWithoutDeposit,
    book_chat_without_deposit: billing.bookChatWithoutDeposit,
    deposit_uncollectable: billing.depositUncollectable,
    deposit_hold_minutes: String(billing.depositHoldMinutes),
    text_payment_link: typeof raw.textPaymentLink === "boolean" ? raw.textPaymentLink : false,
    payment_ask: typeof raw.paymentAsk === "string" ? raw.paymentAsk : "deposit_only",
    direct_line: billing.directLineE164,
    urgent_help: setup.urgentHelpE164,
    vet_referral: setup.vetReferralE164,
    daily_summary: setup.dailySummary,
    transfer_live_calls: setup.transferLiveCalls,
    transfer_number: setup.transferE164,
    auto_confirm: billing.autoConfirmBookings,
  };
}

/** The summary a `setting` row carries: the key, and the closed tokens when the setting has them. */
export function settingChangeSummary(
  key: string,
  before: unknown,
  after: unknown,
): { setting: string; before?: string; after?: string } {
  const b = settingValueToken(key, before);
  const a = settingValueToken(key, after);
  return { setting: key, ...(b !== undefined && a !== undefined ? { before: b, after: a } : {}) };
}

/**
 * Record a setting's change in the writer's transaction, when its value moved.
 * Never throws and never breaks the writer: the insert runs in a savepoint,
 * so the change itself is kept even if its record cannot be, and that is
 * logged (as lib/notices/setting-changed.ts does for the clinic's email).
 * Returns the row's id, or null when nothing changed or it was not recorded.
 */
export async function recordSettingChange(
  tx: TenantTx,
  change: { key: string; before: unknown; after: unknown; origin: ChangeOrigin; now?: Date },
): Promise<string | null> {
  if (!Object.hasOwn(SETTING_ENTRIES, change.key)) return null;
  if (sameValue(change.before, change.after)) return null;
  try {
    return await tx.db.transaction(async (savepoint) => {
      const [row] = await savepoint
        .insert(clinicChangeEvents)
        .values({
          clinicId: tx.clinicId,
          kind: "setting",
          source: change.origin.source,
          actorKind: change.origin.actor,
          summary: settingChangeSummary(change.key, change.before, change.after),
          changedAt: change.now ?? new Date(),
          // No audit pack reads settings: the alert is all ops is owed.
          auditStatus: null,
        })
        .returning({ id: clinicChangeEvents.id });
      return row?.id ?? null;
    });
  } catch (error) {
    try {
      log.error("setting change not recorded", { clinicId: tx.clinicId, field: change.key, error: describeError(error) });
    } catch {
      // Nothing reaches the writer; see above.
    }
    return null;
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null);
}
