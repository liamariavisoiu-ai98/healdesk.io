import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verify,
} from "@healdesk/catalog";

import {
  AgreementError,
  signAgreement,
  validateSignRequest,
} from "@/lib/agreements";
import { env } from "@/lib/env";

/**
 * POST /api/agreements — record a signed business associate agreement.
 *
 * Called before payment, server-to-server from the marketing site, signed with
 * the same shared secret as provisioning. The ordering is the requirement, not
 * a preference: a business associate may not receive patient data without a
 * written contract, so the contract is written first and payment references it.
 *
 * The response deliberately returns the rendered text as well as the id, so the
 * buyer can be shown and emailed exactly what they signed without the browser
 * having to have kept a copy — and so the copy they receive is the one the
 * server hashed, not the one the client happened to render.
 *
 * Same ordering as /api/provision: authenticate before parsing, parse before
 * validating, validate before writing.
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
    return problem("Signing is unavailable.", 503);
  }

  const raw = await request.text();
  const verification = verify(
    raw,
    request.headers.get(TIMESTAMP_HEADER),
    request.headers.get(SIGNATURE_HEADER),
    secret,
  );
  if (!verification.ok) {
    console.warn("[healdesk] agreement rejected:", verification.reason);
    return problem("Unauthorized.", 401);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return problem("Invalid request body.", 400);
  }

  try {
    validateSignRequest(body);
  } catch (error) {
    if (error instanceof AgreementError) {
      return problem(error.message, 422, error.field);
    }
    throw error;
  }

  try {
    const signed = await signAgreement(body, {
      ipAddress:
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
        undefined,
      userAgent: request.headers.get("user-agent") ?? undefined,
    });

    return Response.json(
      {
        agreementId: signed.agreementId,
        version: signed.version,
        hash: signed.hash,
        text: signed.text,
        acceptedAt: signed.acceptedAt.toISOString(),
        approvedByCounsel: signed.approvedByCounsel,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof AgreementError) {
      return problem(error.message, 422, error.field);
    }
    // Never echo the payload — it carries the signatory's name and email.
    console.error("[healdesk] signing failed", error);
    return problem("Could not record your agreement.", 500);
  }
}
