import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verify,
} from "@healdesk/catalog";

import { env } from "@/lib/env";
import {
  ProvisioningError,
  provisionClinic,
  validateProvisionRequest,
} from "@/lib/provisioning";

/**
 * POST /api/provision — turn a completed checkout into an account.
 *
 * Called server-to-server by the marketing site, which runs on a different
 * host. Signed with a shared secret over the body and a timestamp, so the
 * payload can't be altered and a captured request can't be replayed.
 *
 * Creates an organization and a clinic, and binds the agreement the buyer
 * signed before paying. It creates no user, no invitation and no credential of
 * any kind, and it sends no mail: a clinic never signs in to healdesk, so there
 * is no login to invite anyone into. See lib/provisioning.ts for why, and
 * lib/email/connect-link.ts for the single-use link that replaced the account.
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
    console.error("[healdesk] HEALDESK_PROVISION_SECRET is not set");
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
    console.warn("[healdesk] provision rejected:", verification.reason);
    return problem("Unauthorized.", 401);
  }

  // 2. Parse.
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return problem("Invalid request body.", 400);
  }

  // 3. Validate.
  try {
    validateProvisionRequest(body);
  } catch (error) {
    if (error instanceof ProvisioningError) {
      return problem(error.message, 422, error.field);
    }
    throw error;
  }

  // 4. Provision.
  try {
    const result = await provisionClinic(body, {
      ipAddress:
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
        undefined,
      userAgent: request.headers.get("user-agent") ?? undefined,
    });

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
    // effect happening once per redelivery. There is nothing to guard right now
    // — the invite email that used to be sent here went with the invitation —
    // but anything added below that a customer can perceive belongs inside a
    // `!result.replayed` check.
    return Response.json(
      {
        organizationId: result.organizationId,
        clinicId: result.clinicId,
        clinicSlug: result.clinicSlug,
        replayed: result.replayed,
      },
      { status: result.replayed ? 200 : 201 },
    );
  } catch (error) {
    if (error instanceof ProvisioningError) {
      return problem(error.message, 422, error.field);
    }
    // Never echo the payload: it carries the buyer's contact details.
    console.error("[healdesk] provisioning failed", error);
    return problem("Could not complete setup.", 500);
  }
}
