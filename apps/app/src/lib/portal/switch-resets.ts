import {
  getDepositSettings,
  switchFactsOf,
  writeDepositSettings,
  type DepositSettingsPatch,
} from "@/lib/billing/deposits";
import { SYSTEM_ORIGIN } from "@/lib/clinic/change-events";
import { recordSettingChange } from "@/lib/clinic/setting-changes";
import { notifySwitchesReset } from "@/lib/notices/setting-changed";
import type { TenantTx } from "@/lib/tenant";

import {
  resetsAfter,
  switchRules,
  type SwitchFacts,
  type SwitchReset,
  type SwitchUnlock,
} from "./switch-rules";

/**
 * The payment switches' facts as they stand, and what happens to the
 * switches when one of those facts is lost (owner, 28 October 2026;
 * docs/design/launch-readiness-2026-10-27/portal-dashboard-lanes.md).
 *
 * The rules themselves are switch-rules.ts's alone. This module reads the
 * facts from the database, and, when a writer has just lost one (Auto-confirm
 * turned off, the calendar disconnected or broken, the Stripe account
 * disconnected), sets back every switch the rules no longer allow, in the
 * writer's own transaction: full payment to deposit only, the payment-link
 * text off, deposits off. Each reset goes through setDepositSettings, so it
 * keeps its before and after in clinic_settings_history and an audit row
 * naming the reason, and the clinic gets ONE email naming every switch reset
 * and why (O4, lib/email/templates/setting_changed.ts). Each reset is also
 * a row in the clinic change feed, as healdesk's own change
 * (lib/clinic/setting-changes.ts, SYSTEM_ORIGIN), so ops hear of it once by
 * email and in Slack, like any other change. Business data only.
 */

/** The real facts the payment switches' rules weigh, for the Settings page, the wizard and the writers. */
export async function readPaymentFacts(tx: TenantTx): Promise<SwitchFacts> {
  return switchFactsOf(await getDepositSettings(tx));
}

/** A fact a writer has just lost. */
export type ResetCause = "auto_confirm_off" | "calendar_disconnected" | "stripe_disconnected";

/** Which fact each cause takes away, and what would give it back. */
const CAUSES: Readonly<
  Record<ResetCause, { fact: "autoConfirm" | "calendarConnected" | "gatewayConnected"; unlock: SwitchUnlock }>
> = {
  auto_confirm_off: { fact: "autoConfirm", unlock: "turn_on_auto_confirm" },
  calendar_disconnected: { fact: "calendarConnected", unlock: "connect_calendar" },
  stripe_disconnected: { fact: "gatewayConnected", unlock: "connect_stripe" },
};

const PATCHES: Readonly<Record<SwitchReset["switch"], DepositSettingsPatch>> = {
  full_payment: { paymentAsk: "deposit_only" },
  text_payment_link: { textPaymentLink: false },
  deposits: { depositsEnabled: false },
};

/** Each reset as the change feed records it: the Settings key, before and after. */
const FEED: Readonly<Record<SwitchReset["switch"], { key: string; before: unknown; after: unknown }>> = {
  full_payment: { key: "payment_ask", before: "full_payment", after: "deposit_only" },
  text_payment_link: { key: "text_payment_link", before: true, after: false },
  deposits: { key: "deposits_enabled", before: true, after: false },
};

/**
 * Set back every payment switch the lost fact turned unavailable, in the
 * caller's transaction. The fact is taken as lost whatever the database says
 * yet (a disconnect clears the Stripe account only after Stripe answers), and
 * only switches the fact itself unlocked are reset: one that was already
 * unavailable for another reason is not the cause's to touch. Returns what
 * was reset, each with the sentence the clinic is shown; empty when nothing
 * needed to change, and then nothing is written or sent.
 */
export async function applySwitchResets(
  tx: TenantTx,
  input: { cause: ResetCause; actorLabel: string; now?: Date },
): Promise<SwitchReset[]> {
  const now = input.now ?? new Date();
  const { fact, unlock } = CAUSES[input.cause];
  const current = await getDepositSettings(tx);
  const after: SwitchFacts = { ...switchFactsOf(current), [fact]: false };
  const before = switchRules({ ...after, [fact]: true });
  const resets = resetsAfter(after, {
    depositsEnabled: current.depositsEnabled,
    textPaymentLink: current.textPaymentLink,
    fullPayment: current.paymentAsk === "full_payment",
  }).filter((reset) => before[reset.switch].enabled);
  if (resets.length === 0) return [];

  const patch: DepositSettingsPatch = Object.assign({}, ...resets.map((r) => PATCHES[r.switch]));
  const { historyIds } = await writeDepositSettings(tx, patch, input.actorLabel, now, {
    reason: input.cause,
  });
  for (const reset of resets) {
    await recordSettingChange(tx, { ...FEED[reset.switch], origin: SYSTEM_ORIGIN, now });
  }
  await notifySwitchesReset(tx, {
    switchIds: resets.map((r) => r.switch),
    code: unlock,
    key: historyIds[0] ?? `${input.cause}:${now.toISOString()}`,
    at: now,
  });
  return resets;
}

/**
 * Whether the assistant may ask a patient for the full price now: the clinic
 * chose full payment AND the rules allow it this moment. The tool layer asks
 * this, never the stored choice alone, so a fact lost between a reset and the
 * next turn still keeps full payment off.
 */
export async function fullPaymentActive(tx: TenantTx): Promise<boolean> {
  const current = await getDepositSettings(tx);
  return (
    current.paymentAsk === "full_payment" && switchRules(switchFactsOf(current)).full_payment.enabled
  );
}

/**
 * Whether the assistant may offer to text a payment link. Never yet: no
 * sender exists (owner, 28 October 2026), so the clinic's switch is a choice
 * kept for when one does, and nothing offers or sends a text. When a sender
 * is built, this is where its readiness, the clinic's switch and the rule
 * (switch-rules.ts, text_payment_link) are all checked together.
 */
export function paymentLinkTextOffered(): false {
  return false;
}
