import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verify,
} from "@healdesk/catalog";

import { issueConnectionLink } from "@/lib/connections/links";
import { sendSetupLink } from "@/lib/email/setup-link";
import { env } from "@/lib/env";
import { publicOriginProblem, publicUrl } from "@/lib/public-url";
import {
  ProvisioningError,
  provisionClinic,
  validateProvisionRequest,
  type ProvisionRequest,
} from "@/lib/provisioning";
import { describeError, log } from "@/lib/log";

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
 * It sends exactly one email, and only on a genuine creation: the setup link
 * (design of 23 September 2026, §H.2), through which the practice confirms
 * which booking-request fields the assistant may ask for. The link is issued
 * AFTER provisionClinic's transaction has committed, so a mail failure cannot
 * roll back provisioning and a rollback cannot leave a live link in an inbox;
 * a mail failure is logged and the link stays issued for the ops console to
 * resend (`issueSetupLink`). If nobody opens it, the specialty defaults apply
 * when it expires (lib/onboarding/requirements.ts).
 *
 * Note the ordering: the signature is verified before the body is parsed as
 * JSON, so an unauthenticated caller can't make us do work.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function problem(message: string, status: number, field?: string): Response {
  return Response.json({ error: message, field }, { status });
}

/**
 * Issue the setup link and mail it. Never throws: the clinic exists and the
 * purchase is complete whatever happens here, and Stripe would retry a 5xx
 * for three days against a clinic that already exists. The outcome is logged
 * by status only — never the URL, which is a live credential.
 */
async function mailSetupLink(clinicId: string, request: ProvisionRequest): Promise<void> {
  try {
    // Checked before minting, so a missing origin leaves no orphaned live link.
    const originProblem = publicOriginProblem();
    if (originProblem) {
      log.error("setup link could not be issued; issue one from the console", {
        clinicId,
        error: originProblem,
      });
      return;
    }
    const { token, expiresAt } = await issueConnectionLink(
      clinicId,
      { purpose: "setup" },
      { actor: { type: "service", serviceName: "provisioning" } },
    );
    const url = publicUrl(`/setup/${token}`);
    const result = await sendSetupLink({
      to: request.contactEmail.trim().toLowerCase(),
      clinicId,
      clinicName: request.clinicName.trim(),
      specialty: request.specialty,
      url,
      expiresAt,
    });
    if (result.status === "sent") {
      log.info("setup link mailed", { clinicId, status: result.status });
    } else {
      log.warn("setup link not mailed; resend it from the console", {
        clinicId,
        status: result.status,
        reason: result.reason,
      });
    }
  } catch (error) {
    log.error("setup link could not be issued; issue one from the console", {
      clinicId,
      error: describeError(error),
    });
  }
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
    // effect happening once per redelivery. The setup email below is exactly
    // such an effect, which is why it sits inside the `!result.replayed`
    // check; anything else a customer can perceive belongs there too.
    if (!result.replayed) {
      await mailSetupLink(result.clinicId, body as ProvisionRequest);
    }

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
    log.error("provisioning failed", { error: describeError(error) });
    return problem("Could not complete setup.", 500);
  }
}
