import { createHash } from "node:crypto";

import { MAX_SKEW_SECONDS, type Channel } from "@healdesk/catalog";
import { and, desc, eq, gt, inArray } from "drizzle-orm";

import { unsafeDb } from "@/db";
import {
  billingEvents,
  billingNotices,
  billingRequests,
  billingTransitions,
  overageInvoices,
  stripeConnectEvents,
  stripeConnectStates,
  type BillingActor,
  type BillingRequest,
  type BillingRequestKind,
  type BillingRequestOutcome,
  type BillingRequestReason,
  type BillingStatus,
  type ChannelWaitingOn,
  type DepositUncollectable,
  type UsageMeter,
} from "@/db/schema";
import {
  ConnectError,
  connectAccountLabel,
  disconnectStripeConnect,
  mintConnectState,
  type ConnectRefusal,
} from "@/lib/billing/connect";
import { CONNECT_EVENT_CODES, replayConnectEvent } from "@/lib/billing/connect-events";
import {
  DepositSettingsError,
  getDepositSettings,
  setDepositSettings,
  type DepositSettings,
  type DepositSettingsPatch,
} from "@/lib/billing/deposits";
import {
  getEntitlements,
  getEntitlementsForUpdate,
  hasPlanStarted,
  refundEligibleUntil,
  refundWindowOpen,
  setOverageMode,
  setUsageAlertsEnabled,
} from "@/lib/billing/entitlements";
import { replayBillingEvent } from "@/lib/billing/events";
import { stripeErrorCode } from "@/lib/billing/metered-items";
import { deliverCriticalAfterCommit } from "@/lib/billing/notices";
import { STUCK_AFTER_MS } from "@/lib/billing/reconcile";
import {
  closeUnfinishedSetup,
  readBillingGroupChannels,
  rearmBillingRequest,
} from "@/lib/billing/requests";
import {
  ClinicSettingsError,
  getClinicSettings,
  type ClinicSettings,
  type ClinicSettingsPatch,
} from "@/lib/billing/settings";
import {
  commitRefund,
  previewRefund,
  setAutoRenew,
  type RefundKind,
} from "@/lib/billing/stripe-actions";
import { stripeConfigured } from "@/lib/billing/stripe-client";
import { closesAt, isoDay, pendingPlanChangeOf } from "@/lib/billing/summary";
import {
  extendSetupDeadline,
  liftSuspension,
  retryLocationSetup,
  retryOverageInvoice,
} from "@/lib/billing/support";
import { usageSnapshot } from "@/lib/billing/usage";
import { updateClinicSettingsRecordingPause } from "@/lib/channels/pause";
import { isPaused, type ChannelStatus } from "@/lib/channels/state";
import { scrub } from "@/lib/log";
import { listClinics as listClinicOverviews } from "@/lib/ops/clinics";
import { getJob, JOB_SETUP_CLOSURE } from "@/lib/scheduler/jobs";
import { withTenant } from "@/lib/tenant";

// api.ts imports this module for its dispatch, so the two import each other.
// That is safe because nothing below touches an api.ts export while the
// modules load: every use is inside a handler, which runs only after both
// have finished loading.
import {
  actorFor,
  audit,
  booleanArg,
  clinicById,
  numberArg,
  ok,
  opsProblem,
  stringArg,
  UUID_SHAPED,
  type Operator,
  type OpsOutcome,
} from "./api";

/**
 * The ops console's billing panel (build spec §7 E, R35): one clinic's
 * subscription, usage, switches and the billing engine's ledgers, read for
 * the operator, and the support actions that act on them.
 *
 * It lives beside api.ts rather than inside it so the envelope file does not
 * grow by a thousand lines of billing. api.ts keeps the wire contract (the
 * closed op list and the exhaustive dispatch) and lends this module its
 * argument readers, its two audit planes and its clinic lookup; every
 * handler here is reached only through that dispatch.
 *
 * ## What crosses
 *
 * A hand-written projection, never a row. No `billing_events.payload` (it
 * carries the buyer's email and the clinic's name), no
 * `billing_notices.payload` (the links and amounts an email renders), and
 * never an exception's message: a parked event crosses as its id, its type
 * and a code. Dates are `toISOString()`, money is integer cents, and the
 * only link is Stripe's own hosted invoice page.
 *
 * ## Tenancy
 *
 * A location's subscription is its billing clinic's. Every read and write
 * here opens one tenant transaction at a time, one after another: the
 * clinic's own (its switches, its Connect account), then each clinic of the
 * billing group for its channels, then the billing clinic's (entitlements,
 * history, notices, requests, overage). Never one inside another: the pool
 * has ten connections, and a transaction opened while another is held can
 * deadlock against itself without Postgres ever noticing.
 *
 * ## Replays
 *
 * The envelope's signature is good for 300 seconds either way and carries no
 * nonce, so a captured request can be sent again, and a double click sends
 * one twice. Every write here is safe to repeat. Most compare with what is
 * stored and write nothing when nothing would change. Some are refused the
 * second time by their own state: a refund already issued, a suspension
 * already lifted, an event no longer parked. Three carry their own guard:
 * extending the setup window names the deadline it extends, a Connect link
 * is not minted twice inside the replay window, and auto-renew already as
 * asked is answered from the row, so its billing note and the refund-due
 * alert are not written twice. A retried billing request is the one left
 * repeatable on purpose: every worker re-reads Stripe before it acts, so a
 * second retry costs one more attempt that changes nothing.
 */

// -----------------------------------------------------------------------------
// Shared pieces
// -----------------------------------------------------------------------------

const NO_CLINIC = "No such clinic.";
const NO_BILLING_ACCOUNT = "This clinic has no billing account, so there is nothing to change.";
/** Stripe's event ids. Fixtures and Stripe's own test ids also carry underscores. */
const EVENT_ID = /^evt_[A-Za-z0-9_]{1,250}$/;
const NOT_PARKED =
  "That event is not parked: it was processed already, or never arrived. Nothing was replayed.";

/** A refusal in the envelope's usual shape: a 200 with a sentence for the operator. */
function refusal(message: string): OpsOutcome {
  return ok({ status: "error", message } as const);
}

/**
 * A Stripe event id as audit metadata may carry it: its SHA-256. The spec
 * keeps raw Stripe ids out of audit rows (§1), and a digest still lets
 * whoever reads the trail match it against the event, as connect.ts's
 * `accountRef` does for account ids.
 */
function eventRef(stripeEventId: string): string {
  return createHash("sha256").update(stripeEventId, "utf8").digest("hex");
}

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

/**
 * An instant the panel sends back: ISO 8601 with its zone, as `toISOString()`
 * writes it. Anything looser is refused rather than handed to `new Date()`,
 * which reads a zone-less "2026-10-10T09:00" in this server's own zone: a
 * pause would end, or a deadline fail to match, at an hour nobody chose.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function instantArg(args: Record<string, unknown>, key: string): Date | null {
  const raw = args[key];
  if (typeof raw !== "string" || !ISO_INSTANT.test(raw)) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * The hosts of Stripe's own invoice pages: the hosted invoice and its payment
 * page. apps/web accepts these two and no other, so a link is checked here
 * against the same list rather than crossing to be refused there, which
 * would turn an invoice that was created into a panel that cannot be read.
 */
const STRIPE_INVOICE_ORIGINS = ["https://invoice.stripe.com", "https://pay.stripe.com"] as const;

/**
 * Stripe's hosted invoice page, or null. The column is only ever written from
 * an invoice's `hosted_invoice_url`, but this is the one link the panel
 * renders as a link, so anything not on Stripe's invoice hosts is dropped
 * here rather than handed to a browser on the strength of where it was found.
 */
