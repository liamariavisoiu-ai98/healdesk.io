import { healdeskTextReady } from "@/lib/sms/config";

/**
 * Which Settings switches can be used right now, and why not (owner,
 * 28 October 2026; CLAUDE.md, "Simplicity rule").
 *
 * The one place these rules live. The Settings page, the wizard, the server
 * writer and the notice after a change all read this module, so a switch cannot
 * be greyed out on the screen yet accepted by a crafted request, and no rule is
 * written twice. Pure: facts in, answers out, nothing read or written here,
 * except that switchRules reads healdesk's texting number from config when
 * the caller does not pass it (one environment variable, no I/O).
 *
 * The text switch stays locked while healdesk's side is not ready
 * (healdeskTextReady, lib/sms/config.ts: the owner pastes the approved
 * toll-free number's identity into config, and real calls are on; nothing
 * else turns it on; CLAUDE.md, "Inbound only"). The sender needs no business associate
 * agreement (owner, 30 October 2026): the text is fixed words and a link, no
 * treatment, time or amount. Until 29 October 2026 a voice clinic with Stripe could turn it
 * on, which made BAA 1.6.0's "where Practice has chosen that option" a
 * promise nobody keeps; while the number is not ready it cannot be turned
 * on, and a value already on reads as off on the Settings page and in the
 * wizard. resetsAfter still resets only for a lost fact (the number is not
 * the clinic's), so the lock sends no clinic a reset email.
 *
 * The text's rule also carries its five checks, in order (owner, 30 October
 * 2026): phone in the plan, the payment account connected, the clinic's
 * signed agreement covering the text (BAA 1.6.0 or DPA 1.1.0 and later,
 * lib/sms/agreement.ts; spec, "Only under an agreement that covers it"), the
 * switch itself, and healdesk's side (the texting number, and real calls
 * on). The switch can be turned on when every check but its own is met; the
 * assistant offers the text only when all five are (textChecksMet;
 * switch-resets.ts paymentLinkTextOffered reads the same rule). Settings,
 * the wizard and the writers all read this one list, so the checklist the
 * clinic sees cannot disagree with what the server allows.
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
  /**
   * The clinic's own text switch, as stored: only the text's checklist reads
   * it (its "switched on" check). No switch's availability depends on it.
   */
  textPaymentLinkOn?: boolean;
  /**
   * The clinic's accepted agreement carries the text's exception
   * (agreementCoversText, lib/sms/agreement.ts). Only the text reads it;
   * absent is "not covered".
   */
  agreementCoversText?: boolean;
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

/** The clinic's line while healdesk's texting number is not ready. */
export const TEXT_NOT_READY_REASON = "Texting the payment link is not available yet.";

/** The text's line for a clinic without phone. */
export const TEXT_PHONE_ONLY_REASON = "Texting a payment link is for phone calls.";

/** The text's line for a clinic whose signed agreement does not cover it. */
export const TEXT_AGREEMENT_REASON = "Your signed agreement with us does not cover texting callers.";

/** One of the five things that must hold before the text can go, in the order the clinic reads them. */
export type TextCheckId = "phone" | "payments" | "agreement" | "switch" | "healdesk";

export type TextCheck = {
  id: TextCheckId;
  /** What must hold, as the clinic reads it. */
  label: string;
  met: boolean;
  /** Who makes it hold: the clinic, or healdesk. */
  who: "you" | "healdesk";
  /** The button that makes it hold, where the clinic can press one; null otherwise. */
  unlock: SwitchUnlock | null;
  /** The line under an unmet check that nobody at the clinic can act on; null otherwise. */
  waiting: string | null;
};

/**
 * The line under healdesk's own check while it is not met. Never how it
 * works inside, and no promise of a notice: nothing sends one.
 */
export const HEALDESK_SETTING_UP = "We are setting this up. This step turns on by itself when it is ready.";

/**
 * The line under the agreement check while it is not met: the version the
 * clinic signed is older than the one that covers the text, and nothing in
 * the portal can change that by a button.
 */
export const AGREEMENT_NOT_COVERING =
  "The agreement you signed is an earlier version that does not include texting callers, so this step stays off.";

export const TEXT_CHECK_LABELS: Readonly<Record<TextCheckId, string>> = {
  phone: "Phone is part of your plan",
  payments: "Your payment account is connected",
  agreement: "Your agreement covers texting",
  switch: "Texting after a call is switched on",
  healdesk: "Our texting number is ready",
};

