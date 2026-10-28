/**
 * Which Settings switches can be used right now, and why not (owner,
 * 28 October 2026; CLAUDE.md, "Simplicity rule").
 *
 * The one place these rules live. The Settings page, the wizard, the server
 * writer and the notice after a change all read this module, so a switch cannot
 * be greyed out on the screen yet accepted by a crafted request, and no rule is
 * written twice. Pure: facts in, answers out, nothing read or written here.
 *
 * The text switch is a clinic's choice like any other. Whether a text can
 * actually go out yet is not a clinic matter and is not decided here: the tool
 * layer checks it where the text would be offered, and the launch register
 * keeps every clinic from going live while it is open.
 *
 * Every `reason` is what the clinic reads: what is missing, in plain words,
 * with no mention of how the thing works inside.
 */

export type SwitchFacts = {
  /** The clinic's own Stripe account is connected. */
  gatewayConnected: boolean;
  /** At least one treatment asks for a deposit (Knowledge → Prices). */
  hasDepositAmount: boolean;
  /** Google Calendar is connected, so the assistant can write a booking itself. */
  calendarConnected: boolean;
  /** Auto-confirm bookings: off makes every booking a request staff approve. */
  autoConfirm: boolean;
  /** The clinic bought phone. */
  hasVoice: boolean;
};

export type RuledSwitch = "deposits" | "text_payment_link" | "full_payment";

export type SwitchRule = {
  enabled: boolean;
  /** One plain sentence for the clinic when `enabled` is false; null otherwise. */
  reason: string | null;
  /** What to do to unlock it, as a short label ("Connect Stripe"); null when there is nothing to do. */
  unlock:
    | "connect_stripe"
    | "set_deposit"
    | "connect_calendar"
    | "turn_on_auto_confirm"
    | null;
};

const OPEN: SwitchRule = { enabled: true, reason: null, unlock: null };

export type SwitchUnlock = NonNullable<SwitchRule["unlock"]>;

/**
 * The one sentence for each thing that unlocks a switch. Exported so the
 * email after an automatic reset (lib/email/templates/setting_changed.ts)
 * says exactly what the page says, from this one list.
 */
export const UNLOCK_REASONS: Readonly<Record<SwitchUnlock, string>> = {
  connect_stripe: "Connect your Stripe account first.",
  set_deposit: "Set a deposit on a treatment in Knowledge → Prices first.",
  connect_calendar: "Connect your calendar first.",
  turn_on_auto_confirm:
    "Turn on Auto-confirm bookings first, so nobody pays for a time your team might decline.",
};

function locked(unlock: SwitchUnlock): SwitchRule {
  return { enabled: false, reason: UNLOCK_REASONS[unlock], unlock };
}

/** What a reset did, before its reason: the first words of its notice. */
export const RESET_OPENERS: Readonly<Record<RuledSwitch, string>> = {
  full_payment: "Back to deposit only.",
  text_payment_link: "Texting the payment link is off.",
  deposits: "Deposits are off.",
};

/** The sentence a clinic is shown for one reset. */
export function resetNotice(which: RuledSwitch, reason: string | null): string {
  return reason ? `${RESET_OPENERS[which]} ${reason}` : RESET_OPENERS[which];
}

export function switchRules(
  facts: SwitchFacts,
): Record<RuledSwitch, SwitchRule> {
  const deposits: SwitchRule = !facts.gatewayConnected
    ? locked("connect_stripe")
    : !facts.hasDepositAmount
      ? locked("set_deposit")
      : OPEN;

  const text: SwitchRule = !facts.hasVoice
    ? {
        enabled: false,
        reason: "Texting a payment link is for phone calls.",
        unlock: null,
      }
    : !facts.gatewayConnected
      ? locked("connect_stripe")
      : OPEN;

  const full: SwitchRule = !facts.gatewayConnected
    ? locked("connect_stripe")
    : !facts.calendarConnected
      ? locked("connect_calendar")
      : !facts.autoConfirm
        ? locked("turn_on_auto_confirm")
        : OPEN;

  return { deposits, text_payment_link: text, full_payment: full };
}

/** What the clinic has chosen, for the dependants. */
export type RuledValues = {
  depositsEnabled: boolean;
  textPaymentLink: boolean;
  fullPayment: boolean;
};

export type SwitchReset = { switch: RuledSwitch; notice: string };

/**
 * After a change to the facts, the switches that were on and can no longer be,
 * each with the sentence the clinic is shown. The writer sets every one of
 * them back in the same transaction and audits it (spec: turning Auto-confirm
 * off, disconnecting the calendar or the gateway returns full payment to
 * deposit only in the same moment and says why).
 */
export function resetsAfter(
  facts: SwitchFacts,
  values: RuledValues,
): SwitchReset[] {
  const rules = switchRules(facts);
  const out: SwitchReset[] = [];
  if (values.fullPayment && !rules.full_payment.enabled) {
    out.push({
      switch: "full_payment",
      notice: resetNotice("full_payment", rules.full_payment.reason),
    });
  }
  if (values.textPaymentLink && !rules.text_payment_link.enabled) {
    out.push({
      switch: "text_payment_link",
      notice: resetNotice("text_payment_link", rules.text_payment_link.reason),
    });
  }
  if (values.depositsEnabled && !rules.deposits.enabled) {
    out.push({
      switch: "deposits",
      notice: resetNotice("deposits", rules.deposits.reason),
    });
  }
  return out;
}
