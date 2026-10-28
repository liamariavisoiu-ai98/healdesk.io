import { and, eq, inArray, sql } from "drizzle-orm";

import {
  agentConfigs,
  appointments,
  clinics,
  clinicSettings,
  clinicSettingsHistory,
  depositPayments,
  PAYMENT_ASKS,
  type AgentService,
  type DepositPaymentStatus,
  type DepositPolicy,
  type DepositUncollectable,
  type PaymentAsk,
} from "@/db/schema";
import { recordSecurityEvent } from "@/lib/audit";
import {
  DEPOSIT_HOLD_MINUTES_MAX,
  DEPOSIT_HOLD_MINUTES_MIN,
  DEPOSIT_UNCOLLECTABLE_OPTIONS,
  getClinicSettings,
} from "@/lib/billing/settings";
import { notifyBookingAlert } from "@/lib/notices/booking-alerts";
import { readCalendarConnected, readHasVoice } from "@/lib/portal/switch-facts";
import { switchRules, type RuledSwitch, type SwitchFacts } from "@/lib/portal/switch-rules";
import type { SettingsHistoryField } from "@/lib/setup/screen-ids";
import type { TenantTx } from "@/lib/tenant";

/**
 * Deposits (build decision BD27): whether a booking needs one, what the
 * assistant does when it does, the clinic's deposit switches, and the
 * deposit's status as the payment link moves.
 *
 * The product spec sets the rules ("Booking behaviour and deposit control",
 * and the Behaviour table in the portal map). Deposits are per service; the
 * clinic decides what happens when one is due and the channel cannot take
 * it; card numbers are never taken, so voice never collects and the chat
 * channels collect only through a hosted link on the clinic's own connected
 * Stripe account (lib/billing/deposit-link.ts).
 *
 * The decision is a pure function so the rules are a table test. Slot holds
 * and releases are not here: they belong to the runtime's booking tool layer,
 * which reads the decision. This module supplies the decision, the deposit
 * status on the appointment and the L10 alert (`deposit_to_collect`) for a
 * deposit that is flagged, held or lapsed, or a booking refused for want of
 * one.
 */

export type DepositChannel = "voice" | "web" | "meta";

/**
 * What the assistant does about a booking:
 *   book               no deposit is due; book as usual;
 *   book_and_flag      book, and flag the deposit for staff to collect;
 *   collect            send a payment link now and hold the slot for the hold window;
 *   hold_and_alert     keep the slot reserved for the hold window and alert staff;
 *   decline_and_alert  do not book; the request goes to staff and staff are alerted.
 */
export type DepositAction =
  "book" | "book_and_flag" | "collect" | "hold_and_alert" | "decline_and_alert";

/** Which rule decided, for the audit trail and the tests. */
export type DepositRule =
  | "no_deposit"
  | "voice_book_without_deposit"
  | "voice_without_deposit_off"
  | "chat_book_without_deposit"
  | "chat_link_lapsed"
  | "chat_collect"
  | "chat_uncollectable";

export type DepositFacts = {
  channel: DepositChannel;
  /** clinic_settings.deposits_enabled: the portal's "Take deposits". */
  depositsEnabled: boolean;
  /** The clinic has a connected Stripe account (clinics.stripe_connect_account_id). */
  isConnected: boolean;
  /** effectiveDepositUsd for the service being booked. */
  amountUsd: number | null;
  /** "Book by phone without a deposit". */
  bookVoiceWithoutDeposit: boolean;
  /** "Book by chat without a deposit", for the website and Meta. */
  bookChatWithoutDeposit: boolean;
  /** "When a deposit cannot be collected". */
  uncollectable: DepositUncollectable;
  /**
   * Chat only: a payment link can be created and sent in this conversation
   * right now (deposits on, connected, the channel can carry a message).
   */
  canCollectNow?: boolean;
  /** Chat only: an earlier `collect` link expired or failed unpaid. */
  linkLapsed?: boolean;
};

export type DepositOutcome = {
  action: DepositAction;
  /** A deposit is due for this booking. */
  isRequired: boolean;
  /** The amount due, in dollars, when one is; otherwise null. */
  amountUsd: number | null;
  rule: DepositRule;
};

