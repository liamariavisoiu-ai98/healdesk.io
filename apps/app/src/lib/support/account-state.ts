import {
  CARRIERS,
  CHANNEL_NAMES,
  COVERAGE_MODE_OPTIONS,
  getPlan,
  isPlanId,
  type BillingInterval,
  type Channel,
  type CoverageModeId,
} from "@healdesk/catalog";
import type { BillingStatus, ChannelWaitingOn } from "@/db/schema";
import type { BillingSummary } from "@/lib/billing/summary";
import { isPaused, type ChannelStatus } from "@/lib/channels/state";
import type { CalendarConnectionView } from "@/lib/connections/google-calendar";
import type { PracticeState } from "@/lib/engine/practice/state";
import { actionLine, channelNextStep } from "@/lib/setup/channels";
import { stepsLeft, wizardFinished } from "@/lib/setup/screens";
import type { SetupState } from "@/lib/setup/state";
import { buildTracker, type StageId, type StageState } from "@/lib/setup/tracker";
import { formatPhone } from "@/lib/setup/help";

/**
 * `get_account_state` (plan Part H): the clinic's setup, channel and billing
 * state as plain facts, for the support chat to answer "why is my phone not
 * working" with this account's answer rather than an article (spec, "Knows
 * the state of the account it is sitting in").
 *
 * The same object is what an escalation emails to hello@ (I3), so it is
 * shaped for the email payload allowlist (lib/email/lint.ts): ids, counts,
 * ISO dates, catalog categories, flags, plan and channel ids, the clinic's
 * name and its own numbers, and rows of those. Business data only: the
 * practice, its settings, its channels and its subscription. Nothing about a
 * patient, and no text anyone typed (not the greeting, not Knowledge).
 *
 * Pure: account-reader.ts reads the facts inside the clinic's tenant, and the
 * escalation template renders them without a database.
 */

export type ChannelRow = {
  channel: Channel;
  status: ChannelStatus;
  /** The clinic's one outstanding step for it, or null when there is none. */
  waitingOn: ChannelWaitingOn | "finish_setup" | "preparing" | null;
  isEnabled: boolean;
  liveAt: string | null;
};

export type StageRow = { code: StageId; status: StageState };

export type ConnectionRow = {
  resource: "google_calendar" | "payment_account";
  status: "not_connected" | "active" | "degraded" | "error" | "pending" | "connected";
};

export type UsageRow = { meter: string; used: number; included: number };

export type AccountState = {
  clinicId: string;
  clinicName: string;
  /** Offboarding has started: the account is closed and read-only. */
  isClosed: boolean;
  isSetupFinished: boolean;
  /** How many of the wizard's four steps still have something to answer. */
  setupStepsLeftCount: number;
  /** Before the plan starts: the end of the 30 days to finish setup. */
  setupDeadlineAt: string | null;
  stageRows: StageRow[];
  channelRows: ChannelRow[];
  isPaused: boolean;
  pausedUntilAt: string | null;
  /** The coverage mode, when phone was bought. */
  mode: CoverageModeId | null;
  carrier: string | null;
  phoneSystem: string | null;
  publishedPhoneE164: string | null;
  directLineE164: string | null;
  isUrgentHelpSet: boolean;
  isTransferOn: boolean;
  isDailySummaryOn: boolean;
  isDepositsOn: boolean;
  connectionRows: ConnectionRow[];
  /** The package and usage steps bought. */
  planId: string | null;
  interval: BillingInterval | null;
  /** The subscription's status. */
  status: BillingStatus | null;
  isPlanStarted: boolean;
  planStartedAt: string | null;
  isAutoRenewOn: boolean | null;
  /** When the account closes, if it is set to. */
  closesOn: string | null;
  overageMode: "allow" | "hard_cap" | null;
  isUsageAlertsOn: boolean | null;
  hasOpenInvoice: boolean;
  graceEndsAt: string | null;
  usageRows: UsageRow[];
  /** Mail to the clinic's address bounced, was marked as spam or is suppressed. */
  isAddressUndeliverable: boolean;
};

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

function catalogPlanId(value: string | null): string | null {
  return value && isPlanId(value) ? value : null;
}

function calendarStatus(view: CalendarConnectionView | null): ConnectionRow["status"] {
  return view ? view.status : "not_connected";
}