function stripeHostedUrl(url: string | null): string | null {
  if (!url) return null;
  return STRIPE_INVOICE_ORIGINS.some((origin) => url.startsWith(`${origin}/`)) ? url : null;
}

// -----------------------------------------------------------------------------
// getClinicBilling: the projection
// -----------------------------------------------------------------------------

/** One channel at one clinic of the billing group, as the panel lists it. */
export type BillingChannelView = {
  channel: Channel;
  enabled: boolean;
  status: ChannelStatus;
  readyAt: string | null;
  waitingOn: ChannelWaitingOn | null;
  liveAt: string | null;
  firstAnswerAt: string | null;
};

/**
 * Everything the billing panel shows for one clinic, in one read.
 *
 * `clinic` is the clinic the page was opened for; `entitlements` and every
 * ledger below it are its BILLING clinic's (itself, or the clinic this
 * location is billed on); `settings`, `deposits` and `connect` are the
 * clinic's own, because Pause, the direct line, deposits and the connected
 * Stripe account are per clinic. tests/ops-billing.test.ts pins the keys.
 */
export type ClinicBillingView = {
  clinic: {
    id: string;
    slug: string;
    name: string;
    dataClassification: "synthetic" | "production";
    /** The clinic holding the subscription: this one, or the one this location is billed on. */
    billingClinicId: string;
    isLocation: boolean;
  };
  /** The billing clinic and every location billed on it, billing clinic first. */
  group: {
    clinicId: string;
    slug: string | null;
    name: string | null;
    isBillingClinic: boolean;
    channels: BillingChannelView[];
  }[];
  /** What the billed package is made of: every channel with a first answer anywhere in the group. */
  channelsInService: Channel[];
  /** Null for a clinic with no billing row (synthetic, demo). */
  entitlements: {
    status: BillingStatus;
    boughtPlanId: string | null;
    /** `plan_code`: the package Stripe bills once the plan has started. */
    billedPlanId: string;
    /** No bought package: written before the deferred start, and billed in full from the first invoice. */
    isLegacy: boolean;
    interval: "month" | "year";
    locations: number;
    planStartedAt: string | null;
    planStartAppliedAt: string | null;
    isPlanStarted: boolean;
    paidThrough: string | null;
    graceEndsAt: string | null;
    cancelAt: string | null;
    /** When the account closes, if it does (BD10's display rule); null while it renews. */
    closesAt: string | null;
    overageMode: "allow" | "hard_cap";
    usageAlertsEnabled: boolean;
    firstPeriodRefundedAt: string | null;
    setupDeadlineAt: string | null;
    openInvoice: { url: string | null; amountCents: number | null } | null;
    hasSubscription: boolean;
    /** A worker or an action holds the Stripe mutation lease (R5): a change now answers busy. */
    isMutationInFlight: boolean;
  } | null;
  usage: {
    meter: UsageMeter;
    used: number;
    included: number;
    remaining: number;
    overUnits: number;
    overageCents: number;
    percent: number | null;
    windowStart: string | null;
    windowEnd: string | null;
    isWindowOpen: boolean;
  }[];
  transitions: {
    fromStatus: BillingStatus | null;
    toStatus: BillingStatus;
    actor: BillingActor;
    reason: string;
    createdAt: string;
  }[];
  notices: {
    kind: string;
    createdAt: string;
    sendAfter: string;
    sentAt: string | null;
    attempts: number;
    recipientsCount: number | null;
    lastError: string | null;
  }[];
  requests: {
    id: string;
    kind: BillingRequestKind;
    channel: Channel | null;
    reason: BillingRequestReason;
    requestedAt: string;
    nextAttemptAt: string;
    attempts: number;
    /** A worker holds the row right now; a retry would be refused. */
    isInFlight: boolean;
    doneAt: string | null;
    outcome: BillingRequestOutcome | null;
    outcomeReason: string | null;
    lastError: string | null;
    /** Pending for more than a day (R6), unless it is a closure held by its switch. */
    isStuck: boolean;
    /** A setup closure waiting for the `setup-closure` switch, by design. */
    isHeldBySwitch: boolean;
  }[];
  overageInvoices: {
    windowStart: string;
    windowEnd: string;
    voiceUnits: number;
    chatUnits: number;
    amountCents: number;
    status: "pending" | "invoiced" | "failed" | "skipped";
    invoicedAt: string | null;
    code: string | null;
  }[];
  /** Parked Stripe events for this clinic: ids, types and codes, never a payload or an error's text. */
  attentionEvents: {
    source: "billing" | "connect";
    stripeEventId: string;
    type: string;
    outcome: "failed" | "dead_letter";
    failures: number;
    receivedAt: string;
    code: string;
  }[];
  settings: {
    isPaused: boolean;
    pausedAt: string | null;
    pausedUntil: string | null;
    pausedByLabel: string | null;
    /** The clinic's own line that does not forward back to us: business data, never a patient's. */
    directLineE164: string | null;
    directLineSetAt: string | null;
  };
  deposits: {
    depositsEnabled: boolean;
    bookVoiceWithoutDeposit: boolean;
    bookChatWithoutDeposit: boolean;
    depositUncollectable: DepositUncollectable;
    depositHoldMinutes: number;
    defaultAmountUsd: number | null;
    hasDepositAmount: boolean;
    canEnable: boolean;
  };
  connect: {
    isConnected: boolean;
    /** The account's display name from Stripe, so a wrong account is visible; null when Stripe does not say in time. */
    accountLabel: string | null;
    connectedAt: string | null;
    disconnectedAt: string | null;
  };
  flags: {
    /** Inside the first-period refund window with nothing refunded yet (R15). */
    refundWindowOpen: boolean;
    refundEligibleUntil: string | null;
    /** The window is open AND the clinic has asked to close: the refund is owed, and the team said it would be in touch. */
    refundDue: boolean;
    stuckRequests: number;
    pendingLocation: { locationNumber: number; chargedAt: string | null } | null;
    /**
     * A plan change whose outcome was lost, not finished yet: the hourly
     * reconcile finishes it from Stripe, or drops it when nothing was charged.
     */
    pendingPlanChange: { planId: string; interval: "month" | "year" } | null;
  };
};

const TRANSITION_ROWS = 20;
const NOTICE_ROWS = 40;
const OVERAGE_ROWS = 24;
const ATTENTION_ROWS = 20;
const NOTICE_ERROR_CHARS = 200;

/**
 * How long a page view waits for Stripe to name the connected account.
 * connectAccountLabel allows Stripe ten seconds and a retry, which is longer
 * than apps/web waits for this whole answer (twelve seconds): a slow Stripe
 * would otherwise turn the panel into a timeout. The name is a courtesy; the
 * panel says "not shown" and carries on.
 */
const ACCOUNT_LABEL_WAIT_MS = 3_000;

