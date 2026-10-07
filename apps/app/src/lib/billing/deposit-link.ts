import { assertNoTreatmentName, TreatmentNameError } from "@healdesk/connectors";
import { and, eq, inArray } from "drizzle-orm";
import Stripe from "stripe";

import { appointments, clinics, depositPayments, type DepositPayment } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import {
  readClinicDepositFacts,
  recordDepositLapsed,
  recordDepositPaid,
} from "@/lib/billing/deposits";
import { getStripe, StripeNotConfiguredError } from "@/lib/billing/stripe-client";
import { log } from "@/lib/log";
import { publicOriginProblem, publicUrl } from "@/lib/public-url";
import { withTenant } from "@/lib/tenant";

/**
 * A deposit payment link (BD27, R23): a Stripe Checkout session on the
 * clinic's OWN connected account, so the deposit is a direct charge the
 * clinic receives and we never hold.
 *
 * What Stripe sees is deliberately nothing: an amount, the generic product
 * "Appointment deposit", the statement descriptor suffix DEPOSIT, and one
 * opaque reference, the `deposit_payments` row's id (as
 * `client_reference_id` and in metadata, beside our `hd=deposit` marker the
 * Connect webhook recognises). No treatment, no patient, no appointment time;
 * every string that leaves is checked against the clinic's own service names
 * first (`assertNoTreatmentName`), and a match fails the link rather than
 * being stripped. Card only, because the spec allows nothing else on a
 * deposit, and no recovery after expiry, because a lapsed deposit is the
 * clinic's choice to make ("When a deposit cannot be collected").
 *
 * Never called inside a transaction: the row is written and committed first,
 * Stripe is called, and a second transaction opens the link.
 *
 * ## Exactly one live link per appointment
 *
 * A partial unique index (drizzle/0048) allows one `creating` or `open` row
 * per appointment, and a second request gets the open session back instead
 * of a second link the patient could also pay. The idempotency key is the
 * row's id (`hd-deposit:<id>`), and the session's `expires_at` is computed
 * once, clamped inside Stripe's window and stored on the row, so a retry
 * resends exactly the same request: a different `expires_at` under the same
 * key is an idempotency error, and a hold of exactly 30 minutes or 24 hours
 * would otherwise land outside Stripe's 30-minute-to-24-hour window once its
 * own clock stamps the session.
 */

/** Stripe accepts a Checkout `expires_at` from 30 minutes to 24 hours after creation. */
export const DEPOSIT_EXPIRY_MIN_MS = 31 * 60 * 1000;
export const DEPOSIT_EXPIRY_MAX_MS = (23 * 60 + 59) * 60 * 1000;
/** Stripe's smallest card charge in US dollars. */
const MIN_CHARGE_CENTS = 50;

const PRODUCT_NAME = "Appointment deposit";
const DESCRIPTOR_SUFFIX = "DEPOSIT";
const LINK_ACTOR: ActorContext = { type: "agent", serviceName: "deposit-link" };
const STRIPE_OPTIONS = { timeout: 20_000, maxNetworkRetries: 1 } as const;

/** The hold, clamped to where Stripe will accept the session's expiry. */
export function clampDepositExpiry(now: Date, holdMinutes: number): Date {
  const wanted = now.getTime() + holdMinutes * 60 * 1000;
  const earliest = now.getTime() + DEPOSIT_EXPIRY_MIN_MS;
  const latest = now.getTime() + DEPOSIT_EXPIRY_MAX_MS;
  return new Date(Math.min(Math.max(wanted, earliest), latest));
}

export type DepositLinkRefusal =
  | "deposits_off"
  | "not_connected"
  | "unknown_appointment"
  | "already_paid"
  | "no_amount"
  | "no_public_origin"
  | "treatment_name"
  | "link_lapsed"
  | "in_progress"
  | "stripe_unavailable"
  | "stripe_error";

export type DepositLinkResult =
  | {
      status: "open";
      url: string;
      depositId: string;
      expiresAt: Date;
      amountCents: number;
      /** The appointment already had this open link; it was returned, not made again. */
      reused: boolean;
    }
  | { status: "unavailable"; reason: DepositLinkRefusal };

type Prepared =
  | { kind: "refused"; reason: DepositLinkRefusal }
  | { kind: "reuse"; row: DepositPayment; serviceNames: string[] }
  | { kind: "create"; row: DepositPayment; serviceNames: string[] };

