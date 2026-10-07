import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verify,
} from "@healdesk/catalog";
import { after } from "next/server";

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
 * signed before paying. It creates no user, no invitation and no credential of
 * any kind: a clinic never signs in to healdesk, so there is no login to
 * invite anyone into. See lib/provisioning.ts for why, and
 * lib/email/connect-link.ts for the single-use link that replaced the account.
 *
 * It sends exactly one email, and only on a genuine creation: the welcome
 * email (B1, plan Part C4), with the order's terms and a 72-hour "Continue
 * setup" link into the wizard. It goes AFTER provisionClinic's transaction
 * has committed, so a mail failure cannot roll back provisioning and a
 * rollback cannot leave a live link in an inbox, and after the response, so
 * the webhook relay never waits on Resend. A failed send is retried by the
 * setup-reminders job (lib/setup/reminders.ts). The booking-request fields
 * the old setup link asked about are the specialty's defaults, settled at
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

  // 3. Validate. Two shapes: the purchase itself (the development path, and
  // any caller from before intents), or `{ ref, ... }`, the intent apps/app
  // stored when Pay was pressed, now that its first invoice is paid (design
  // D2). The intent's own payload becomes the request, so what provisioning
  // checks is exactly what was checked before payment, and only while the
  // intent still names the press of Pay and the terms that were paid.
  //
  // Every refusal of a `{ ref }` request is a paid invoice with no account
  // behind it, so every one reaches ops, never only a log line.
  const intentRef = intentRefOf(body);
  let provisionRequest: ProvisionRequest;
  let setup: SetupSeed | undefined;
  try {
    if (intentRef) {
      const stripe = body as {
        idempotencyKey?: unknown;
        stripeCustomerId?: unknown;
        stripeSubscriptionId?: unknown;
        attempt?: unknown;
        plan?: unknown;
        billingInterval?: unknown;
      };
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
    } else {
      provisionRequest = body as ProvisionRequest;
    }
    validateProvisionRequest(provisionRequest);
  } catch (error) {
    if (error instanceof ProvisioningError) {
      if (intentRef) await refuseIntent(intentRef, error);
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
      intentRef ? { intentRef, setup } : {},
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
      if (intentRef) await refuseIntent(intentRef, error);
      return problem(error.message, 422, error.field);
    }
    // Never echo the payload: it carries the buyer's contact details.
    log.error("provisioning failed", { error: describeError(error) });
    return problem("Could not complete setup.", 500);
  }
}

/** The intent ref of a `{ ref, ... }` request, or null for the full-purchase shape. */
function intentRefOf(body: unknown): string | null {
  const ref = (body as { ref?: unknown } | null)?.ref;
  return typeof ref === "string" && ref.length > 0 ? ref : null;
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
