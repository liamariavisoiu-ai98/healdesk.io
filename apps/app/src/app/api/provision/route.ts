import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verify,
} from "@healdesk/catalog";
import { after } from "next/server";

import { checkoutRecordsOf, importCheckoutRecords } from "@/lib/checkout/import";
import {
  findIntent,
  markIntentFailed,
  paidTermsMismatch,
  provisionRequestFromIntent,
  type StoredIntent,
} from "@/lib/checkout/intents";
import { sendOrderConfirmedDelayed } from "@/lib/checkout/order-delayed";
import { env } from "@/lib/env";
import {
  ProvisioningError,
  provisionClinic,
  validateProvisionRequest,
  type ProvisionRequest,
} from "@/lib/provisioning";
import { describeError, log } from "@/lib/log";
import { notifyOps } from "@/lib/ops/notify";
import { setupSeedFromIntent, type SetupSeed } from "@/lib/setup/seed";
import { sendWelcomeEmail } from "@/lib/setup/welcome-email";

/**
 * POST /api/provision — turn a completed checkout into an account.
 *
 * Called server-to-server by the marketing site, which runs on a different
 * host. Signed with a shared secret over the body and a timestamp, so the
 * payload can't be altered and a captured request can't be replayed.
 *
 * Creates an organization and a clinic, and binds the agreement the buyer
 * signed before paying. Since 14 October 2026 the agreement and the purchase
 * arrive in the body as the sealed records apps/web kept in the marketing
 * Sheet (`records: { intent, agreement }`), so a buyer could sign and pay
 * while this host was in standby; they are imported first, idempotently, and
 * provisioning then reads the two rows as it always has (lib/checkout/import.ts,
 * docs/design/checkout-records-on-vercel-2026-10-14.md). A seal or a document
 * hash that does not match refuses the purchase, as any other refusal does.
 * It creates the clinic's one user, the owner, with no password and no
 * invitation: the clinic signs in to its portal only by single-use links,
 * the first handed to the browser that paid at /welcome and every later one
 * mailed to its address, the welcome email's below among them (see
 * lib/provisioning.ts for why).
 *
 * It sends exactly one email, and only on a genuine creation: the welcome
 * email (B1, plan Part C4), with the order's terms, the setup-fee receipt
 * (the paid first invoice's hosted page, which the relay passes as
 * `hostedInvoiceUrl`) and a 72-hour "Continue setup" link into the wizard. It
 * goes AFTER provisionClinic's transaction has committed, so a mail failure
 * cannot roll back provisioning and a rollback cannot leave a live link in an
 * inbox, and after the response, so the webhook relay never waits on Resend.
 * Provisioning writes the welcome's ledger row in its own transaction, so a
 * send that fails, or never runs, is found and sent by the hourly welcome
 * backstop (lib/setup/welcome-email.ts). The booking-request fields the old
 * setup link asked about are the specialty's defaults, settled at
 * provisioning (lib/setup/seed.ts).
 *
 * Note the ordering: the signature is verified before the body is parsed as
 * JSON, so an unauthenticated caller can't make us do work.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function problem(message: string, status: number, field?: string): Response {
  return Response.json({ error: message, field }, { status });
}

export async function POST(request: Request): Promise<Response> {
  const secret = env.provisionSecret();
  if (!secret) {
    log.error("HEALDESK_PROVISION_SECRET is not set");
    return problem("Provisioning is unavailable.", 503);
  }

  // 1. Authenticate — before parsing, before touching the database.
  const raw = await request.text();
  const verification = verify(
    raw,
    request.headers.get(TIMESTAMP_HEADER),
    request.headers.get(SIGNATURE_HEADER),
    secret,
  );
  if (!verification.ok) {
    // Deliberately vague to the caller; the reason goes to our logs only.
    log.warn("provision rejected", { reason: verification.reason });
    return problem("Unauthorized.", 401);
  }

  // 2. Parse.
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return problem("Invalid request body.", 400);
  }

  // 3. Validate. One shape: `{ ref, ... }`, the purchase pressed at Pay, now
  // that its first invoice is paid (design D2, plan C1), with the records
  // apps/web kept for it. The intent's own payload becomes the request, so
  // what provisioning checks is exactly what was checked before payment, and
  // only while the intent still names the press of Pay and the terms that
  // were paid.
  //
  // A body without a ref, the whole purchase sent as the request, was the
  // development path and the callers from before intents. Neither is left:
  // the Stripe relay and the unpaid development path both send a ref
  // (apps/web's api/webhooks/stripe and api/checkout), and plan C1 keeps no
  // legacy branch, because a body that names its own clinic, contact and
  // agreement would provision an account that no paid purchase stands
  // behind. It is refused before anything is read, and ops hears of it: only
  // our own signed callers reach this line, so one is a bug in a relay.
  //
  // Every refusal of a `{ ref }` request is a paid invoice with no account
  // behind it, so every one reaches ops, never only a log line.
  const intentRef = intentRefOf(body);
  if (!intentRef) {
    await afterResponse(() => notifyOps("provisioning_rejected", { field: "ref", source: "request" }));
    return problem("A purchase reference is required.", 422, "ref");
  }
  let provisionRequest: ProvisionRequest;
  let setup: SetupSeed | undefined;
  let firstInvoiceUrl: string | null = null;
  try {
    const stripe = body as {
      idempotencyKey?: unknown;
      stripeCustomerId?: unknown;
      stripeSubscriptionId?: unknown;
      attempt?: unknown;
      plan?: unknown;
      billingInterval?: unknown;
      hostedInvoiceUrl?: unknown;
    };
    // The records apps/web kept, taken in before the intent is read: a
    // retried event finds both rows and continues. Absent on a relay from
    // before 14 October 2026, whose intent this host stored itself.
    const records = checkoutRecordsOf(body);
    if (records) {
      let imported: Awaited<ReturnType<typeof importCheckoutRecords>>;
      try {
        imported = await importCheckoutRecords(intentRef, records);
      } catch (error) {
        // A database fault, not a refusal: 500, so Stripe redelivers.
        log.error("checkout records could not be imported", { error: describeError(error) });
        return problem("Could not complete setup.", 500);
      }
      if (!imported.ok) {
        if (imported.reach === "intent") {
          await refuseIntent(intentRef, new ProvisioningError(imported.message, imported.field));
        } else {
          await afterResponse(() =>
            notifyOps("provisioning_rejected", { field: imported.field, source: "records" }),
          );
        }
        return problem(imported.message, 422, imported.field);
      }
    }
    const intent = await findIntent(intentRef);
    if (!intent) {
      await afterResponse(() => notifyOps("provisioning_rejected", { field: "ref", source: "intent" }));
      return problem("Unknown purchase.", 422, "ref");
    }
    if (intent.consumedAt && intent.stripeSubscriptionId !== stripe.stripeSubscriptionId) {
      // A second subscription paid for a purchase already set up: its
      // setup fee was taken twice. Never marked failed: the first
      // subscription's account exists and /welcome must keep saying so.
      await afterResponse(() =>
        notifyOps("duplicate_subscription", { clinicId: intent.provisionedClinicId, source: "intent" }),
      );
      return problem("That purchase was set up on another subscription.", 409, "ref");
    }
    const moved = paidTermsMismatch(intent, stripe);
    if (moved) throw new ProvisioningError(moved.message, moved.field);
    provisionRequest = provisionRequestFromIntent(intent, {
      idempotencyKey: typeof stripe.idempotencyKey === "string" ? stripe.idempotencyKey : "",
      stripeCustomerId: typeof stripe.stripeCustomerId === "string" ? stripe.stripeCustomerId : undefined,
      stripeSubscriptionId: typeof stripe.stripeSubscriptionId === "string" ? stripe.stripeSubscriptionId : undefined,
    });
    // What the setup wizard starts from: the funnel's answers and the read.
    setup = setupSeedFromIntent(intent);
    // The paid first invoice's hosted page, the setup-fee receipt the
    // welcome email links. Anything but a Stripe invoice page is dropped,
    // never refused: the purchase is paid, and a receipt link is not worth
    // an account.
    firstInvoiceUrl = stripeInvoiceUrl(stripe.hostedInvoiceUrl);
    validateProvisionRequest(provisionRequest);
  } catch (error) {
    if (error instanceof ProvisioningError) {
      await refuseIntent(intentRef, error);
      return problem(error.message, 422, error.field);
    }
    throw error;
  }

  // 4. Provision.
  try {
    const result = await provisionClinic(
      provisionRequest,
      {
        ipAddress:
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          undefined,
        userAgent: request.headers.get("user-agent") ?? undefined,
      },
      { intentRef, setup, firstInvoiceUrl },
    );

    // 200 on a replay, 201 on a genuine creation.
    //
    // Both are 2xx on purpose: the caller is a Stripe webhook relay, and Stripe
    // retries any non-2xx for three days. A duplicate delivery is a SUCCESS —
    // the clinic exists and nothing further is owed — so answering 409 or 422
    // would turn correct idempotent behaviour into a three-day retry storm and
    // an eventually-disabled endpoint.
    //
    // `replayed` is reported rather than swallowed because it is the only thing
    // standing between a three-day retry schedule and a customer-visible side
    // effect happening once per redelivery. The welcome email below is exactly
    // such an effect, which is why it sits inside the `!result.replayed`
    // check (and its ledger row makes it once per clinic besides); anything
    // else a customer can perceive belongs there too.
    if (!result.replayed) {
      const clinicId = result.clinicId;
      await afterResponse(async () => {
        const outcome = await sendWelcomeEmail(clinicId);
        log.info("welcome email", { clinicId, outcome });
      });
    }

    return Response.json(
      {
        organizationId: result.organizationId,
        clinicId: result.clinicId,
        clinicSlug: result.clinicSlug,
        replayed: result.replayed,
        // For apps/web's lead store: what was bought, never who bought it.
        plan: provisionRequest.plan,
        billingInterval: provisionRequest.billingInterval ?? "month",
      },
      { status: result.replayed ? 200 : 201 },
    );
  } catch (error) {
    if (error instanceof ProvisioningError) {
      await refuseIntent(intentRef, error);
      return problem(error.message, 422, error.field);
    }
    // Never echo the payload: it carries the buyer's contact details.
    log.error("provisioning failed", { error: describeError(error) });
    return problem("Could not complete setup.", 500);
  }
}

/** The intent ref of a `{ ref, ... }` request, or null for any other body, which is refused. */
function intentRefOf(body: unknown): string | null {
  const ref = (body as { ref?: unknown } | null)?.ref;
  return typeof ref === "string" && ref.length > 0 ? ref : null;
}