/** The text's rule: the switch's answer, and the five checks it is read from. */
export type TextSwitchRule = SwitchRule & { checks: TextCheck[] };

/** Every check met: the switch is on and everything it needs holds. */
export function textChecksMet(checks: readonly TextCheck[]): boolean {
  return checks.every((check) => check.met);
}

/**
 * The checks with the switch's own read from `on`: the wizard's toggle
 * before it is saved. On counts only where the other checks allow it, as
 * textChecks counts the stored choice.
 */
export function withTextSwitch(checks: readonly TextCheck[], on: boolean): TextCheck[] {
  const allowed = checks.every((check) => check.id === "switch" || check.met);
  return checks.map((check) => (check.id === "switch" ? { ...check, met: on && allowed } : check));
}

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

export type SwitchRules = {
  deposits: SwitchRule;
  text_payment_link: TextSwitchRule;
  full_payment: SwitchRule;
};

/**
 * Every payment switch's answer. `senderReady` is healdesk's side of the
 * text (healdeskTextReady, lib/sms/config.ts: the texting number and real
 * calls), read from config unless a caller passes it; it is the only fact
 * here that is not the clinic's.
 */
export function switchRules(facts: SwitchFacts, senderReady: boolean = healdeskTextReady()): SwitchRules {
  return rulesFor(facts, senderReady);
}

/**
 * The rules from the clinic's own facts alone, without the sender lock: what
 * a reset compares before and after a lost fact (resetsAfter, and
 * applySwitchResets in switch-resets.ts). Never for showing or setting a switch.
 */
export function factRules(facts: SwitchFacts): SwitchRules {
  // Neither healdesk's side nor the agreement is a fact a writer can lose,
  // so neither is a reason to reset a switch or email the clinic.
  return rulesFor({ ...facts, agreementCoversText: true }, true);
}

/**
 * The text's five checks, in order. `switch` reads the clinic's stored
 * choice (`facts.textPaymentLinkOn`) in effect: a choice the other checks
 * lock reads as off, as the toggle above it does (settings-view.ts). The
 * switch's own availability never depends on it.
 */
export function textChecks(facts: SwitchFacts, senderReady: boolean): TextCheck[] {
  const check = (id: TextCheckId, met: boolean, who: TextCheck["who"], unlock: SwitchUnlock | null): TextCheck => ({
    id,
    label: TEXT_CHECK_LABELS[id],
    met,
    who,
    unlock: met ? null : unlock,
    waiting: met ? null : id === "healdesk" ? HEALDESK_SETTING_UP : id === "agreement" ? AGREEMENT_NOT_COVERING : null,
  });
  const covered = facts.agreementCoversText === true;
  const others = facts.hasVoice && facts.gatewayConnected && covered && senderReady;
  return [
    check("phone", facts.hasVoice, "you", null),
    check("payments", facts.gatewayConnected, "you", "connect_stripe"),
    check("agreement", covered, "you", null),
    check("switch", facts.textPaymentLinkOn === true && others, "you", null),
    check("healdesk", senderReady, "healdesk", null),
  ];
}

/** The text's rule, from its checks alone: open when every check but the switch's own is met. */
function textRule(checks: readonly TextCheck[]): TextSwitchRule {
  const blocking = checks.find((c) => c.id !== "switch" && !c.met);
  const all = [...checks];
  if (!blocking) return { ...OPEN, checks: all };
  switch (blocking.id) {
    case "phone":
      return { enabled: false, reason: TEXT_PHONE_ONLY_REASON, unlock: null, checks: all };
    case "payments":
      return { ...locked("connect_stripe"), checks: all };
    case "agreement":
      return { enabled: false, reason: TEXT_AGREEMENT_REASON, unlock: null, checks: all };
    default:
      return { enabled: false, reason: TEXT_NOT_READY_REASON, unlock: null, checks: all };
  }
}

function rulesFor(
  facts: SwitchFacts,
  senderReady: boolean,
): SwitchRules {
  const deposits: SwitchRule = !facts.gatewayConnected
    ? locked("connect_stripe")
    : !facts.hasDepositAmount
      ? locked("set_deposit")
      : OPEN;

  const text = textRule(textChecks(facts, senderReady));

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
  // The clinic's facts only: the sender lock is read where the switch is
  // shown and set, never as a reset.
  const rules = factRules(facts);
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
