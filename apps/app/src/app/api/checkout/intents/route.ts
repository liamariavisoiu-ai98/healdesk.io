import {
  assertInviteOpen,
  checkIntentAgreement,
  IntentError,
  saveIntent,
  validateIntentRequest,
} from "@/lib/checkout/intents";
import { problem, readSignedJson } from "@/lib/checkout/signed";
import { describeError, log } from "@/lib/log";
import { publicOriginProblem, publicUrl } from "@/lib/public-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/checkout/intents: a purchase, before anyone pays (design D1, plan
 * Part A4). apps/web calls it, signed, when the buyer presses Pay, and only
 * then creates the Stripe Checkout Session, carrying the ref and the terms of
 * that press (`{ app, ref, plan, billingInterval, attempt }`) and nothing
 * else.
 *
 * Everything provisioning will check is checked here, before the card is
 * charged. The answer carries the success URL, built here from this app's
 * public origin because /welcome is this app's page and apps/web must never
 * know, or leak, this app's internal address.
 */
export async function POST(request: Request): Promise<Response> {
  const read = await readSignedJson(request, 256_000);
  if (!read.ok) return read.response;

  const originProblem = publicOriginProblem();
  if (originProblem) {
    log.error("checkout intents: no public origin to send the buyer back to", { outcome: originProblem });
    return problem("Checkout is unavailable.", 503);
  }

  try {
    const input = validateIntentRequest(read.body);
    await assertInviteOpen(input.inviteRef);
    await checkIntentAgreement(input.agreementId, input.contactEmail);
    const saved = await saveIntent(input);
    return Response.json(
      {
        ref: saved.ref,
        attempt: saved.attempt,
        expiresAt: saved.expiresAt.toISOString(),
        previousOpenSessionId: saved.previousOpenSessionId,
        successUrl: publicUrl(`/welcome?h=${saved.ref}&cs={CHECKOUT_SESSION_ID}`),
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof IntentError) return problem(error.message, error.status, error.field);
    // Never echo the body: it carries the buyer's contact details.
    log.error("checkout intent could not be saved", { error: describeError(error) });
    return problem("Checkout is unavailable. Nothing has been charged.", 500);
  }
}