/**
 * The decision (BD27), first match wins:
 *
 *   1. No deposit is due when deposits are off, the clinic has no connected
 *      account, or the effective amount is $0 or unknown: book. A $0 amount
 *      means no deposit, which is also why `deposit_payments.amount_cents > 0`
 *      can never be asked to hold one.
 *   2. Voice never collects (the spec: card numbers are never taken, and
 *      voice cannot collect). Its own switch decides, and it beats the
 *      general "cannot be collected" setting: On books and flags the deposit
 *      for staff; Off does not book, routes the caller to staff and alerts
 *      them (spec, "Book by phone without a deposit": "Off means the voice
 *      agent will not book a deposit-required service and routes to staff
 *      instead"). With the general setting deciding instead, the default
 *      `book_and_flag` would make Off mean nothing.
 *   3. Chat (website and Meta), in order: "Book by chat without a deposit"
 *      On books and flags; a link that already lapsed unpaid falls to the
 *      "cannot be collected" setting rather than sending another; a link
 *      that can be sent now is sent (`collect`, holding the slot for the
 *      hold window); otherwise the "cannot be collected" setting decides.
 */
export function depositDecision(facts: DepositFacts): DepositOutcome {
  const amount = normaliseDepositUsd(facts.amountUsd);
  if (!facts.depositsEnabled || !facts.isConnected || amount === null || amount <= 0) {
    return { action: "book", isRequired: false, amountUsd: null, rule: "no_deposit" };
  }
  if (facts.channel === "voice") {
    return facts.bookVoiceWithoutDeposit
      ? {
          action: "book_and_flag",
          isRequired: true,
          amountUsd: amount,
          rule: "voice_book_without_deposit",
        }
      : {
          action: "decline_and_alert",
          isRequired: true,
          amountUsd: amount,
          rule: "voice_without_deposit_off",
        };
  }
  if (facts.bookChatWithoutDeposit) {
    return {
      action: "book_and_flag",
      isRequired: true,
      amountUsd: amount,
      rule: "chat_book_without_deposit",
    };
  }
  if (facts.linkLapsed) {
    return {
      action: facts.uncollectable,
      isRequired: true,
      amountUsd: amount,
      rule: "chat_link_lapsed",
    };
  }
  if (facts.canCollectNow) {
    return { action: "collect", isRequired: true, amountUsd: amount, rule: "chat_collect" };
  }
  return {
    action: facts.uncollectable,
    isRequired: true,
    amountUsd: amount,
    rule: "chat_uncollectable",
  };
}

// -----------------------------------------------------------------------------
// Amounts
// -----------------------------------------------------------------------------