/** The pure half: the facts from what the readers returned. */
export function accountStateFrom(input: {
  state: SetupState;
  carrier: string | null;
  phoneSystem: string | null;
  pausedAt: Date | null;
  pausedUntil: Date | null;
  depositsOn: boolean;
  paymentConnected: boolean;
  calendar: CalendarConnectionView | null;
  /** Where the practice questions stand, as readPracticeState read it: the tracker's last two stages. */
  practice: PracticeState;
  summary: BillingSummary | null;
  addressUndeliverable: boolean;
  now: Date;
}): AccountState {
  const { state, summary, now } = input;
  const finished = wizardFinished(state.screens, state.progress);
  const voice = state.channels.some((c) => c.channel === "voice");
  const tracker = input.calendar ? buildTracker(state, input.calendar, input.practice) : null;
  const paused = isPaused({ pausedAt: input.pausedAt, pausedUntil: input.pausedUntil }, now);
  return {
    clinicId: state.clinic.id,
    clinicName: state.clinic.name,
    isClosed: state.clinic.offboardingStartedAt !== null,
    isSetupFinished: finished,
    setupStepsLeftCount: stepsLeft(state.screens, state.progress),
    setupDeadlineAt: summary?.setupDeadlineAt ?? iso(state.billing?.setupDeadlineAt),
    stageRows: tracker ? tracker.stages.map((s) => ({ code: s.id, status: s.state })) : [],
    channelRows: state.channels.map((c) => {
      const step = channelNextStep(c, finished);
      return {
        channel: c.channel,
        status: c.status,
        waitingOn: step === "none" ? null : step,
        isEnabled: c.enabled,
        liveAt: iso(c.liveAt),
      };
    }),
    isPaused: paused,
    pausedUntilAt: paused ? iso(input.pausedUntil) : null,
    mode: voice ? state.settings.coverageMode : null,
    carrier: voice ? input.carrier : null,
    phoneSystem: voice ? input.phoneSystem : null,
    publishedPhoneE164: state.clinic.publishedPhoneE164,
    directLineE164: state.settings.directLineE164,
    isUrgentHelpSet: state.settings.urgentHelpE164 !== null,
    // On while the switch is: with no transfer number, calls go to the direct line (voice/retell.ts, liveTransferLine).
    isTransferOn: state.settings.transferLiveCalls && (state.settings.transferE164 ?? state.settings.directLineE164) !== null,
    isDailySummaryOn: state.settings.dailySummary,
    isDepositsOn: input.depositsOn,
    connectionRows: [
      { resource: "google_calendar", status: calendarStatus(input.calendar) },
      {
        resource: "payment_account",
        status: input.paymentConnected ? "connected" : "not_connected",
      },
    ],
    // A catalog plan id only: a clinic on a code that predates the catalog's
    // grid has none, and the email's allowlist would refuse it.
    planId: catalogPlanId(summary?.boughtPlanId ?? state.billing?.boughtPlanId ?? null),
    interval: summary?.interval ?? state.billing?.interval ?? null,
    status: summary?.status ?? state.billing?.status ?? null,
    isPlanStarted: summary?.isPlanStarted ?? (state.billing?.planStartedAt ?? null) !== null,
    planStartedAt: summary?.planStartedAt ?? iso(state.billing?.planStartedAt),
    isAutoRenewOn: summary ? summary.isAutoRenewOn : null,
    closesOn: summary?.closesOn ?? null,
    overageMode: summary?.overageMode ?? null,
    isUsageAlertsOn: summary ? summary.usageAlertsEnabled : null,
    hasOpenInvoice: Boolean(summary?.openInvoice),
    graceEndsAt: summary?.graceEndsAt ?? null,
    usageRows: (summary?.usage ?? []).map((u) => ({
      meter: u.meter,
      used: u.used,
      included: u.included,
    })),
    isAddressUndeliverable: input.addressUndeliverable,
  };
}

// -----------------------------------------------------------------------------
// In words: the same facts for the model and for the email to hello@
// -----------------------------------------------------------------------------

const STAGE_LABELS: Readonly<Record<StageId, string>> = {
  agreement: "Agreement signed",
  payment: "Payment",
  website: "Your website read",
  answers: "Your answers set up",
  calendar: "Calendar",
  built: "Assistant built",
  practice_questions: "Practice questions passed",
  // Home's tracker shows it; the support chat's tracker is built without it.
  go_live: "Going live",
};

const STAGE_WORDS: Readonly<Record<StageState, string>> = {
  done: "done",
  not_done: "not yet",
  info: "for now",
};

const CONNECTION_LABELS: Readonly<Record<ConnectionRow["resource"], string>> = {
  google_calendar: "Google Calendar",
  payment_account: "Payment account (Stripe)",
};

const CONNECTION_WORDS: Readonly<Record<ConnectionRow["status"], string>> = {
  not_connected: "not connected",
  active: "connected and working",
  degraded: "connected, with problems (bookings may arrive as requests)",
  error: "broken: bookings arrive as requests until it is reconnected",
  pending: "connecting",
  connected: "connected",
};

/** A channel's status for a reader outside the practice: the model, and hello@. */
const CHANNEL_STATUS_WORDS: Readonly<Record<ChannelStatus, string>> = {
  off: "off",
  paused: "paused",
  live: "live",
  waiting: "ready on healdesk's side, waiting on the practice",
  setting_up: "being prepared by healdesk",
};

const METER_LABELS: Readonly<Record<string, string>> = {
  voice_minutes: "Voice minutes",
  chat_conversations: "Chat conversations",
};

function day(value: string | null): string {
  return value ? value.slice(0, 10) : "not set";
}

function yesNo(value: boolean | null): string {
  return value === null ? "unknown" : value ? "on" : "off";
}