/**
 * The payment link for one appointment's deposit, on the clinic's connected
 * account. `channel` is the chat channel it will be sent on (voice never
 * collects). The amount is the appointment's own `deposit_usd`, set when it
 * was booked from the service's deposit or the clinic default.
 */
export async function createDepositLink(
  clinicId: string,
  appointmentId: string,
  options: { channel: "web" | "meta"; now?: Date; stripe?: Stripe },
): Promise<DepositLinkResult> {
  const now = options.now ?? new Date();
  if (publicOriginProblem()) return { status: "unavailable", reason: "no_public_origin" };

  let prepared: Prepared;
  try {
    prepared = await prepare(clinicId, appointmentId, options.channel, now);
  } catch (error) {
    // Two requests for one appointment raced to insert: the index let one
    // through. The second takes whatever the first left.
    if (!isUniqueViolation(error)) throw error;
    prepared = await prepare(clinicId, appointmentId, options.channel, now);
  }
  if (prepared.kind === "refused") return { status: "unavailable", reason: prepared.reason };

  let stripe: Stripe;
  try {
    stripe = options.stripe ?? getStripe();
  } catch (error) {
    if (!(error instanceof StripeNotConfiguredError)) throw error;
    if (prepared.kind === "create") await markFailed(clinicId, prepared.row.id, now);
    return { status: "unavailable", reason: "stripe_unavailable" };
  }
  const { row } = prepared;
  const account = { stripeAccount: row.stripeAccountId, ...STRIPE_OPTIONS };

  if (prepared.kind === "reuse") {
    return reuseOpenSession(clinicId, row, stripe, account, now);
  }

  const params = sessionParams(row);
  try {
    for (const text of outgoingStrings(params)) assertNoTreatmentName(text, prepared.serviceNames);
  } catch (error) {
    if (!(error instanceof TreatmentNameError)) throw error;
    await markFailed(clinicId, row.id, now);
    log.error("deposit link refused: a service name would reach Stripe", {
      clinicId,
      code: "treatment_name",
    });
    return { status: "unavailable", reason: "treatment_name" };
  }

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(params, {
      ...account,
      idempotencyKey: `hd-deposit:${row.id}`,
    });
  } catch (error) {
    if (error instanceof Stripe.errors.StripeIdempotencyError) {
      // The same request is in flight from another caller; it will open the row.
      return { status: "unavailable", reason: "in_progress" };
    }
    await markFailed(clinicId, row.id, now);
    log.error("deposit link: Stripe refused the session", {
      clinicId,
      code: error instanceof Error ? error.name : "unknown",
    });
    return { status: "unavailable", reason: "stripe_error" };
  }
  if (!session.url) {
    await expireQuietly(stripe, session.id, account);
    await markFailed(clinicId, row.id, now);
    return { status: "unavailable", reason: "stripe_error" };
  }

  const opened = await openRow(clinicId, row, session.id, now);
  if (opened !== "opened") {
    // A disconnect or a switch-off landed while Stripe was creating it, or the
    // row was settled by someone else: a link nobody tracks must not stay
    // payable.
    if (opened === "superseded") {
      const reused = await readOpenRow(clinicId, appointmentId);
      if (reused && reused.checkoutSessionId === session.id) {
        return {
          status: "open",
          url: session.url,
          depositId: reused.id,
          expiresAt: reused.expiresAt ?? row.expiresAt!,
          amountCents: reused.amountCents,
          reused: true,
        };
      }
    }
    await expireQuietly(stripe, session.id, account);
    return {
      status: "unavailable",
      reason: opened === "switched_off" ? "deposits_off" : "not_connected",
    };
  }
  return {
    status: "open",
    url: session.url,
    depositId: row.id,
    expiresAt: row.expiresAt!,
    amountCents: row.amountCents,
    reused: false,
  };
}

/**
 * The fixed words a chat adapter sends with the link. No treatment, no
 * amount, no time: the payment page shows the amount, and a Meta message
 * must carry nothing clinical. Refuses anything but an https link.
 */
export function depositLinkText(url: string): string {
  if (!/^https:\/\/\S+$/.test(url)) {
    throw new Error("depositLinkText takes the https link Stripe returned.");
  }
  return `To hold your appointment, please pay the deposit through this secure link: ${url}`;
}

// -----------------------------------------------------------------------------

/**
 * Inside the clinic's tenant: check the switches and the appointment, then
 * either find the live link or write a `creating` row with its expiry fixed.
 * A `creating` row left by a crashed earlier attempt is resumed under its
 * own key and expiry, unless its expiry is now too close for Stripe, in which
 * case it is marked failed and replaced.
 */