/** A dollar amount as stored, or null when it is missing, not a number or negative. */
export function normaliseDepositUsd(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

/**
 * The clinic default: `agent_configs.deposit_policy.amountUsd` while the
 * policy says a deposit is required. `DepositPolicy.collection` is ignored:
 * how a deposit is collected now follows from the channel and the switches,
 * and the field stays only so old rows still parse.
 */
export function clinicDefaultDepositUsd(policy: DepositPolicy | null | undefined): number | null {
  if (!policy || policy.required !== true) return null;
  return normaliseDepositUsd(policy.amountUsd);
}

/**
 * The amount due for one service: the service's own `depositUsd`, else the
 * clinic default. A service set to 0 asks for no deposit even when the
 * clinic default does; a service left null or unset follows the default.
 */
export function effectiveDepositUsd(input: {
  service?: AgentService | null;
  policy?: DepositPolicy | null;
}): number | null {
  const own = normaliseDepositUsd(input.service?.depositUsd);
  if (own !== null) return own;
  return clinicDefaultDepositUsd(input.policy);
}

function serviceKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The configured service a booking names, matched on the whole name with
 * case and spacing ignored, or null. A free-text name that matches nothing
 * gets the clinic default, never a guess at the nearest service.
 */
export function findService(
  services: readonly AgentService[] | null | undefined,
  name: string | null | undefined,
): AgentService | null {
  if (!services || !name || !name.trim()) return null;
  const wanted = serviceKey(name);
  return services.find((s) => typeof s.name === "string" && serviceKey(s.name) === wanted) ?? null;
}

/** Some service, or the clinic default, asks for a deposit above $0. */
export function hasDepositAmount(
  services: readonly AgentService[] | null | undefined,
  policy: DepositPolicy | null | undefined,
): boolean {
  const fallback = clinicDefaultDepositUsd(policy);
  if (fallback !== null && fallback > 0) return true;
  return (services ?? []).some((s) => {
    const own = normaliseDepositUsd(s.depositUsd);
    return own !== null && own > 0;
  });
}

/** What an alert or a deposit status can point at: ids only. */
export type DepositRef = {
  appointmentId?: string;
  bookingRequestId?: string;
  conversationId?: string;
};

/**
 * What a decision leaves behind, written inside the booking's own
 * transaction by the runtime's booking tool layer once it has booked, held
 * or declined (a call is told with depositLine, lib/booking/lines.ts):
 *
 *   book               nothing;
 *   collect            nothing more: the appointment was inserted owing
 *                      `pending_link` with its amount, and the link is made
 *                      after the transaction (chatDepositFor); one never
 *                      made goes to the desk (lib/billing/deposit-sweep.ts);
 *   book_and_flag      the appointment owes `pending_front_desk` with its
 *                      amount, and staff get the L10 alert;
 *   hold_and_alert     the same, for the held slot, and the alert;
 *   decline_and_alert  no appointment; the alert points at the request or
 *                      the conversation instead.
 *
 * Slot holds and their release stay with the runtime. Every alert carries
 * ids only (lib/notices/booking-alerts.ts).
 */
export async function recordDepositOutcome(
  tx: TenantTx,
  outcome: DepositOutcome,
  ref: DepositRef,
): Promise<void> {
  if (outcome.action === "book" || outcome.action === "collect") return;
  if (ref.appointmentId && outcome.action !== "decline_and_alert") {
    await tx.db
      .update(appointments)
      .set({
        depositStatus: "pending_front_desk",
        depositUsd: outcome.amountUsd === null ? null : String(outcome.amountUsd),
      })
      .where(
        and(
          eq(appointments.id, ref.appointmentId),
          eq(appointments.clinicId, tx.clinicId),
          inArray(appointments.depositStatus, ["none", "pending_link"]),
        ),
      );
  }
  const pointer: DepositRef =
    outcome.action === "decline_and_alert"
      ? {
          ...(ref.bookingRequestId ? { bookingRequestId: ref.bookingRequestId } : {}),
          ...(ref.conversationId ? { conversationId: ref.conversationId } : {}),
        }
      : ref;
  await notifyBookingAlert(tx, "deposit_to_collect", pointer);
}

// -----------------------------------------------------------------------------
// Everything a booking decision needs, read inside the clinic's tenant
// -----------------------------------------------------------------------------

export type ClinicDepositFacts = {
  depositsEnabled: boolean;
  isConnected: boolean;
  bookVoiceWithoutDeposit: boolean;
  bookChatWithoutDeposit: boolean;
  uncollectable: DepositUncollectable;
  holdMinutes: number;
  services: AgentService[];
  policy: DepositPolicy | null;
};

/** The switches, the connection and the configured amounts of the tenant clinic. */
export async function readClinicDepositFacts(tx: TenantTx): Promise<ClinicDepositFacts> {
  const settings = await getClinicSettings(tx);
  const [clinic] = await tx.db
    .select({ accountId: clinics.stripeConnectAccountId })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  const [agent] = await tx.db
    .select({ services: agentConfigs.services, policy: agentConfigs.depositPolicy })
    .from(agentConfigs)
    .where(eq(agentConfigs.clinicId, tx.clinicId))
    .limit(1);
  return {
    depositsEnabled: settings.depositsEnabled,
    isConnected: Boolean(clinic?.accountId),
    bookVoiceWithoutDeposit: settings.bookVoiceWithoutDeposit,
    bookChatWithoutDeposit: settings.bookChatWithoutDeposit,
    uncollectable: settings.depositUncollectable,
    holdMinutes: settings.depositHoldMinutes,
    services: agent?.services ?? [],
    policy: agent?.policy ?? null,
  };
}

// -----------------------------------------------------------------------------
// The deposit switches (R24)
// -----------------------------------------------------------------------------

export type DepositSettings = {
  depositsEnabled: boolean;
  bookVoiceWithoutDeposit: boolean;
  bookChatWithoutDeposit: boolean;
  depositUncollectable: DepositUncollectable;
  depositHoldMinutes: number;
  /** "Text the payment link" after a call: the clinic's choice, off by default. */
  textPaymentLink: boolean;
  /** What the assistant asks the patient to pay. */
  paymentAsk: PaymentAsk;
  /** Auto-confirm bookings, a fact the full-payment rule weighs (switch-rules.ts). */
  autoConfirm: boolean;
  /** The calendar is connected and working (switch-facts.ts). */
  calendarConnected: boolean;
  /** The clinic bought phone. */
  hasVoice: boolean;
  isConnected: boolean;
  connectedAt: Date | null;
  disconnectedAt: Date | null;
  /** The clinic default in dollars (deposit_policy), or null. */
  defaultAmountUsd: number | null;
  /** Some service, or the clinic default, asks for a deposit above $0. */
  hasDepositAmount: boolean;
  /** Turning "Take deposits" on would be accepted now: connected, with an amount. */
  canEnable: boolean;
};

/** The tenant clinic's deposit switches, with the facts that decide whether they can be on. */
export async function getDepositSettings(tx: TenantTx): Promise<DepositSettings> {
  const settings = await getClinicSettings(tx);
  const [clinic] = await tx.db
    .select({
      accountId: clinics.stripeConnectAccountId,
      connectedAt: clinics.stripeConnectConnectedAt,
      disconnectedAt: clinics.stripeConnectDisconnectedAt,
    })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  const [agent] = await tx.db
    .select({ services: agentConfigs.services, policy: agentConfigs.depositPolicy })
    .from(agentConfigs)
    .where(eq(agentConfigs.clinicId, tx.clinicId))
    .limit(1);
  const isConnected = Boolean(clinic?.accountId);
  const amount = hasDepositAmount(agent?.services, agent?.policy);
  return {
    depositsEnabled: settings.depositsEnabled,
    bookVoiceWithoutDeposit: settings.bookVoiceWithoutDeposit,
    bookChatWithoutDeposit: settings.bookChatWithoutDeposit,
    depositUncollectable: settings.depositUncollectable,
    depositHoldMinutes: settings.depositHoldMinutes,
    textPaymentLink: settings.textPaymentLink,
    paymentAsk: settings.paymentAsk,
    autoConfirm: settings.autoConfirmBookings,
    calendarConnected: await readCalendarConnected(tx),
    hasVoice: await readHasVoice(tx),
    isConnected,
    connectedAt: isConnected ? (clinic?.connectedAt ?? null) : null,
    disconnectedAt: clinic?.disconnectedAt ?? null,
    defaultAmountUsd: clinicDefaultDepositUsd(agent?.policy),
    hasDepositAmount: amount,
    canEnable: isConnected && amount,
  };
}

export type DepositSettingsPatch = Partial<{
  depositsEnabled: boolean;
  bookVoiceWithoutDeposit: boolean;
  bookChatWithoutDeposit: boolean;
  depositUncollectable: DepositUncollectable;
  depositHoldMinutes: number;
  textPaymentLink: boolean;
  paymentAsk: PaymentAsk;
}>;

/** The facts the payment switches' rules weigh, from what getDepositSettings read. */
export function switchFactsOf(settings: DepositSettings): SwitchFacts {
  return {
    gatewayConnected: settings.isConnected,
    hasDepositAmount: settings.hasDepositAmount,
    calendarConnected: settings.calendarConnected,
    autoConfirm: settings.autoConfirm,
    hasVoice: settings.hasVoice,
  };
}

/**
 * Why an edit was refused: a closed code for the caller, and words for the
 * person. `unavailable` is a payment switch the rules say cannot be turned
 * on now (lib/portal/switch-rules.ts), refused with the rule's own reason.
 */
export type DepositSettingsRefusal = "invalid" | "not_connected" | "no_amount" | "unavailable";

export class DepositSettingsError extends Error {
  constructor(
    readonly field: keyof DepositSettingsPatch,
    readonly code: DepositSettingsRefusal,
    message: string,
  ) {
    super(message);
    this.name = "DepositSettingsError";
  }
}

function requireBoolean(field: keyof DepositSettingsPatch, value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new DepositSettingsError(field, "invalid", "Choose on or off.");
  }
  return value;
}