function waitingWords(row: ChannelRow): string {
  if (row.waitingOn === null) return "";
  if (row.waitingOn === "preparing")
    return "; being prepared on healdesk's side, nothing for the practice to do yet";
  if (row.waitingOn === "finish_setup") return "; waiting for the practice to finish setup";
  const action = actionLine(row.channel, row.waitingOn);
  if (!action) return "";
  // Written to the practice ("your website"); here it is read about the practice.
  const step = action.replace(/\byour\b/g, "its");
  return `; next step for the practice: ${step.charAt(0).toLowerCase()}${step.slice(1)}`;
}

/**
 * The facts as lines: label, then value. Used for the model's tool result
 * and for the escalation email, so hello@ reads exactly what the chat knew.
 */
export function describeAccountState(account: AccountState): (readonly [string, string])[] {
  const rows: [string, string][] = [];
  const plan = account.planId ? getPlan(account.planId) : undefined;
  rows.push(["Practice", account.clinicName]);
  rows.push(["Practice id", account.clinicId]);
  if (account.isClosed) rows.push(["Account", "closed (read-only until its data is destroyed)"]);
  rows.push([
    "Setup",
    account.isSetupFinished
      ? "finished"
      : `not finished: ${account.setupStepsLeftCount} of 4 steps still to do`,
  ]);
  if (account.setupDeadlineAt && !account.isPlanStarted) {
    rows.push(["Setup must be finished by", day(account.setupDeadlineAt)]);
  }
  for (const stage of account.stageRows) {
    rows.push([`Build: ${STAGE_LABELS[stage.code]}`, STAGE_WORDS[stage.status]]);
  }
  for (const channel of account.channelRows) {
    rows.push([
      `Channel: ${CHANNEL_NAMES[channel.channel]}`,
      `${CHANNEL_STATUS_WORDS[channel.status]}${channel.isEnabled ? "" : " (switched off in Settings)"}${channel.liveAt ? `, live since ${day(channel.liveAt)}` : ""}${waitingWords(channel)}`,
    ]);
  }
  if (account.isPaused) {
    rows.push([
      "AYA paused",
      account.pausedUntilAt ? `until ${account.pausedUntilAt}` : "until someone turns her back on",
    ]);
  }
  if (account.mode) {
    const mode = COVERAGE_MODE_OPTIONS.find((m) => m.id === account.mode);
    rows.push(["Which calls reach AYA", mode?.label ?? account.mode]);
    const carrier = CARRIERS.find((c) => c.id === account.carrier);
    rows.push(["Phone carrier", carrier?.name ?? "not given"]);
    rows.push([
      "Phone system",
      account.phoneSystem === "voip"
        ? "cloud phone system"
        : account.phoneSystem === "landline"
          ? "landline"
          : "not given",
    ]);
    rows.push([
      "Direct line",
      account.directLineE164 ? formatPhone(account.directLineE164) : "not set",
    ]);
  }
  if (account.publishedPhoneE164) {
    rows.push(["Main phone number", formatPhone(account.publishedPhoneE164)]);
  }
  rows.push(["Urgent-help number", account.isUrgentHelpSet ? "set" : "not set"]);
  rows.push(["Transfer live calls", account.isTransferOn ? "on" : "off"]);
  rows.push(["Daily summary email", yesNo(account.isDailySummaryOn)]);
  rows.push(["Take deposits", yesNo(account.isDepositsOn)]);
  for (const connection of account.connectionRows) {
    rows.push([CONNECTION_LABELS[connection.resource], CONNECTION_WORDS[connection.status]]);
  }
  rows.push(["Package", plan ? plan.name : (account.planId ?? "none")]);
  if (account.interval) rows.push(["Billing", account.interval === "year" ? "annual" : "monthly"]);
  if (account.status) rows.push(["Subscription status", account.status]);
  rows.push([
    "Plan started",
    account.isPlanStarted
      ? `yes, on ${day(account.planStartedAt)}`
      : "not yet: it starts the day AYA first answers a patient or client",
  ]);
  if (account.isAutoRenewOn !== null) rows.push(["Auto-renew", yesNo(account.isAutoRenewOn)]);
  if (account.closesOn) rows.push(["Account closes on", day(account.closesOn)]);
  if (account.overageMode) {
    rows.push([
      "When the monthly allowance runs out",
      account.overageMode === "allow"
        ? "keep going and bill the extra in blocks of 100"
        : "stop and fall back to the direct line and a contact form",
    ]);
  }
  if (account.isUsageAlertsOn !== null) rows.push(["Usage alerts", yesNo(account.isUsageAlertsOn)]);
  if (account.hasOpenInvoice) rows.push(["Unpaid invoice", "yes, see Billing"]);
  if (account.graceEndsAt) rows.push(["Payment grace period ends", day(account.graceEndsAt)]);
  for (const usage of account.usageRows) {
    rows.push([
      `Used this period: ${METER_LABELS[usage.meter] ?? usage.meter}`,
      `${usage.used} of ${usage.included}`,
    ]);
  }
  rows.push([
    "The practice's email address",
    account.isAddressUndeliverable
      ? "undeliverable: mail to it bounced or was refused"
      : "deliverable",
  ]);
  return rows;
}