/**
 * A Stripe-hosted invoice page, or null: https on invoice.stripe.com, printable
 * ASCII, at most 500 characters, as checkout_intents' CHECK allows.
 */
function stripeInvoiceUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 500) return null;
  return /^https:\/\/invoice\.stripe\.com\/[!-~]+$/.test(value) ? value : null;
}

/**
 * A paid purchase provisioning cannot complete. The buyer's money is taken,
 * so this is never quiet: /welcome stops waiting and tells them it is safe
 * and that we finish by hand, and ops is told now. Never throws: the 422
 * still has to reach apps/web, which forwards the event so it parks.
 */
async function refuseIntent(ref: string, error: ProvisioningError): Promise<void> {
  let firstRefusal: StoredIntent | null = null;
  try {
    firstRefusal = await markIntentFailed(ref);
  } catch (markError) {
    log.error("could not mark a refused intent", { error: describeError(markError) });
  }
  // Both can wait on Resend for seconds, and this is the webhook's request
  // path: they go after the response. The buyer is written to once, by the
  // refusal that marked the intent (B3).
  await afterResponse(async () => {
    await notifyOps("provisioning_rejected", { field: error.field ?? null, source: "intent" });
    if (firstRefusal) await sendOrderConfirmedDelayed(firstRefusal);
  });
}

/** After the response when Next can schedule it; at once outside a request (tests, scripts). */
async function afterResponse(task: () => Promise<void>): Promise<void> {
  try {
    after(task);
  } catch {
    await task();
  }
}