/**
 * Change the tenant clinic's deposit switches; the only writer meant for
 * `deposits_enabled` (R24, which also takes it out of updateClinicSettings's
 * patch, so the rule below cannot be walked around).
 *
 * Turning "Take deposits" on is refused unless the clinic has a connected
 * Stripe account and some amount above $0 to ask for (a service's
 * `depositUsd` or the clinic default): on without either, the assistant
 * would promise a link it cannot create. It is checked only when the switch
 * goes from off to on, so re-saving a form that already shows it on is not
 * refused because an amount was later removed; with no amount the decision
 * books without a deposit anyway. The hold and the "cannot be collected"
 * choice are validated with words a person can act on, as the column
 * CHECKs would refuse them less helpfully.
 *
 * Only what changes is written. The audit row carries field names, booleans,
 * enums and minutes. `actorLabel` (a device label from the portal, or an
 * operator) goes on the security event recorded when "Take deposits" is
 * switched on or off, the one change that decides whether the assistant can
 * send patients a payment link at all.
 *
 * It is also the one writer of the two payment switches (owner, 28 October
 * 2026): "Text the payment link" and what the assistant asks the patient to
 * pay. Turning either on is refused, with the rule's own sentence, while
 * lib/portal/switch-rules.ts says it is unavailable; turning it off, or back
 * to deposit only, never is. A change to any of the three payment switches
 * keeps its before and after in clinic_settings_history. `options.reason`
 * goes on the audit row when the change is a reset rather than a person's.
 */