async function prepare(
  clinicId: string,
  appointmentId: string,
  channel: "web" | "meta",
  now: Date,
): Promise<Prepared> {
  return withTenant({ clinicId, actor: LINK_ACTOR }, async (tx): Promise<Prepared> => {
    const facts = await readClinicDepositFacts(tx);
    if (!facts.depositsEnabled) return { kind: "refused", reason: "deposits_off" };
    const [clinic] = await tx.db
      .select({ accountId: clinics.stripeConnectAccountId })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    if (!clinic?.accountId) return { kind: "refused", reason: "not_connected" };
    const [appointment] = await tx.db
      .select({
        id: appointments.id,
        depositUsd: appointments.depositUsd,
        depositStatus: appointments.depositStatus,
      })
      .from(appointments)
      .where(and(eq(appointments.id, appointmentId), eq(appointments.clinicId, tx.clinicId)))
      .limit(1)
      .for("update");
    if (!appointment) return { kind: "refused", reason: "unknown_appointment" };
    if (appointment.depositStatus === "paid" || appointment.depositStatus === "waived") {
      return { kind: "refused", reason: "already_paid" };
    }
    const amountCents = appointment.depositUsd
      ? Math.round(Number(appointment.depositUsd) * 100)
      : 0;
    if (!Number.isFinite(amountCents) || amountCents < MIN_CHARGE_CENTS) {
      return { kind: "refused", reason: "no_amount" };
    }
    const serviceNames = facts.services.map((s) => s.name).filter((n) => typeof n === "string");

    const [live] = await tx.db
      .select()
      .from(depositPayments)
      .where(
        and(
          eq(depositPayments.clinicId, tx.clinicId),
          eq(depositPayments.appointmentId, appointmentId),
          inArray(depositPayments.status, ["creating", "open"]),
        ),
      )
      .limit(1);
    if (live?.status === "open") return { kind: "reuse", row: live, serviceNames };
    if (
      live &&
      live.expiresAt &&
      live.expiresAt.getTime() - now.getTime() >= DEPOSIT_EXPIRY_MIN_MS - 60_000
    ) {
      return { kind: "create", row: live, serviceNames };
    }
    if (live) {
      await tx.db
        .update(depositPayments)
        .set({ status: "failed", updatedAt: now })
        .where(and(eq(depositPayments.id, live.id), eq(depositPayments.status, "creating")));
    }

    const [row] = await tx.db
      .insert(depositPayments)
      .values({
        clinicId: tx.clinicId,
        appointmentId,
        channel,
        amountCents,
        currency: "usd",
        stripeAccountId: clinic.accountId,
        status: "creating",
        expiresAt: clampDepositExpiry(now, facts.holdMinutes),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error("createDepositLink: no deposit row returned.");
    tx.audit.record({
      action: "create",
      resourceType: "deposit_payment",
      resourceId: row.id,
      metadata: { outcome: "creating", channel },
    });
    return { kind: "create", row, serviceNames };
  });
}

/** The Checkout session, from the row alone: everything in it is opaque or fixed. */
function sessionParams(row: DepositPayment): Stripe.Checkout.SessionCreateParams {
  return {
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [
      {
        price_data: {
          currency: row.currency,
          unit_amount: row.amountCents,
          product_data: { name: PRODUCT_NAME },
        },
        quantity: 1,
      },
    ],
    payment_intent_data: {
      statement_descriptor_suffix: DESCRIPTOR_SUFFIX,
      metadata: { hd: "deposit", ref: row.id },
    },
    client_reference_id: row.id,
    metadata: { hd: "deposit", ref: row.id },
    expires_at: Math.floor(row.expiresAt!.getTime() / 1000),
    success_url: publicUrl("/deposit/thanks"),
    cancel_url: publicUrl("/deposit/cancelled"),
  };
}

/** Every string the session carries to Stripe, for the treatment-name check. */
function outgoingStrings(params: Stripe.Checkout.SessionCreateParams): string[] {
  const strings: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(params);
  return strings;
}

/**
 * The appointment already has an open link: return its URL, read back from
 * Stripe (the URL is not stored). A session that has meanwhile completed or
 * expired, before its webhook arrived, is recorded as such and not reused.
 */
async function reuseOpenSession(
  clinicId: string,
  row: DepositPayment,
  stripe: Stripe,
  account: Stripe.RequestOptions,
  now: Date,
): Promise<DepositLinkResult> {
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(row.checkoutSessionId!, {}, account);
  } catch (error) {
    log.error("deposit link: the open session could not be read back", {
      clinicId,
      code: error instanceof Error ? error.name : "unknown",
    });
    return { status: "unavailable", reason: "stripe_error" };
  }
  if (session.status === "open" && session.url) {
    return {
      status: "open",
      url: session.url,
      depositId: row.id,
      expiresAt: row.expiresAt ?? new Date(session.expires_at * 1000),
      amountCents: row.amountCents,
      reused: true,
    };
  }
  await withTenant({ clinicId, actor: LINK_ACTOR }, async (tx) => {
    if (session.status === "complete" && session.payment_status === "paid") {
      await recordDepositPaid(tx, { depositId: row.id, eventId: null, at: now });
    } else if (session.status === "expired") {
      await recordDepositLapsed(tx, {
        depositId: row.id,
        status: "expired",
        from: ["open"],
        eventId: null,
        at: now,
      });
    }
  });
  return {
    status: "unavailable",
    reason: session.status === "complete" ? "already_paid" : "link_lapsed",
  };
}

type OpenOutcome = "opened" | "superseded" | "switched_off" | "disconnected";

/**
 * Open the row with its session, and the appointment with `pending_link`,
 * only if nothing changed while Stripe was being called: deposits still on,
 * the clinic still connected to the same account, and the row still
 * `creating` (a disconnect cancels creating rows).
 */
async function openRow(
  clinicId: string,
  row: DepositPayment,
  sessionId: string,
  now: Date,
): Promise<OpenOutcome> {
  return withTenant({ clinicId, actor: LINK_ACTOR }, async (tx): Promise<OpenOutcome> => {
    const facts = await readClinicDepositFacts(tx);
    const [clinic] = await tx.db
      .select({ accountId: clinics.stripeConnectAccountId })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    const stillConnected = clinic?.accountId === row.stripeAccountId;
    if (!facts.depositsEnabled || !stillConnected) {
      await tx.db
        .update(depositPayments)
        .set({ status: "cancelled", updatedAt: now })
        .where(and(eq(depositPayments.id, row.id), eq(depositPayments.status, "creating")));
      return stillConnected ? "switched_off" : "disconnected";
    }
    const [opened] = await tx.db
      .update(depositPayments)
      .set({ status: "open", checkoutSessionId: sessionId, updatedAt: now })
      .where(and(eq(depositPayments.id, row.id), eq(depositPayments.status, "creating")))
      .returning({ id: depositPayments.id });
    if (!opened) return "superseded";
    if (row.appointmentId) {
      await tx.db
        .update(appointments)
        .set({ depositStatus: "pending_link" })
        .where(
          and(
            eq(appointments.id, row.appointmentId),
            eq(appointments.clinicId, tx.clinicId),
            inArray(appointments.depositStatus, ["none", "pending_front_desk"]),
          ),
        );
    }
    tx.audit.record({
      action: "update",
      resourceType: "deposit_payment",
      resourceId: row.id,
      metadata: { outcome: "open", channel: row.channel },
    });
    return "opened";
  });
}

async function readOpenRow(
  clinicId: string,
  appointmentId: string,
): Promise<DepositPayment | null> {
  return withTenant({ clinicId, actor: LINK_ACTOR }, async (tx) => {
    const [row] = await tx.db
      .select()
      .from(depositPayments)
      .where(
        and(
          eq(depositPayments.clinicId, tx.clinicId),
          eq(depositPayments.appointmentId, appointmentId),
          eq(depositPayments.status, "open"),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

async function markFailed(clinicId: string, depositId: string, now: Date): Promise<void> {
  await withTenant({ clinicId, actor: LINK_ACTOR }, async (tx) => {
    await tx.db
      .update(depositPayments)
      .set({ status: "failed", updatedAt: now })
      .where(and(eq(depositPayments.id, depositId), eq(depositPayments.status, "creating")));
  });
}

async function expireQuietly(
  stripe: Stripe,
  sessionId: string,
  account: Stripe.RequestOptions,
): Promise<void> {
  try {
    await stripe.checkout.sessions.expire(sessionId, {}, account);
  } catch (error) {
    log.warn("deposit link: an untracked session could not be expired", {
      code: error instanceof Error ? error.name : "unknown",
    });
  }
}

function isUniqueViolation(error: unknown): boolean {
  const code =
    (error as { code?: string })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
  return code === "23505";
}
