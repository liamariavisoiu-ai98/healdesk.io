import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verify,
} from "@healdesk/catalog";

import { env } from "@/lib/env";
import {
  MAX_BODY_BYTES,
  isMutating,
  opsProblem,
  parseEnvelope,
  readBoundedBody,
  resolveOperator,
  runOperation,
  type OpsOutcome,
} from "@/lib/ops/api";
import { describeError, log } from "@/lib/log";

/**
 * POST /api/ops — the one door the admin console comes through.
 *
 * The console lives at healdesk.io/admin, in apps/web, which has no database
 * driver and must not acquire one: that absence is why the marketing site can
 * deploy anywhere and why the audit of this codebase can say the public site
 * cannot reach patient data. So the console asks and this answers, over the
 * same signed channel `/api/provision` already uses.
 *
 * The body is `{ op, args, context? }`. One question is asked about it:
 *
 *     Did OUR SERVER send this? — the HMAC over the body and the timestamp,
 *     keyed on HEALDESK_PROVISION_SECRET, verified before a byte is parsed.
 *
 * The previous version asked a second one — "is the person this envelope names
 * still an operator?" — and looked them up in `member` on every call. That
 * question is gone with the user store it queried: there is one administrator,
 * they are HEALDESK_ADMIN_EMAIL, and no request names anybody. The identity in
 * every audit row is read from the environment on this side, so a caller
 * holding a valid signature can still only act AS the administrator, never as
 * somebody else. See lib/ops/api.ts for the whole argument.
 *
 * Note what the signature therefore is and is not. It authenticates apps/web,
 * not the person at the keyboard. Whether the human passed a password and a
 * TOTP code is apps/web's question, answered entirely on apps/web since
 * 14 October 2026 (both factors are Vercel variables there, so /admin can be
 * signed into while this host is off) and carried in its own session cookie.
 * Nothing in this API takes part in signing in. A leaked
 * HEALDESK_PROVISION_SECRET is therefore full command of this endpoint without
 * either factor: guard it as the console itself.
 *
 * ## Ordering
 *
 * The same discipline as its two siblings: authenticate before parsing, parse
 * before dispatching, dispatch before touching anything else. An
 * unauthenticated caller cannot make us do work, and an authenticated one who
 * names an unknown operation cannot make us read a row, decrypt a secret or
 * send an email.
 *
 * ## The proxy
 *
 * `src/proxy.ts` redirects anything without a session cookie to /sign-in, and
 * exempts a short list of paths that authenticate themselves — `/api/auth`,
 * `/api/provision`, `/api/webhooks`. `/api/ops` is not on
 * that list and belongs on it: a signed server-to-server POST carries no
 * cookie, so without the entry every call here becomes a 307 pointing at HTML,
 * which is a genuinely baffling failure to debug from the caller's side. That
 * file is outside this slice; the integrator adds `"/api/ops"` to
 * SELF_AUTHENTICATING_PATHS. Being on that list is not an exemption from
 * authentication — it is the statement that this route does its own, which is
 * everything above.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function respond(outcome: OpsOutcome): Response {
  return Response.json(outcome.body, {
    status: outcome.status,
    headers: {
      /**
       * Clinic names, signed contracts, single-use connect tokens, an enrolment
       * secret and a set of recovery codes. Not in a shared cache, not on disk,
       * not in a proxy between here and apps/web.
       */
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  const secret = env.provisionSecret();
  if (!secret) {
    log.error("HEALDESK_PROVISION_SECRET is not set");
    return respond(
      opsProblem("The operations API is unavailable.", 503, "unavailable"),
    );
  }

  // A declared length is a claim and is absent on a chunked request, so this is
  // an early bail rather than the cap. The cap is enforced while reading.
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return respond(opsProblem("Payload too large.", 413, "too_large"));
  }

  // 1. Authenticate — before parsing, before any database access.
  const raw = await readBoundedBody(request, MAX_BODY_BYTES);
  if (raw === null) {
    return respond(opsProblem("Payload too large.", 413, "too_large"));
  }

  const verification = verify(
    raw,
    request.headers.get(TIMESTAMP_HEADER),
    request.headers.get(SIGNATURE_HEADER),
    secret,
  );
  if (!verification.ok) {
    // Vague to the caller; the reason goes to our logs only. verify() checks
    // the timestamp window in both directions, so a captured request stops
    // working five minutes after it was made.
    log.warn("ops api rejected", { reason: verification.reason });
    return respond(opsProblem("Unauthorized.", 401, "unauthorized"));
  }

  // 2. Parse, and narrow the operation to the closed list before anything else.
  const parsed = parseEnvelope(raw);
  if (!parsed.ok) {
    return respond(parsed.outcome);
  }

  const { op, args, context } = parsed.envelope;

  // 3. Name the actor. One environment read, no database: there is one
  //    administrator and the request does not get to say who they are.
  const resolution = resolveOperator(context);
  if (!resolution.ok) {
    return respond(resolution.outcome);
  }

  // 4. Run it.
  try {
    return respond(await runOperation(op, args, resolution.operator));
  } catch (error) {
    /**
     * Name and message only, never the error object. A driver error carries the
     * attempted statement and its bound parameters as own properties, and the
     * tables behind these operations hold clinic names, the signatories of
     * executed contracts, and the sealed second factor.
     *
     * The operation name IS logged: an operation that blows up is something
     * somebody has to look into, and "which one" is the first thing they will
     * ask. It is one of thirteen literals produced by this file, so it cannot
     * forge a second line in this log. The operator is not logged, because
     * there is only one and naming them adds nothing.
     */
    log.error("ops api operation failed", { op, error: describeError(error) });

    // Whether the act happened before the throw is unknown here, and for a
    // mutating op that is worth saying out loud rather than letting an operator
    // assume nothing changed and press the button again.
    return respond(
      opsProblem(
        isMutating(op)
          ? "That operation failed partway through. Reload before trying it again."
          : "That operation failed.",
        500,
        "failed",
      ),
    );
  }
}