export async function setDepositSettings(
  tx: TenantTx,
  patch: DepositSettingsPatch,
  actorLabel: string,
  now: Date = new Date(),
  options: { reason?: string } = {},
): Promise<DepositSettings> {
  return (await writeDepositSettings(tx, patch, actorLabel, now, options)).settings;
}

/** setDepositSettings, also answering with the clinic_settings_history rows it wrote. */
export async function writeDepositSettings(
  tx: TenantTx,
  patch: DepositSettingsPatch,
  actorLabel: string,
  now: Date = new Date(),
  options: { reason?: string } = {},
): Promise<{ settings: DepositSettings; historyIds: string[] }> {
  const wanted: DepositSettingsPatch = {};
  if (patch.depositsEnabled !== undefined) {
    wanted.depositsEnabled = requireBoolean("depositsEnabled", patch.depositsEnabled);
  }
  if (patch.bookVoiceWithoutDeposit !== undefined) {
    wanted.bookVoiceWithoutDeposit = requireBoolean(
      "bookVoiceWithoutDeposit",
      patch.bookVoiceWithoutDeposit,
    );
  }
  if (patch.bookChatWithoutDeposit !== undefined) {
    wanted.bookChatWithoutDeposit = requireBoolean(
      "bookChatWithoutDeposit",
      patch.bookChatWithoutDeposit,
    );
  }
  if (patch.depositUncollectable !== undefined) {
    if (!DEPOSIT_UNCOLLECTABLE_OPTIONS.includes(patch.depositUncollectable)) {
      throw new DepositSettingsError(
        "depositUncollectable",
        "invalid",
        "Choose what happens when a deposit cannot be collected: book and flag it, hold the slot and alert staff, or do not book and alert staff.",
      );
    }
    wanted.depositUncollectable = patch.depositUncollectable;
  }
  if (patch.depositHoldMinutes !== undefined) {
    const minutes: unknown = patch.depositHoldMinutes;
    if (
      typeof minutes !== "number" ||
      !Number.isInteger(minutes) ||
      minutes < DEPOSIT_HOLD_MINUTES_MIN ||
      minutes > DEPOSIT_HOLD_MINUTES_MAX
    ) {
      throw new DepositSettingsError(
        "depositHoldMinutes",
        "invalid",
        `The hold must be a whole number of minutes from ${DEPOSIT_HOLD_MINUTES_MIN} to ${DEPOSIT_HOLD_MINUTES_MAX} (24 hours).`,
      );
    }
    wanted.depositHoldMinutes = minutes;
  }
  if (patch.textPaymentLink !== undefined) {
    wanted.textPaymentLink = requireBoolean("textPaymentLink", patch.textPaymentLink);
  }
  if (patch.paymentAsk !== undefined) {
    if (!(PAYMENT_ASKS as readonly unknown[]).includes(patch.paymentAsk)) {
      throw new DepositSettingsError(
        "paymentAsk",
        "invalid",
        "Choose deposit only or full payment.",
      );
    }
    wanted.paymentAsk = patch.paymentAsk;
  }

  const current = await getDepositSettings(tx);
  if (wanted.depositsEnabled === true && !current.depositsEnabled) {
    if (!current.isConnected) {
      throw new DepositSettingsError(
        "depositsEnabled",
        "not_connected",
        "Connect your Stripe account before turning deposits on: deposits are paid straight into it.",
      );
    }
    if (!current.hasDepositAmount) {
      throw new DepositSettingsError(
        "depositsEnabled",
        "no_amount",
        "Set a deposit amount on a service, or a default amount, before turning deposits on.",
      );
    }
  }

  // The text and full payment are switched on only where the rules allow
  // it, in their own words (the page greys them out with the same answer);
  // off, and back to deposit only, are always allowed.
  const rules = switchRules(switchFactsOf(current));
  if (wanted.textPaymentLink === true && !current.textPaymentLink) {
    refuseUnless(rules, "text_payment_link", "textPaymentLink");
  }
  if (wanted.paymentAsk === "full_payment" && current.paymentAsk !== "full_payment") {
    refuseUnless(rules, "full_payment", "paymentAsk");
  }

  const keys = [
    "depositsEnabled",
    "bookVoiceWithoutDeposit",
    "bookChatWithoutDeposit",
    "depositUncollectable",
    "depositHoldMinutes",
    "textPaymentLink",
    "paymentAsk",
  ] as const;
  const values: Partial<typeof clinicSettings.$inferInsert> = {};
  const audit: Record<string, boolean | number | string> = {};
  for (const key of keys) {
    const next = wanted[key];
    if (next === undefined || next === current[key]) continue;
    (values as Record<string, unknown>)[key] = next;
    audit[key] = next;
  }
  if (Object.keys(values).length === 0) return { settings: current, historyIds: [] };

  await tx.db
    .insert(clinicSettings)
    .values({ clinicId: tx.clinicId, ...values, updatedAt: now })
    .onConflictDoUpdate({ target: clinicSettings.clinicId, set: { ...values, updatedAt: now } });

  // The three payment switches keep their before and after, whoever changed
  // them: the clinic, an operator, or a reset after a lost fact
  // (lib/portal/switch-resets.ts, which passes its reason here).
  const history = (Object.keys(PAYMENT_HISTORY) as (keyof typeof PAYMENT_HISTORY)[])
    .filter((key) => values[key] !== undefined)
    .map((key) => ({
      clinicId: tx.clinicId,
      field: PAYMENT_HISTORY[key],
      beforeValue: String(current[key]),
      afterValue: String(values[key]),
      actorLabel: (actorLabel || "system").slice(0, 200),
      changedAt: now,
    }));
  const historyIds =
    history.length > 0
      ? (
          await tx.db
            .insert(clinicSettingsHistory)
            .values(history)
            .returning({ id: clinicSettingsHistory.id })
        ).map((row) => row.id)
      : [];

  tx.audit.record({
    action: "update",
    resourceType: "clinic_settings",
    resourceId: tx.clinicId,
    metadata: {
      fields: Object.keys(audit).sort(),
      ...audit,
      ...(options.reason ? { reason: options.reason } : {}),
    },
  });
  if (values.depositsEnabled !== undefined) {
    await recordSecurityEvent(tx.db, {
      event: values.depositsEnabled ? "deposits_switched_on" : "deposits_switched_off",
      actorLabel: actorLabel.slice(0, 200),
      metadata: { clinicId: tx.clinicId },
    });
  }
  return { settings: await getDepositSettings(tx), historyIds };
}