async function accountLabelWithin(accountId: string, ms: number): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    // connectAccountLabel never throws; a late answer is simply dropped.
    return await Promise.race([connectAccountLabel(accountId), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The leading class name of a billing event's recorded error ("Name:
 * message"), and nothing after it: the message can quote a value from the
 * event, and the error column is the one place a payload's words could leak
 * into a projection. A name is a fact about our code.
 */
function billingEventCode(error: string | null): string {
  const match = error ? /^([A-Za-z][A-Za-z0-9_]{0,63}):/.exec(error) : null;
  return match?.[1] ?? "unknown";
}

/** The Connect ledger stores closed codes only; anything else is reported as unknown. */
function connectEventCode(error: string | null): string {
  return error !== null && (CONNECT_EVENT_CODES as readonly string[]).includes(error)
    ? error
    : "unknown";
}

/**
 * Parked events, from the identity plane (neither ledger has a tenant: the
 * row is written before the clinic is known). Billing events park on the
 * billing clinic they resolved to; Connect events on the clinic whose
 * deposit or account they concern. An event that never resolved to a clinic
 * belongs to no panel.
 */
async function attentionEvents(
  billingClinicId: string,
  clinicId: string,
): Promise<ClinicBillingView["attentionEvents"]> {
  const parked = ["failed", "dead_letter"] as const;
  const billing = await unsafeDb
    .select({
      stripeEventId: billingEvents.stripeEventId,
      type: billingEvents.type,
      outcome: billingEvents.outcome,
      failures: billingEvents.failures,
      receivedAt: billingEvents.receivedAt,
      error: billingEvents.error,
    })
    .from(billingEvents)
    .where(
      and(
        eq(billingEvents.resolvedClinicId, billingClinicId),
        inArray(billingEvents.outcome, [...parked]),
      ),
    )
    .orderBy(desc(billingEvents.receivedAt))
    .limit(ATTENTION_ROWS);
  const connect = await unsafeDb
    .select({
      stripeEventId: stripeConnectEvents.stripeEventId,
      type: stripeConnectEvents.type,
      outcome: stripeConnectEvents.outcome,
      failures: stripeConnectEvents.failures,
      receivedAt: stripeConnectEvents.receivedAt,
      error: stripeConnectEvents.error,
    })
    .from(stripeConnectEvents)
    .where(
      and(
        eq(stripeConnectEvents.resolvedClinicId, clinicId),
        inArray(stripeConnectEvents.outcome, [...parked]),
      ),
    )
    .orderBy(desc(stripeConnectEvents.receivedAt))
    .limit(ATTENTION_ROWS);
  return [
    ...billing.map((event) => ({
      source: "billing" as const,
      stripeEventId: event.stripeEventId,
      type: event.type,
      outcome: event.outcome === "failed" ? ("failed" as const) : ("dead_letter" as const),
      failures: event.failures,
      receivedAt: event.receivedAt.toISOString(),
      code: billingEventCode(event.error),
    })),
    ...connect.map((event) => ({
      source: "connect" as const,
      stripeEventId: event.stripeEventId,
      type: event.type,
      outcome: event.outcome === "failed" ? ("failed" as const) : ("dead_letter" as const),
      failures: event.failures,
      receivedAt: event.receivedAt.toISOString(),
      code: connectEventCode(event.error),
    })),
  ];
}

/** reconcile.ts's rule (R6), so the panel and the hourly alert agree on what "stuck" means. */
function isStuck(request: BillingRequest, now: Date, setupClosureOn: boolean): boolean {
  if (request.doneAt !== null) return false;
  if (request.kind === "close_setup" && !setupClosureOn) return false;
  return request.requestedAt.getTime() <= now.getTime() - STUCK_AFTER_MS;
}

/**
 * The billing panel's read (R35). Not mutating; the two tenant reads each
 * record an `action: "read"` row, as every op that opens tenant data does.
 */
export async function opGetClinicBilling(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinicId = stringArg(args, "clinicId");
  if (!clinicId || !UUID_SHAPED.test(clinicId)) {
    return opsProblem(NO_CLINIC, 404, "invalid_args");
  }
  // One read of the definer overview serves the clinic and its group's names.
  const overviews = await listClinicOverviews();
  const clinic = overviews.find((c) => c.id === clinicId);
  if (!clinic) return opsProblem(NO_CLINIC, 404, "invalid_args");
  const billingClinicId = clinic.billingClinicId ?? clinic.id;
  const actor = actorFor(operator);
  const now = new Date();

  // 1. The clinic's own tenant: its switches and its deposit settings.
  const own = await withTenant(
    { clinicId: clinic.id, actor, request: operator.request },
    async (tx) => {
      tx.audit.record({
        action: "read",
        resourceType: "clinic_settings",
        resourceId: tx.clinicId,
        metadata: { purpose: "ops_billing_view" },
      });
      return { settings: await getClinicSettings(tx), deposits: await getDepositSettings(tx) };
    },
  );

  // 2. Every clinic of the billing group, each in its own transaction.
  const group = await readBillingGroupChannels(billingClinicId, now, actor);

  // 3. The billing clinic's tenant: what it is entitled to, and its ledgers.
  const billing = await withTenant(
    { clinicId: billingClinicId, actor, request: operator.request },
    async (tx) => {
      const row = await getEntitlements(tx.db, billingClinicId);
      const transitions = await tx.db
        .select({
          fromStatus: billingTransitions.fromStatus,
          toStatus: billingTransitions.toStatus,
          actor: billingTransitions.actor,
          reason: billingTransitions.reason,
          createdAt: billingTransitions.createdAt,
        })
        .from(billingTransitions)
        .where(eq(billingTransitions.clinicId, billingClinicId))
        .orderBy(desc(billingTransitions.createdAt))
        .limit(TRANSITION_ROWS);
      // Named columns, so the payload is never selected at all.
      const notices = await tx.db
        .select({
          kind: billingNotices.kind,
          createdAt: billingNotices.createdAt,
          sendAfter: billingNotices.sendAfter,
          sentAt: billingNotices.sentAt,
          attempts: billingNotices.attempts,
          recipientsCount: billingNotices.recipientsCount,
          lastError: billingNotices.lastError,
        })
        .from(billingNotices)
        .where(eq(billingNotices.clinicId, billingClinicId))
        .orderBy(desc(billingNotices.createdAt))
        .limit(NOTICE_ROWS);
      // At most one row per (kind, channel), so six at most: no limit needed.
      const requests = await tx.db
        .select()
        .from(billingRequests)
        .where(eq(billingRequests.clinicId, billingClinicId))
        .orderBy(billingRequests.requestedAt);
      const overage = await tx.db
        .select({
          windowStart: overageInvoices.windowStart,
          windowEnd: overageInvoices.windowEnd,
          voiceUnits: overageInvoices.voiceUnits,
          chatUnits: overageInvoices.chatUnits,
          amountCents: overageInvoices.amountCents,
          status: overageInvoices.status,
          invoicedAt: overageInvoices.invoicedAt,
          error: overageInvoices.error,
        })
        .from(overageInvoices)
        .where(eq(overageInvoices.clinicId, billingClinicId))
        .orderBy(desc(overageInvoices.windowStart))
        .limit(OVERAGE_ROWS);
      tx.audit.record({
        action: "read",
        resourceType: "entitlements",
        resourceId: billingClinicId,
        metadata: { purpose: "ops_billing_view" },
      });
      return { row, transitions, notices, requests, overage };
    },
  );

  // 4. Outside any transaction: the parked events, the closure switch, and
  //    the account's name from Stripe.
  const attention = await attentionEvents(billingClinicId, clinic.id);
  const setupClosureOn = (await getJob(JOB_SETUP_CLOSURE))?.enabled === true;
  const accountLabel =
    clinic.stripeConnectAccountId && stripeConfigured()
      ? await accountLabelWithin(clinic.stripeConnectAccountId, ACCOUNT_LABEL_WAIT_MS)
      : null;

  const names = new Map(overviews.map((c) => [c.id, c]));
  const row = billing.row;
  const requests = billing.requests.map((request) => ({
    id: request.id,
    kind: request.kind,
    channel: request.channelKey === "-" ? null : request.channelKey,
    reason: request.reason,
    requestedAt: request.requestedAt.toISOString(),
    nextAttemptAt: request.nextAttemptAt.toISOString(),
    attempts: request.attempts,
    isInFlight:
      request.doneAt === null &&
      request.leaseUntil !== null &&
      request.leaseUntil.getTime() > now.getTime(),
    doneAt: iso(request.doneAt),
    outcome: request.outcome,
    outcomeReason: request.outcomeReason,
    lastError: request.lastError,
    isStuck: isStuck(request, now, setupClosureOn),
    isHeldBySwitch: request.kind === "close_setup" && request.doneAt === null && !setupClosureOn,
  }));
  const isWindowOpen = row ? refundWindowOpen(row, now) : false;
  const pendingPlanChange = row ? pendingPlanChangeOf(row) : null;
  const settings: ClinicSettings = own.settings;
  const deposits: DepositSettings = own.deposits;

  const view: ClinicBillingView = {
    clinic: {
      id: clinic.id,
      slug: clinic.slug,
      name: clinic.name,
      dataClassification: clinic.dataClassification,
      billingClinicId,
      isLocation: billingClinicId !== clinic.id,
    },
    group: group.clinicIds.map((id) => ({
      clinicId: id,
      slug: names.get(id)?.slug ?? null,
      name: names.get(id)?.name ?? null,
      isBillingClinic: id === billingClinicId,
      channels: group.states
        .filter((state) => state.clinicId === id)
        .map((state) => ({
          channel: state.channel,
          enabled: state.enabled,
          status: state.status,
          readyAt: iso(state.readyAt),
          waitingOn: state.waitingOn,
          liveAt: iso(state.liveAt),
          firstAnswerAt: iso(state.firstAnswerAt),
        })),
    })),
    channelsInService: [...group.inService],
    entitlements: row
      ? {
          status: row.status,
          boughtPlanId: row.boughtPlanId,
          billedPlanId: row.planCode,
          isLegacy: row.boughtPlanId === null,
          interval: row.billingInterval,
          locations: row.locations,
          planStartedAt: iso(row.planStartedAt),
          planStartAppliedAt: iso(row.planStartAppliedAt),
          isPlanStarted: hasPlanStarted(row),
          paidThrough: iso(row.paidThrough),
          graceEndsAt: iso(row.graceEndsAt),
          cancelAt: iso(row.cancelAt),
          closesAt: iso(closesAt(row)),
          overageMode: row.overageMode,
          usageAlertsEnabled: row.usageAlertsEnabled,
          firstPeriodRefundedAt: iso(row.firstPeriodRefundedAt),
          setupDeadlineAt: iso(row.setupDeadlineAt),
          openInvoice: row.openInvoiceId
            ? {
                url: stripeHostedUrl(row.openInvoiceUrl),
                amountCents: row.openInvoiceAmountCents,
              }
            : null,
          hasSubscription: row.stripeSubscriptionId !== null,
          isMutationInFlight:
            row.stripeMutationLeaseUntil !== null &&
            row.stripeMutationLeaseUntil.getTime() > now.getTime(),
        }
      : null,
    usage: row ? usageSnapshot(row, now) : [],
    transitions: billing.transitions.map((t) => ({
      fromStatus: t.fromStatus,
      toStatus: t.toStatus,
      actor: t.actor,
      reason: t.reason,
      createdAt: t.createdAt.toISOString(),
    })),
    notices: billing.notices.map((n) => ({
      kind: n.kind,
      createdAt: n.createdAt.toISOString(),
      sendAfter: n.sendAfter.toISOString(),
      sentAt: iso(n.sentAt),
      attempts: n.attempts,
      recipientsCount: n.recipientsCount,
      // The sender scrubs it already; scrubbed again here because this is
      // the copy that leaves the PHI side.
      lastError: n.lastError ? scrub(n.lastError).slice(0, NOTICE_ERROR_CHARS) : null,
    })),
    requests,
    overageInvoices: billing.overage.map((o) => ({
      windowStart: o.windowStart.toISOString(),
      windowEnd: o.windowEnd.toISOString(),
      voiceUnits: o.voiceUnits,
      chatUnits: o.chatUnits,
      amountCents: o.amountCents,
      status: o.status,
      invoicedAt: iso(o.invoicedAt),
      // A closed Stripe code (stripeErrorCode) or our own; never a message.
      code: o.error,
    })),
    attentionEvents: attention,
    settings: {
      isPaused: isPaused(
        { pausedAt: settings.aiPausedAt, pausedUntil: settings.aiPausedUntil },
        now,
      ),
      pausedAt: iso(settings.aiPausedAt),
      pausedUntil: iso(settings.aiPausedUntil),
      pausedByLabel: settings.aiPausedByLabel,
      directLineE164: settings.directLineE164,
      directLineSetAt: iso(settings.directLineSetAt),
    },
    deposits: {
      depositsEnabled: deposits.depositsEnabled,
      bookVoiceWithoutDeposit: deposits.bookVoiceWithoutDeposit,
      bookChatWithoutDeposit: deposits.bookChatWithoutDeposit,
      depositUncollectable: deposits.depositUncollectable,
      depositHoldMinutes: deposits.depositHoldMinutes,
      defaultAmountUsd: deposits.defaultAmountUsd,
      hasDepositAmount: deposits.hasDepositAmount,
      canEnable: deposits.canEnable,
    },
    connect: {
      isConnected: clinic.stripeConnectAccountId !== null,
      accountLabel,
      connectedAt: clinic.stripeConnectAccountId ? iso(clinic.stripeConnectConnectedAt) : null,
      disconnectedAt: iso(clinic.stripeConnectDisconnectedAt),
    },
    flags: {
      refundWindowOpen: isWindowOpen,
      refundEligibleUntil: row ? refundEligibleUntil(row, now) : null,
      refundDue:
        isWindowOpen && row !== null && (row.cancelAt !== null || row.status === "canceling"),
      stuckRequests: requests.filter((request) => request.isStuck).length,
      pendingLocation:
        row?.pendingLocationRequestId && row.pendingLocationCount !== null
          ? {
              locationNumber: row.pendingLocationCount,
              chargedAt: iso(row.pendingLocationChargedAt),
            }
          : null,
      pendingPlanChange: pendingPlanChange
        ? { planId: pendingPlanChange.planId, interval: pendingPlanChange.interval }
        : null,
    },
  };
  return ok(view);
}

// -----------------------------------------------------------------------------
// The switches: overage mode, usage alerts, Pause and the direct line, deposits
// -----------------------------------------------------------------------------

/**
 * What a switch answers: whether anything changed, and whether the act is on
 * record. A repeat of a switch already in place changes nothing and records
 * nothing, so `auditRecorded` is true then: nothing that happened is missing
 * from the trail.
 */
export type BillingSwitchState =
  | { status: "updated"; changed: boolean; auditRecorded: boolean }
  | { status: "error"; message: string };

function switched(changed: boolean, auditRecorded: boolean): OpsOutcome {
  return ok({ status: "updated", changed, auditRecorded } satisfies BillingSwitchState);
}

/** "Keep going and bill the extra" or "stop and fall back", on the billing clinic. */
export async function opSetOverageMode(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return refusal(NO_CLINIC);
  const mode = stringArg(args, "mode", 16);
  if (mode !== "allow" && mode !== "hard_cap") {
    return refusal(
      "The overage mode is allow (keep answering and bill the extra) or hard_cap (stop and fall back).",
    );
  }
  const billingClinicId = clinic.billingClinicId ?? clinic.id;
  const changed = await withTenant(
    { clinicId: billingClinicId, actor: actorFor(operator), request: operator.request },
    async (tx) => {
      const row = await getEntitlementsForUpdate(tx.db, billingClinicId);
      if (!row) return null;
      if (row.overageMode === mode) return false;
      await setOverageMode(tx.db, billingClinicId, mode);
      tx.audit.record({
        action: "update",
        resourceType: "entitlements",
        resourceId: billingClinicId,
        metadata: { field: "overage_mode", mode },
      });
      return true;
    },
  );
  if (changed === null) return refusal(NO_BILLING_ACCOUNT);
  const auditRecorded = changed
    ? await audit(operator, "billing_overage_mode_set", { clinicSlug: clinic.slug, mode })
    : true;
  return switched(changed, auditRecorded);
}

/** The owner's switch for the 90% and 100% allowance emails, on the billing clinic. */
export async function opSetUsageAlerts(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return refusal(NO_CLINIC);
  const on = booleanArg(args, "on");
  if (on === undefined) return refusal("Usage alerts are on or off.");
  const billingClinicId = clinic.billingClinicId ?? clinic.id;
  const changed = await withTenant(
    { clinicId: billingClinicId, actor: actorFor(operator), request: operator.request },
    async (tx) => {
      const row = await getEntitlementsForUpdate(tx.db, billingClinicId);
      if (!row) return null;
      if (row.usageAlertsEnabled === on) return false;
      await setUsageAlertsEnabled(tx.db, billingClinicId, on);
      tx.audit.record({
        action: "update",
        resourceType: "entitlements",
        resourceId: billingClinicId,
        metadata: { field: "usage_alerts", on },
      });
      return true;
    },
  );
  if (changed === null) return refusal(NO_BILLING_ACCOUNT);
  const auditRecorded = changed
    ? await audit(operator, "billing_usage_alerts_set", { clinicSlug: clinic.slug, on })
    : true;
  return switched(changed, auditRecorded);
}

/**
 * The label a pause from the console carries on the clinic's own screens
 * ("paused by … since …"). The portal shows it to the clinic's staff, so it
 * names the team rather than the administrator's address; who acted is in
 * the audit rows, which carry the operator.
 */
const OPS_PAUSE_LABEL = "healdesk support";

/**
 * Pause AI (with an optional end) and the direct line, on the clinic itself:
 * a location has its own. settings.ts validates and writes only what changes
 * (BD26), and records the change with booleans, never the digits.
 */
export async function opSetClinicSettings(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return refusal(NO_CLINIC);

  const patch: ClinicSettingsPatch = {};
  if (args.directLineE164 !== undefined) {
    const raw = args.directLineE164;
    if (raw === null) patch.directLineE164 = null;
    else if (typeof raw === "string" && raw.length <= 40) patch.directLineE164 = raw;
    else return refusal("The direct line is a phone number, or null to clear it.");
  }
  if (args.aiPaused !== undefined) {
    const paused = booleanArg(args, "aiPaused");
    if (paused === undefined) return refusal("Pause AI is on or off.");
    patch.aiPaused = paused;
  }
  if (args.aiPausedUntil !== undefined) {
    if (args.aiPausedUntil === null) {
      patch.aiPausedUntil = null;
    } else {
      const until = instantArg(args, "aiPausedUntil");
      if (!until) {
        return refusal(
          "The pause's end is a date and time with its zone (ISO 8601), or null for until switched back on.",
        );
      }
      patch.aiPausedUntil = until;
    }
  }
  if (Object.keys(patch).length === 0) {
    return refusal("Nothing to change: send the direct line, the pause, or both.");
  }

  let result: { before: ClinicSettings; after: ClinicSettings };
  try {
    result = await withTenant(
      { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
      // Through the pause's own wrapper, so a pause from the console is
      // recorded and emailed (L15) as one from the header is: the clinic
      // learns of a pause nobody there made (lib/channels/pause.ts).
      (tx) => updateClinicSettingsRecordingPause(tx, patch, OPS_PAUSE_LABEL),
    );
  } catch (error) {
    if (error instanceof ClinicSettingsError) return refusal(error.message);
    throw error;
  }

  const { before, after } = result;
  const fields: string[] = [];
  const pauseMoved =
    before.aiPausedAt?.getTime() !== after.aiPausedAt?.getTime() ||
    before.aiPausedUntil?.getTime() !== after.aiPausedUntil?.getTime();
  if (pauseMoved) fields.push("aiPaused");
  if (before.directLineE164 !== after.directLineE164) fields.push("directLineE164");
  if (fields.length === 0) return switched(false, true);

  const auditRecorded = await audit(operator, "clinic_settings_set", {
    clinicSlug: clinic.slug,
    fields,
    ...(pauseMoved ? { aiPaused: after.aiPausedAt !== null } : {}),
    // Whether a line is set, never which: the digits are a phone number.
    ...(fields.includes("directLineE164") ? { directLineSet: after.directLineE164 !== null } : {}),
  });
  return switched(true, auditRecorded);
}

const DEPOSIT_SWITCHES = [
  "depositsEnabled",
  "bookVoiceWithoutDeposit",
  "bookChatWithoutDeposit",
] as const;

const DEPOSIT_FIELDS = [...DEPOSIT_SWITCHES, "depositUncollectable", "depositHoldMinutes"] as const;

/**
 * The deposit switches, through deposits.ts's one writer (R24), which
 * refuses "Take deposits" on without a connected account and an amount, and
 * validates the hold and the "cannot be collected" choice.
 */
export async function opSetDepositSettings(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return refusal(NO_CLINIC);

  const patch: DepositSettingsPatch = {};
  for (const key of DEPOSIT_SWITCHES) {
    if (args[key] === undefined) continue;
    const value = booleanArg(args, key);
    if (value === undefined) return refusal(`${key} is on or off.`);
    patch[key] = value;
  }
  if (args.depositUncollectable !== undefined) {
    const value = stringArg(args, "depositUncollectable", 32);
    if (!value) return refusal("Choose what happens when a deposit cannot be collected.");
    // The writer checks it is one of the three the spec names.
    patch.depositUncollectable = value as DepositUncollectable;
  }
  if (args.depositHoldMinutes !== undefined) {
    const value = numberArg(args, "depositHoldMinutes");
    if (value === undefined) return refusal("The hold is a number of minutes.");
    patch.depositHoldMinutes = value;
  }
  if (Object.keys(patch).length === 0) return refusal("Nothing to change.");

  let result: { before: DepositSettings; after: DepositSettings };
  try {
    result = await withTenant(
      { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
      async (tx) => {
        const before = await getDepositSettings(tx);
        const after = await setDepositSettings(tx, patch, operator.email);
        return { before, after };
      },
    );
  } catch (error) {
    if (error instanceof DepositSettingsError) return refusal(error.message);
    throw error;
  }
  const fields = DEPOSIT_FIELDS.filter((key) => result.before[key] !== result.after[key]);
  if (fields.length === 0) return switched(false, true);
  const auditRecorded = await audit(operator, "deposit_settings_set", {
    clinicSlug: clinic.slug,
    fields: [...fields],
  });
  return switched(true, auditRecorded);
}

// -----------------------------------------------------------------------------
// Stripe Connect: the one-time link, and disconnecting
// -----------------------------------------------------------------------------

export type StripeConnectLinkState =
  | {
      status: "issued";
      /**
       * Stripe's authorize page with a single-use state in it. Shown to the
       * operator once and never stored, logged or audited here: the database
       * holds only the state's digest (connect.ts).
       */
      url: string;
      /** Pre-formatted, "YYYY-MM-DD HH:MM UTC". */
      expiresAt: string;
      auditRecorded: boolean;
    }
  | { status: "error"; message: string; reason?: ConnectRefusal | "recently_issued" };

/**
 * How long after an operator's Connect link is minted another is refused:
 * the envelope's replay window, plus a minute for the two hosts' clocks to
 * disagree (the signature's timestamp is apps/web's, the check is ours). A
 * link is a bearer credential that attaches whichever Stripe account opens
 * it, and minting a second one cancels the first (connect.ts keeps one live
 * ops link per clinic). A replayed or double-sent request would otherwise
 * hand a fresh link to whoever sent it and break the one the operator had
 * just passed to the clinic. So any link minted inside the window counts,
 * whatever became of it: one the clinic has already opened and declined
 * does not reopen the window for a replay either. After it, a new link is
 * the honest way to recover a lost one, and it still cancels the old.
 */
const CONNECT_LINK_REPEAT_MS = (MAX_SKEW_SECONDS + 60) * 1000;

function utcMinute(at: Date): string {
  return `${at.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

/**
 * A one-time Stripe Connect link for the clinic (BD28, R23), replacing the
 * onboarding page's old link that was minted on every read. Refused while
 * the clinic is connected; the browser that opens it lands on the neutral
 * `/connect/stripe/done` page, never on /admin.
 */
export async function opIssueStripeConnectLink(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return refusal(NO_CLINIC);
  if (clinic.stripeConnectAccountId) {
    return ok({
      status: "error",
      reason: "already_connected",
      message:
        "This clinic already has a Stripe account connected. Disconnect it before issuing a link for another.",
    } satisfies StripeConnectLinkState);
  }

  const now = new Date();
  const [recent] = await unsafeDb
    .select({
      createdAt: stripeConnectStates.createdAt,
      expiresAt: stripeConnectStates.expiresAt,
      usedAt: stripeConnectStates.usedAt,
    })
    .from(stripeConnectStates)
    .where(
      and(
        eq(stripeConnectStates.clinicId, clinic.id),
        eq(stripeConnectStates.returnTo, "ops"),
        gt(stripeConnectStates.createdAt, new Date(now.getTime() - CONNECT_LINK_REPEAT_MS)),
      ),
    )
    .orderBy(desc(stripeConnectStates.createdAt))
    .limit(1);
  if (recent) {
    const again = new Date(recent.createdAt.getTime() + CONNECT_LINK_REPEAT_MS);
    const standing = recent.usedAt
      ? "It has been opened already."
      : recent.expiresAt.getTime() > now.getTime()
        ? `It works until ${utcMinute(recent.expiresAt)} and is shown only once.`
        : "It has expired.";
    return ok({
      status: "error",
      reason: "recently_issued",
      message: `A Connect link for this clinic was issued at ${utcMinute(recent.createdAt)}. ${standing} A new one can be issued from ${utcMinute(again)}, and it cancels any earlier link not yet used.`,
    } satisfies StripeConnectLinkState);
  }

  let minted: { url: string; expiresAt: Date };
  try {
    minted = await mintConnectState({
      clinicId: clinic.id,
      returnTo: "ops",
      actor: actorFor(operator),
      now,
    });
  } catch (error) {
    if (error instanceof ConnectError) {
      return ok({
        status: "error",
        reason: error.code,
        message: error.message,
      } satisfies StripeConnectLinkState);
    }
    throw error;
  }

  // The URL carries the state, so it is never in the audit row; the clinic
  // id and how long the link lives say what was done.
  const auditRecorded = await audit(operator, "stripe_connect_link_issued", {
    clinicId: clinic.id,
    expiresInMinutes: Math.round((minted.expiresAt.getTime() - now.getTime()) / 60_000),
  });
  return ok({
    status: "issued",
    url: minted.url,
    expiresAt: utcMinute(minted.expiresAt),
    auditRecorded,
  } satisfies StripeConnectLinkState);
}

export type DisconnectState =
  | {
      status: "disconnected";
      deauthorized: boolean;
      shared: boolean;
      cancelledLinks: number;
      paidLinks: number;
      uncheckedLinks: number;
      auditRecorded: boolean;
    }
  | { status: "error"; message: string };

const NOT_CONNECTED =
  "No Stripe account is connected to this clinic, so there is nothing to disconnect. Nothing was changed.";

/**
 * Disconnect the clinic's Stripe account (BD28), in connect.ts's order:
 * deposits off first, open links expired or settled, access revoked only
 * when no other clinic shares the account, then the account cleared and the
 * clinic told. A repeat finds nothing connected and changes nothing.
 */
export async function opDisconnectStripeConnect(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return refusal(NO_CLINIC);
  if (!clinic.stripeConnectAccountId) return refusal(NOT_CONNECTED);

  const result = await disconnectStripeConnect({
    clinicId: clinic.id,
    actorLabel: operator.email,
    source: "ops",
    actor: actorFor(operator),
  });
  if (result.status === "not_connected") return refusal(NOT_CONNECTED);
  if (result.status === "deauthorize_failed") {
    await audit(operator, "stripe_connect_disconnect_incomplete", { clinicSlug: clinic.slug });
    // Something did change (deposits are off, links settled), so this is not
    // worded as a refusal that changed nothing.
    return refusal(
      "Stripe refused to revoke healdesk's access, so the account stays connected. Deposits are switched off and every open payment link was dealt with; try again to finish disconnecting.",
    );
  }
  const auditRecorded = await audit(operator, "stripe_connect_disconnected", {
    clinicSlug: clinic.slug,
    deauthorized: result.deauthorized,
    shared: result.shared,
    cancelledLinks: result.cancelledLinks,
    paidLinks: result.paidLinks,
    uncheckedLinks: result.uncheckedLinks,
  });
  return ok({
    status: "disconnected",
    deauthorized: result.deauthorized,
    shared: result.shared,
    cancelledLinks: result.cancelledLinks,
    paidLinks: result.paidLinks,
    uncheckedLinks: result.uncheckedLinks,
    auditRecorded,
  } satisfies DisconnectState);
}

// -----------------------------------------------------------------------------
// Parked events
// -----------------------------------------------------------------------------

export type ReplayState =
  | {
      status: "replayed";
      outcome: "processed" | "ignored" | "dead_letter";
      auditRecorded: boolean;
    }
  | { status: "error"; message: string };

/**
 * Re-run a parked platform billing event from its stored payload
 * (events.ts). Takes the event id alone: the handler resolves the clinic
 * from the event, exactly as the webhook did, so the panel's clinic decides
 * nothing. A repeat finds the event no longer parked and is refused.
 */
export async function opReplayBillingEvent(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const eventId = stringArg(args, "eventId", 255);
  if (!eventId || !EVENT_ID.test(eventId)) return refusal("That is not a Stripe event id.");
  const [parked] = await unsafeDb
    .select({ type: billingEvents.type })
    .from(billingEvents)
    .where(
      and(
        eq(billingEvents.stripeEventId, eventId),
        inArray(billingEvents.outcome, ["failed", "dead_letter"]),
      ),
    )
    .limit(1);
  if (!parked) return refusal(NOT_PARKED);

  let result: Awaited<ReturnType<typeof replayBillingEvent>>;
  try {
    result = await replayBillingEvent(eventId, { requestId: operator.request.requestId });
  } catch {
    // The handler recorded the failure on the event before rethrowing; the
    // event stays queued as `failed` with its new error, for another replay.
    await audit(operator, "billing_event_replayed", {
      eventRef: eventRef(eventId),
      type: parked.type,
      outcome: "failed",
    });
    return refusal(
      "The replay failed again. The event is back on the queue as failed, with its new error recorded; nothing was lost.",
    );
  }
  if (!result) return refusal(NOT_PARKED);
  // A replay that queued a critical email sends it now, as the webhook route
  // does after its commit. It never rejects.
  if (result.criticalNotice && result.clinicId) {
    await deliverCriticalAfterCommit(result.clinicId);
  }
  const auditRecorded = await audit(operator, "billing_event_replayed", {
    eventRef: eventRef(eventId),
    type: parked.type,
    outcome: result.outcome,
    ...(result.clinicId ? { clinicId: result.clinicId } : {}),
  });
  return ok({ status: "replayed", outcome: result.outcome, auditRecorded } satisfies ReplayState);
}

/**
 * Re-run a parked Connect event (connect-events.ts). The ledger keeps no
 * payload, so the event is fetched again from the clinic's own account
 * first; a fetch that fails leaves it parked.
 */
export async function opReplayConnectEvent(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const eventId = stringArg(args, "eventId", 255);
  if (!eventId || !EVENT_ID.test(eventId)) return refusal("That is not a Stripe event id.");
  const [parked] = await unsafeDb
    .select({ type: stripeConnectEvents.type })
    .from(stripeConnectEvents)
    .where(
      and(
        eq(stripeConnectEvents.stripeEventId, eventId),
        inArray(stripeConnectEvents.outcome, ["failed", "dead_letter"]),
      ),
    )
    .limit(1);
  if (!parked) return refusal(NOT_PARKED);

  let result: Awaited<ReturnType<typeof replayConnectEvent>>;
  try {
    result = await replayConnectEvent(eventId);
  } catch (error) {
    const code = stripeErrorCode(error);
    await audit(operator, "connect_event_replayed", {
      eventRef: eventRef(eventId),
      type: parked.type,
      outcome: "failed",
      code,
    });
    return refusal(
      `The replay did not complete (${code}). The event is still on the queue; reload to see where it stands.`,
    );
  }
  if (!result) return refusal(NOT_PARKED);
  const auditRecorded = await audit(operator, "connect_event_replayed", {
    eventRef: eventRef(eventId),
    type: parked.type,
    outcome: result.outcome,
    ...(result.clinicId ? { clinicId: result.clinicId } : {}),
  });
  return ok({ status: "replayed", outcome: result.outcome, auditRecorded } satisfies ReplayState);
}

// -----------------------------------------------------------------------------
// Refunds (Terms § 5) and auto-renew, through stripe-actions.ts
// -----------------------------------------------------------------------------

const REFUND_KINDS: readonly RefundKind[] = [
  "first_period_cancel",
  "guarantee",
  "agreement_terminated",
];

function refundKindArg(args: Record<string, unknown>): RefundKind | null {
  const kind = stringArg(args, "kind", 32);
  return kind && REFUND_KINDS.includes(kind as RefundKind) ? (kind as RefundKind) : null;
}

/**
 * What a refund would pay back, worked out from Stripe, and the Terms' dates
 * (R15). A read: it writes nothing but its audit row, and the console treats
 * it as one.
 */
export async function opPreviewRefund(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return refusal(NO_CLINIC);
  const kind = refundKindArg(args);
  if (!kind) {
    return refusal(
      "The refund is first_period_cancel (the first period, plan cancelled), guarantee (one month's fee) or agreement_terminated (the fees paid for time after the agreement ended).",
    );
  }
  const preview = await previewRefund({ clinicId: clinic.id, kind });
  const billingClinicId = clinic.billingClinicId ?? clinic.id;
  await withTenant(
    { clinicId: billingClinicId, actor: actorFor(operator), request: operator.request },
    async (tx) => {
      tx.audit.record({
        action: "read",
        resourceType: "entitlements",
        resourceId: billingClinicId,
        metadata: { purpose: "refund_preview", kind },
      });
    },
  );
  return ok(preview);
}

/**
 * Refund under Terms § 5 (BD14, R15), or the fees paid for time after a
 * terminated agreement ended (BAA 1.3.0 clause 17 ¶3). The amount must equal
 * the one the preview showed, and stripe-actions.ts works it out again before
 * refunding anything; a repeat of a § 5 refund is refused because the two
 * never stack, and a repeat of the termination refund once it is recorded is
 * refused with the day it was made (a commit that died after Stripe is
 * finished instead, reusing what was made).
 */
export async function opCommitRefund(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return refusal(NO_CLINIC);
  const kind = refundKindArg(args);
  if (!kind) {
    return refusal("The refund is first_period_cancel, guarantee or agreement_terminated.");
  }
  const confirmAmountCents = numberArg(args, "confirmAmountCents");
  if (
    confirmAmountCents === undefined ||
    !Number.isSafeInteger(confirmAmountCents) ||
    confirmAmountCents <= 0
  ) {
    return refusal("Type the amount the preview showed, so it can be confirmed in cents.");
  }
  // Read past the writer's own limit, so an over-long reason is refused with
  // its sentence rather than silently cut to fit.
  const reason = stringArg(args, "reason", 2000);
  if (!reason) return refusal("Give a reason for the refund; it goes on the billing history.");

  const result = await commitRefund({
    clinicId: clinic.id,
    kind,
    confirmAmountCents,
    reason,
    actorLabel: operator.email,
  });
  if (result.status === "refunded") {
    const auditRecorded = await audit(operator, "billing_refund_committed", {
      clinicSlug: clinic.slug,
      kind,
      amountCents: result.amountCents,
      isCancelRequested: result.isCancelRequested,
    });
    return ok({ ...result, auditRecorded });
  }
  if (result.status === "failed") {
    // Stripe may have refunded part of it: the attempt is on record either way.
    await audit(operator, "billing_refund_failed", { clinicSlug: clinic.slug, kind });
  }
  return ok(result);
}

export type AutoRenewState =
  | { status: "ok"; closesOn: string | null; changed: boolean; auditRecorded: boolean }
  | { status: "busy" | "refused" | "error"; message: string };

/** stripe-actions.ts's own list: auto-renew is changed from these statuses and no other. */
const AUTO_RENEW_STATUSES: readonly BillingStatus[] = ["active", "past_due", "canceling"];

/**
 * Auto-renew on the clinic's behalf (BD10): Stripe's cancel_at_period_end, on
 * the billing clinic, through stripe-actions.ts.
 *
 * A request for the state the account is already in is answered from the
 * row and goes no further. setAutoRenew would ask Stripe, find nothing to
 * change and send nothing, but it would still write a billing note and an
 * audit row and, inside the refund window, tell ops once more that a refund
 * is due: a double click or a replayed request (the envelope's 300 seconds)
 * would put each on record twice. setAutoRenew stamps `cancel_at` as it
 * answers, so the row holds the state to compare with. Only the statuses
 * auto-renew can be changed from are answered here; any other goes on to
 * setAutoRenew, which refuses it in its own words.
 */
export async function opSetAutoRenew(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return refusal(NO_CLINIC);
  const on = booleanArg(args, "on");
  if (on === undefined) return refusal("Auto-renew is on or off.");
  const billingClinicId = clinic.billingClinicId ?? clinic.id;
  const row = await withTenant(
    { clinicId: billingClinicId, actor: actorFor(operator), request: operator.request },
    (tx) => getEntitlements(tx.db, billingClinicId),
  );
  // The accounts setAutoRenew would act on: a subscription, in a status
  // auto-renew can be changed from.
  if (
    row !== null &&
    row.stripeSubscriptionId !== null &&
    AUTO_RENEW_STATUSES.includes(row.status) &&
    (on ? row.cancelAt === null && row.status !== "canceling" : row.cancelAt !== null)
  ) {
    return ok({
      status: "ok",
      closesOn: on ? null : isoDay(closesAt(row)),
      changed: false,
      auditRecorded: true,
    } satisfies AutoRenewState);
  }
  const result = await setAutoRenew({ clinicId: clinic.id, on, actorLabel: operator.email });
  if (result.status !== "ok") return ok(result satisfies AutoRenewState);
  const auditRecorded = await audit(operator, "billing_auto_renew_set", {
    clinicSlug: clinic.slug,
    on,
  });
  return ok({
    status: "ok",
    closesOn: result.closesOn,
    changed: true,
    auditRecorded,
  } satisfies AutoRenewState);
}

// -----------------------------------------------------------------------------
// Support: requests, suspension, the setup window, locations, overage
// -----------------------------------------------------------------------------

/**
 * Make a billing request due again (R6), in the billing clinic's tenant,
 * where every request lives. Refused while a worker holds it. Repeating it
 * is safe by design: every worker re-reads Stripe before acting and stops
 * when the change is already applied (R4), so a replayed retry costs at most
 * one more attempt that changes nothing.
 */
export async function opRetryBillingRequest(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return refusal(NO_CLINIC);
  const requestId = stringArg(args, "requestId");
  if (!requestId || !UUID_SHAPED.test(requestId)) {
    return refusal("That is not a billing request id.");
  }
  const billingClinicId = clinic.billingClinicId ?? clinic.id;
  const now = new Date();
  const outcome = await withTenant(
    { clinicId: billingClinicId, actor: actorFor(operator), request: operator.request },
    async (tx) => {
      const [row] = await tx.db
        .select({ kind: billingRequests.kind, outcome: billingRequests.outcome })
        .from(billingRequests)
        .where(
          and(eq(billingRequests.id, requestId), eq(billingRequests.clinicId, billingClinicId)),
        )
        .limit(1);
      if (!row) return { found: false as const };
      const rearmed = await rearmBillingRequest(tx, requestId, "ops", now);
      if (rearmed) {
        tx.audit.record({
          action: "update",
          resourceType: "billing_request",
          resourceId: requestId,
          metadata: { field: "rearm", kind: row.kind, previousOutcome: row.outcome ?? "pending" },
        });
      }
      return { found: true as const, rearmed, kind: row.kind };
    },
  );
  if (!outcome.found) return refusal("No such billing request on this clinic's account.");
  if (!outcome.rearmed) {
    return refusal("A worker is carrying that request out right now. Reload in a minute.");
  }
  const auditRecorded = await audit(operator, "billing_request_retried", {
    clinicSlug: clinic.slug,
    kind: outcome.kind,
  });
  return ok({ status: "retried", kind: outcome.kind, auditRecorded });
}

/** Lift a suspension by hand (R35): support only, refused while an invoice is open. */
export async function opLiftSuspension(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return refusal(NO_CLINIC);
  const reason = stringArg(args, "reason", 2000);
  if (!reason) return refusal("Give a reason for lifting the suspension.");
  const result = await liftSuspension({ clinicId: clinic.id, reason, actorLabel: operator.email });
  if (result.status !== "lifted") return ok(result);
  const auditRecorded = await audit(operator, "billing_suspension_lifted", {
    clinicSlug: clinic.slug,
  });
  return ok({ status: "lifted", auditRecorded });
}

/**
 * More time to finish setup (R12): 1 to 30 days on the billing clinic's
 * deadline. Relative, so a repeat would add the days twice; the request
 * therefore names the deadline it extends (`fromDeadline`, the instant the
 * panel showed), and support.ts refuses under the row's lock once it has
 * moved.
 */
export async function opExtendSetupDeadline(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return refusal(NO_CLINIC);
  const days = numberArg(args, "days");
  if (days === undefined) return refusal("Extend by a whole number of days, from 1 to 30.");
  const fromDeadline = instantArg(args, "fromDeadline");
  if (!fromDeadline) {
    return refusal(
      "Say which deadline is being extended (the one the page showed), so a repeated request cannot extend it twice.",
    );
  }
  const result = await extendSetupDeadline({
    clinicId: clinic.id,
    days,
    actorLabel: operator.email,
    expectedDeadlineAt: fromDeadline,
  });
  if (result.status !== "extended") return ok(result);
  const auditRecorded = await audit(operator, "setup_deadline_extended", {
    clinicSlug: clinic.slug,
    days,
  });
  return ok({ ...result, auditRecorded });
}

/** Finish a charged location whose clinic was not created, or clear one never charged (R14). */
export async function opRetryLocationSetup(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return refusal(NO_CLINIC);
  const result = await retryLocationSetup({ clinicId: clinic.id, actorLabel: operator.email });
  if (result.status !== "added" && result.status !== "cleared") return ok(result);
  const auditRecorded = await audit(operator, "billing_location_setup_retried", {
    clinicSlug: clinic.slug,
    outcome: result.status,
  });
  return ok({ ...result, auditRecorded });
}

/** Retry an annual overage invoice that failed, resuming any invoice the attempt left in Stripe. */
export async function opRetryOverageInvoice(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return refusal(NO_CLINIC);
  const windowStart = instantArg(args, "windowStart");
  if (!windowStart) {
    return refusal("Which month? Send the window's start as the overage ledger shows it.");
  }
  const result = await retryOverageInvoice({
    clinicId: clinic.id,
    windowStart: windowStart.toISOString(),
    actorLabel: operator.email,
  });
  if (result.status === "refused") return ok(result);
  const auditRecorded = await audit(operator, "billing_overage_retried", {
    clinicSlug: clinic.slug,
    outcome: result.status,
  });
  if (result.status === "failed") {
    return ok({
      status: "failed",
      message: `Stripe did not invoice it (${result.reason}). It stays failed, and ops has been told.`,
    });
  }
  if (result.status === "invoiced") {
    return ok({
      ...result,
      hostedInvoiceUrl: stripeHostedUrl(result.hostedInvoiceUrl),
      auditRecorded,
    });
  }
  return ok({ ...result, auditRecorded });
}

export type SetupClosureState =
  | { status: "recorded"; isNew: boolean; isSwitchOn: boolean; auditRecorded: boolean }
  | { status: "error"; message: string };

/**
 * Close an account whose setup never finished (R12), by hand: a
 * `close_setup` request with reason `ops`, recorded in the clinic's own
 * tenant transaction (the definer files it on the billing clinic). The
 * worker carries it out only while the `setup-closure` switch is on, and
 * re-checks immediately before that nothing has gone live. Destructive, so
 * the request must say `confirm: true`; refused up front when the worker
 * would only skip it. A repeat finds the request recorded and adds nothing.
 */
export async function opCloseUnfinishedSetup(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return refusal(NO_CLINIC);
  if (booleanArg(args, "confirm") !== true) {
    return refusal(
      "Tick the box to confirm: closing cancels the subscription at once, and the setup fee is not refunded.",
    );
  }
  const billingClinicId = clinic.billingClinicId ?? clinic.id;
  const actor = actorFor(operator);
  const now = new Date();

  const row = await withTenant(
    { clinicId: billingClinicId, actor, request: operator.request },
    (tx) => getEntitlements(tx.db, billingClinicId),
  );
  if (!row) return refusal(NO_BILLING_ACCOUNT);
  if (row.status === "canceled" || row.status === "purged") {
    return refusal("This account has already closed.");
  }
  if (hasPlanStarted(row)) {
    return refusal("The plan has started, so there is no unfinished setup to close.");
  }
  const group = await readBillingGroupChannels(billingClinicId, now, actor);
  if (group.anyLive) {
    return refusal(
      "A channel is live at this clinic or one of its locations, so the closure would only be skipped. Nothing was recorded.",
    );
  }

  const recorded = await withTenant(
    { clinicId: clinic.id, actor, request: operator.request },
    async (tx) => {
      const result = await closeUnfinishedSetup(tx, tx.clinicId, "ops");
      if (result.recorded) {
        tx.audit.record({
          action: "create",
          resourceType: "billing_request",
          resourceId: tx.clinicId,
          metadata: { kind: "close_setup", reason: "ops" },
        });
      }
      return result.recorded;
    },
  );
  const isSwitchOn = (await getJob(JOB_SETUP_CLOSURE))?.enabled === true;
  const auditRecorded = recorded
    ? await audit(operator, "billing_setup_closure_requested", {
        clinicSlug: clinic.slug,
        isSwitchOn,
      })
    : true;
  return ok({
    status: "recorded",
    isNew: recorded,
    isSwitchOn,
    auditRecorded,
  } satisfies SetupClosureState);
}
