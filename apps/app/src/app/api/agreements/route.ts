import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verify,
} from "@healdesk/catalog";

import {
  AgreementError,
  signAgreement,
  validateSignRequest,
  type SignedCopyDelivery,
} from "@/lib/agreements";
import { env } from "@/lib/env";
import { describeError, log } from "@/lib/log";

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
 * It also returns what happened to the emailed copy, for the reason set out at
 * copyReport below: a copy that never went out has to be a fact the caller
 * holds, not one it has to infer from an inbox.
 *
 * Same ordering as /api/provision: authenticate before parsing, parse before
 * validating, validate before writing.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function problem(message: string, status: number, field?: string): Response {
  return Response.json({ error: message, field }, { status });
}

/**
 * What the caller is told about the signer's emailed copy.
 *
 * signAgreement reports the delivery rather than assuming it, and this route
 * used to drop that report: from the browser, a copy sitting in the signer's
 * inbox and a copy that was never sent looked exactly the same. The buyer then
 * finds out by not receiving an email, which is to say months later, on the day
 * they are asked to produce the agreement. Since no transport is configured
 * yet, that is not the unusual case; it is every case.
 *
 * Narrowed on the way out rather than passed through. The internal value also
 * carries the PDF digest, whether this send is the one that stamped
 * copy_sent_at, and the transport's own words. The first two are ours to keep,
 * and the third is a string that plausibly contains somebody's address
 * ("550 5.1.1 user unknown: owner@clinic.com") or the shape of our mail setup.
 * So what crosses the boundary is a status and a sentence written here.
 *
 * Two statuses out of four, deliberately. "skipped" and "failed" are a real
 * distinction for us, a misconfiguration against a message the transport would
 * not take, and the two sentences say which happened without naming machinery.
 * The buyer's question is narrower than ours: do I have my copy or not, and
 * what do I do about it. The answer to the second is the same either way.
 */
type CopyReport =
  | { status: "sent" }
  | { status: "not_sent"; reason: string };

function copyReport(copy: SignedCopyDelivery): CopyReport {
  switch (copy.status) {
    case "sent":
      return { status: "sent" };

    // Nothing was attempted: the transport declined the message. That is our
    // configuration, not their address, and the sentence must not send them
    // hunting through their own contact details for a fault that is ours.
    case "skipped":
      return {
        status: "not_sent",
        reason:
          "We are not able to email copies at the moment, so yours has not been sent.",
      };

    // Attempted and not delivered, which includes the case where the send was
    // still running when we had to answer. "Has not been sent" is true of that
    // one as well, and is the claim we can stand behind at the moment we make
    // it. not_found cannot happen on this path, since the row was just written
    // and its id is what we passed, but it is in the type and an outcome we
    // cannot describe is not one to guess at either.
    case "failed":
    case "not_found":
      return {
        status: "not_sent",
        reason: "We tried to email your copy and it did not go out.",
      };
  }
}

export async function POST(request: Request): Promise<Response> {
  const secret = env.provisionSecret();
  if (!secret) {
    log.error("HEALDESK_PROVISION_SECRET is not set");
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
    log.warn("agreement rejected", { reason: verification.reason });
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

    const copy = copyReport(signed.copy);

    if (copy.status !== "sent") {
      // The id and the internal outcome, never the transport's reason.
      // deliverSignedCopy has already written that reason to security_events
      // with addresses scrubbed out of it; repeating it here unscrubbed would
      // put the signatory's address into the application log, which is the one
      // thing the catch below is careful not to do. The id finds the row.
      log.warn("signed copy not sent", {
        agreementId: signed.agreementId,
        status: signed.copy.status,
      });
    }

    return Response.json(
      {
        agreementId: signed.agreementId,
        version: signed.version,
        hash: signed.hash,
        text: signed.text,
        acceptedAt: signed.acceptedAt.toISOString(),
        approvedByCounsel: signed.approvedByCounsel,
        copy,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof AgreementError) {
      return problem(error.message, 422, error.field);
    }
    // Never echo the payload — it carries the signatory's name and email.
    log.error("signing failed", { error: describeError(error) });
    return problem("Could not record your agreement.", 500);
  }
}