/** The payment switches clinic_settings_history keeps, by their column. */
const PAYMENT_HISTORY = {
  depositsEnabled: "deposits_enabled",
  textPaymentLink: "text_payment_link",
  paymentAsk: "payment_ask",
} as const satisfies Record<string, SettingsHistoryField>;

/** Refuse turning a payment switch on while its rule says it is unavailable, with the rule's reason. */
function refuseUnless(
  rules: ReturnType<typeof switchRules>,
  which: RuledSwitch,
  field: keyof DepositSettingsPatch,
): void {
  const rule = rules[which];
  if (!rule.enabled) {
    throw new DepositSettingsError(field, "unavailable", rule.reason ?? "That can't be turned on yet.");
  }
}

/**
 * Switch "Take deposits" off, from the Connect side: a disconnect, or Stripe
 * telling us the clinic revoked our access. Not a settings edit, so it is
 * recorded by the caller's own audit row rather than as one here.
 */
export async function switchDepositsOff(tx: TenantTx, now: Date): Promise<void> {
  await tx.db
    .insert(clinicSettings)
    .values({ clinicId: tx.clinicId, depositsEnabled: false, updatedAt: now })
    .onConflictDoUpdate({
      target: clinicSettings.clinicId,
      set: { depositsEnabled: false, updatedAt: now },
      setWhere: sql`${clinicSettings.depositsEnabled} = true`,
    });
}

// -----------------------------------------------------------------------------
// The deposit's status as its link moves
// -----------------------------------------------------------------------------

/**
 * Record a deposit as paid: the row, conditional on `open`, so two
 * deliveries of the same Stripe event (which Checkout documents as possible,
 * concurrently) mark it once; then its appointment, from whichever pending
 * state it was in. Returns whether this call changed the row.
 */
export async function recordDepositPaid(
  tx: TenantTx,
  input: { depositId: string; eventId: string | null; at: Date },
): Promise<{ changed: boolean; appointmentId: string | null }> {
  const [row] = await tx.db
    .update(depositPayments)
    .set({ status: "paid", paidAt: input.at, lastEventId: input.eventId, updatedAt: input.at })
    .where(
      and(
        eq(depositPayments.id, input.depositId),
        eq(depositPayments.clinicId, tx.clinicId),
        eq(depositPayments.status, "open"),
      ),
    )
    .returning({ appointmentId: depositPayments.appointmentId });
  if (!row) return { changed: false, appointmentId: null };
  if (row.appointmentId) {
    await tx.db
      .update(appointments)
      .set({ depositStatus: "paid" })
      .where(
        and(
          eq(appointments.id, row.appointmentId),
          eq(appointments.clinicId, tx.clinicId),
          inArray(appointments.depositStatus, ["pending_link", "pending_front_desk"]),
        ),
      );
  }
  tx.audit.record({
    action: "update",
    resourceType: "deposit_payment",
    resourceId: input.depositId,
    metadata: { outcome: "paid" },
  });
  return { changed: true, appointmentId: row.appointmentId };
}

/**
 * Record that a deposit link will not be paid: it expired, the payment
 * failed, or we cancelled it ourselves (a disconnect). The row moves only
 * from the states listed in `from`; its appointment then moves from
 * `pending_link` to `pending_front_desk`, and staff get the L10 alert,
 * because the deposit is now theirs to collect.
 */
export async function recordDepositLapsed(
  tx: TenantTx,
  input: {
    depositId: string;
    status: Extract<DepositPaymentStatus, "expired" | "failed" | "cancelled">;
    from: readonly DepositPaymentStatus[];
    eventId: string | null;
    at: Date;
  },
): Promise<{ changed: boolean; appointmentId: string | null }> {
  const [row] = await tx.db
    .update(depositPayments)
    .set({ status: input.status, lastEventId: input.eventId, updatedAt: input.at })
    .where(
      and(
        eq(depositPayments.id, input.depositId),
        eq(depositPayments.clinicId, tx.clinicId),
        inArray(depositPayments.status, [...input.from]),
      ),
    )
    .returning({ appointmentId: depositPayments.appointmentId });
  if (!row) return { changed: false, appointmentId: null };
  tx.audit.record({
    action: "update",
    resourceType: "deposit_payment",
    resourceId: input.depositId,
    metadata: { outcome: input.status },
  });
  if (row.appointmentId) await flagForFrontDesk(tx, row.appointmentId);
  return { changed: true, appointmentId: row.appointmentId };
}

/**
 * Hand an appointment's deposit to the front desk: `pending_link` becomes
 * `pending_front_desk` and staff get the L10 alert. A no-op for an
 * appointment in any other state, so a late or repeated event cannot
 * undo `paid` or alert twice.
 *
 * `mayBePaid` is for a link nobody could check (a disconnect that lost access
 * to the account, or Stripe unreachable while expiring it): the patient may
 * already have paid it, so the alert carries the flag and its template says
 * to check Stripe before collecting. Without it staff would ask again and
 * the patient could be charged twice (R23, BookingAlertRef.mayBePaid).
 */
export async function flagForFrontDesk(
  tx: TenantTx,
  appointmentId: string,
  options: { mayBePaid?: boolean } = {},
): Promise<boolean> {
  const moved = await tx.db
    .update(appointments)
    .set({ depositStatus: "pending_front_desk" })
    .where(
      and(
        eq(appointments.id, appointmentId),
        eq(appointments.clinicId, tx.clinicId),
        eq(appointments.depositStatus, "pending_link"),
      ),
    )
    .returning({ id: appointments.id });
  if (moved.length === 0) return false;
  await notifyBookingAlert(tx, "deposit_to_collect", {
    appointmentId,
    ...(options.mayBePaid ? { mayBePaid: true } : {}),
  });
  return true;
}
