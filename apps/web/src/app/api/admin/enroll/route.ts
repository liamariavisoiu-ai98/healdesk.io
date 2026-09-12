import { NextResponse, after } from "next/server";
import { toDataURL } from "qrcode";

import {
  ENROLMENT_COOKIE,
  OPERATOR_COOKIE,
  enrolmentCookieOptions,
  isAdminAccountConfigured,
  issueOperatorToken,
  operatorCookieOptions,
  requireEnrolment,
} from "@/lib/admin/operator";
import {
  enrolAdminTotp,
  getAdminTotpState,
  sendSignInAlert,
} from "@/lib/admin/ops-client";
import { clientKey, rateLimit } from "@/lib/rate-limit";

/**
 * POST /api/admin/enroll, first run, and only first run.
 *
 * There is one administrator and no way to create a second, so there is no
 * invitation, no "add a device" screen and no account settings page. The whole
 * of enrolment is the gap between "the password is right" and "an authenticator
 * exists", and it happens once in the life of this deployment.
 *
 * ## Two steps, one route, and why they are not one step
 *
 * `{ step: "begin" }` asks apps/app for a candidate secret and shows it.
 * `{ step: "activate", code, proposal }` proves the secret actually reached an
 * authenticator, and only then does anything get written.
 *
 * Doing both at once, mint it, store it, call it enrolled, is the version that
 * locks the owner out. A QR that was scanned by nothing, a clock four minutes
 * out, a phone that was set up and then wiped: in every one of those the secret
 * is live, the password alone no longer opens the console, and the only person
 * who could fix it is the person now shut out of it.
 *
 * ## Where the secret is made, and where it is not
 *
 * apps/app makes it. `proposeAdminTotp` generates the bytes, builds the
 * `otpauth://` URI and returns a signed, opaque `proposal` that carries the
 * secret and that `enrolAdminTotp` is the only thing able to open. Nothing is
 * stored: a proposal nobody confirms leaves no pending row, no expiry job and
 * nothing for a second attempt to race against.
 *
 * That means the proposal has to survive the round trip through the browser,
 * and it does: it goes out with the QR and comes back with the code. Handing a
 * secret-bearing blob to the browser reads alarming for about a second, and then
 * you notice that the same response also contains the secret in plain base32 and
 * a picture of it, because showing the owner their own new secret IS this
 * screen. What matters is that the blob is signed with
 * `HEALDESK_PROVISION_SECRET`, so a caller cannot mint one, and that it is
 * accepted exactly once, against a table that has no UPDATE and no DELETE.
 *
 * The alternative was for this app to generate the secret and stage it upstream.
 * That is one more place a live TOTP secret exists, one more state to expire,
 * and it puts the choice of second factor in the app with the larger attack
 * surface. This way apps/web never chooses the secret, only displays it.
 *
 * ## Who may call this
 *
 * The ten-minute enrolment token from `/api/admin/session`, and nothing else. It
 * is one factor, so it is deliberately not a session: different cookie name,
 * different derived key, a different function to read it, and `requireOperator()`
 * returns nothing for it. See the header of `lib/admin/operator.ts`. It cannot
 * reach an ops route, and this is the only route that accepts it.
 *
 * ## Refused if a secret already exists
 *
 * Upstream, and only upstream, because that is the check that still holds when
 * two requests arrive at once: the INSERT is conditional on a singleton primary
 * key and the application role has neither UPDATE nor DELETE on the secret
 * column. So "enrol again" cannot become "replace the second factor with one I
 * chose", which would be a full account takeover for anybody holding the
 * password. This file does not duplicate that check with a read of its own,
 * which would only be a slower way to be wrong under a race; it asks
 * `getAdminTotpState()` after a refusal, to decide whether to offer the owner a
 * retry or tell them plainly that there is nothing to do here.
 *
 * ## What this file needs from the ops-api slice
 *
 * Two operations from `apps/app/src/lib/ops/api.ts`, through
 * `lib/admin/ops-client.ts`:
 *
 *   enrolAdminTotp(args: { code?: string; proposal?: string }):
 *     Promise<OpsResult<
 *       | { status: "proposed"; secret: string; otpauthUri: string;
 *           proposal: string; expiresInMs: number }
 *       | { status: "enrolled"; recoveryCodes: string[]; enrolledAt: string;
 *           auditRecorded: boolean }
 *       | { status: "error"; message: string }>>
 *   getAdminTotpState(): Promise<OpsResult<{ enrolled: boolean;
 *     enrolledAt: string | null; recoveryCodesRemaining: number }>>
 *
 * plus `sendSignInAlert`, as on `/api/admin/session`. All of them are called
 * with no operator session; the ops API takes the operator from its own
 * `HEALDESK_ADMIN_EMAIL` and the HMAC is the authority.
 *
 * ## The recovery codes are shown exactly once
 *
 * They come back in the body of the request that enrolled the secret and are
 * never obtainable again from this app. apps/app stores digests, so it cannot
 * show them again either, and there is deliberately no operation that issues
 * more. The screen says so in plain words rather than assuming anybody reads a
 * heading, and there is no "email them to me" button: mailing a list of
 * second-factor bypass codes to the same inbox that receives the sign-in alerts
 * would make both of them worth one mailbox compromise.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Ten calls per fifteen minutes per client address, across both steps.
 *
 * Looser than sign-in because a person legitimately enrolling makes several
 * calls in a row: begin, mistype, begin again, activate. Tight enough that the
 * activate step is not a place to grind at six digits, and apps/app throttles
 * the code check on its own counter besides. Holding a valid enrolment token is
 * already proof of the password, so this limiter guards the code and the
 * proposal churn rather than the door.
 */
const ATTEMPT_LIMIT = 10;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

const TOTP_CODE = /^[0-9]{6}$/;

/**
 * The proposal is opaque to this file and its length is apps/app's business, so
 * this is a transport bound rather than a format check: large enough for any
 * signed envelope that side would produce, small enough that the field is not a
 * channel. Anything past it is refused here rather than forwarded.
 */
const MAX_PROPOSAL_LENGTH = 4096;

/**
 * The request body, capped. `request.json()` buffers whatever arrives before
 * anyone looks at the size, so on a route reachable without a full session it is
 * an invitation to post a gigabyte. The same helper appears in
 * `/api/admin/session`; two small copies beat a shared module that would exist
 * to serve exactly two callers.
 */
async function readBoundedJson(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  const body = request.body;
  if (body === null) return null;

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * Nothing on this route may be stored by a cache, a proxy or the back/forward
 * cache. One response carries a live TOTP secret and another carries the whole
 * recovery code list, and both are exactly what a shared machine should not be
 * able to re-render with the back button.
 */
const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { ...NO_STORE } });
}

export async function POST(request: Request): Promise<NextResponse> {
  const limit = rateLimit(
    `admin-enroll:${clientKey(request.headers)}`,
    ATTEMPT_LIMIT,
    ATTEMPT_WINDOW_MS,
  );
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Try again shortly." },
      {
        status: 429,
        headers: {
          ...NO_STORE,
          "Retry-After": String(Math.max(limit.retryAfter, 1)),
        },
      },
    );
  }

  // The one credential this route accepts. Checked before anything is read or
  // asked of apps/app.
  const email = await requireEnrolment();
  if (email === null) {
    return json(
      {
        error:
          "This setup has expired. Sign in with your email and password again to start over.",
      },
      401,
    );
  }

  // The enrolment token was signed with `HEALDESK_ADMIN_SECRET` and names the
  // configured address, so reaching here already implies most of this. The check
  // is here so that enrolment cannot mint an operator cookie on a server whose
  // configuration went away underneath it.
  if (!isAdminAccountConfigured()) {
    console.error(
      "[healdesk] admin enrolment attempted while the admin account is not configured",
    );
    return json(
      { error: "There is no admin account configured on this server." },
      503,
    );
  }

  const body = await readBoundedJson(request, 8192);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Invalid request body." }, 400);
  }
  const fields = body as Record<string, unknown>;

  if (fields.step === "begin") return begin();
  if (fields.step === "activate") {
    return activate(request, email, fields.code, fields.proposal);
  }

  return json({ error: "Invalid request body." }, 400);
}

/** Ask for a candidate secret, and hand back everything the screen needs. */
async function begin(): Promise<NextResponse> {
  const proposed = await enrolAdminTotp({});
  if (!proposed.ok) {
    console.error("[healdesk] admin enrolment: propose failed:", proposed.code);
    return json(
      {
        error:
          "Could not start setting up an authenticator, so nothing was changed. Try again in a moment.",
      },
      503,
    );
  }

  // The only reason a proposal is refused is that a factor already exists, and
  // that is a dead end rather than something to retry.
  if (proposed.data.status !== "proposed") {
    return json(
      {
        stage: "already_enrolled",
        error:
          proposed.data.status === "error"
            ? proposed.data.message
            : "An authenticator is already set up for this account.",
      },
      409,
    );
  }

  const { secret, otpauthUri, proposal, expiresInMs } = proposed.data;

  /**
   * The QR is drawn here rather than in the browser so `qrcode` stays out of the
   * client bundle, and it goes back as a data URI so the image is part of the
   * same no-store response as the secret, rather than a separate cacheable URL
   * with a live credential somewhere in it.
   */
  let qrDataUrl = "";
  try {
    qrDataUrl = await toDataURL(otpauthUri, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 264,
      color: { dark: "#172a3aff", light: "#ffffffff" },
    });
  } catch (error) {
    // Nothing has been written upstream, so this is recoverable by hand: show
    // the key as text and let the screen say the picture failed, rather than
    // throwing away a proposal that is otherwise fine.
    console.error("[healdesk] admin enrolment: QR render failed", error);
  }

  return json(
    {
      stage: "proposed",
      secret,
      /** Four-character groups, for reading aloud and for typing by hand. */
      secretGroups: secret.match(/.{1,4}/g) ?? [secret],
      qrDataUrl,
      otpauthUri,
      proposal,
      expiresInMs,
    },
    200,
  );
}

/** Prove the secret arrived, turn it on, and sign the owner in. */
async function activate(
  request: Request,
  email: string,
  rawCode: unknown,
  rawProposal: unknown,
): Promise<NextResponse> {
  const code = typeof rawCode === "string" ? rawCode.replace(/\s+/g, "") : "";
  if (!TOTP_CODE.test(code)) {
    return json(
      { error: "Enter the six-digit code your authenticator app is showing." },
      400,
    );
  }

  const proposal = typeof rawProposal === "string" ? rawProposal : "";
  if (proposal.length === 0 || proposal.length > MAX_PROPOSAL_LENGTH) {
    // Not an error the owner can act on by typing a different code, so it says
    // what actually has to happen.
    return json(
      {
        stage: "restart",
        error: "This setup was lost. Start again and scan the new code.",
      },
      409,
    );
  }

  const result = await enrolAdminTotp({ code, proposal });
  if (!result.ok) {
    console.error("[healdesk] admin enrolment: enrol failed:", result.code);
    return json(
      {
        error:
          "The code could not be checked just now, so the authenticator was not turned on. Try again in a moment.",
      },
      503,
    );
  }

  if (result.data.status !== "enrolled") {
    /**
     * Upstream folds three different refusals into one sentence: already
     * enrolled, the proposal has expired, and the code is wrong. The sentence is
     * exactly right to show, and it does not say which of the three it is, which
     * the screen needs in order to know whether to offer another try.
     *
     * So the state is asked for rather than guessed at from the wording. If a
     * factor exists this is over; if not, the owner can try again, and the
     * screen offers both the next code and a way to start the whole thing over,
     * because from here an expired proposal and a mistyped code look the same.
     */
    const message =
      result.data.status === "error"
        ? result.data.message
        : "That code was not accepted.";

    const state = await getAdminTotpState();
    const enrolled = state.ok && state.data.enrolled;

    return json(
      { stage: enrolled ? "already_enrolled" : "rejected", error: message },
      enrolled ? 409 : 401,
    );
  }

  /**
   * Enrolled. Both factors now exist and both have been demonstrated in this
   * browser inside the last ten minutes, so this is the one place other than
   * `/api/admin/session` that issues an operator cookie.
   */
  const response = json(
    {
      stage: "enrolled",
      recoveryCodes: result.data.recoveryCodes,
      next: "admin",
    },
    200,
  );
  response.cookies.set(
    OPERATOR_COOKIE,
    issueOperatorToken(email),
    operatorCookieOptions(),
  );
  // The enrolment token has done its one job. Same flags on the way out, because
  // a browser only replaces a cookie when name, path and domain all match.
  response.cookies.set(ENROLMENT_COOKIE, "", {
    ...enrolmentCookieOptions(),
    maxAge: 0,
  });

  if (!result.data.auditRecorded) {
    // The enrolment happened; the row saying so did not. That is worth a line
    // in our log rather than a failure in front of the owner, whose second
    // factor is now genuinely on.
    console.error(
      "[healdesk] admin enrolment succeeded but the audit row was not written",
    );
  }

  scheduleAlert(request);

  return response;
}

/**
 * The same alert a normal sign-in fires, because this is a sign-in: it ends with
 * an operator cookie in a browser. The first one the owner ever receives is the
 * record of their own setup.
 *
 * Who it goes to is not an argument. `opSendSignInAlert` addresses it to the
 * operator the ops API resolved from its own `HEALDESK_ADMIN_EMAIL`, so nothing
 * on this side can redirect the one notification that would tell the owner
 * somebody else is here.
 *
 * After the response, never blocking, and every unhappy path writes a log line.
 * An alert that fails quietly is worse than none, because the point of it is
 * that somebody notices a sign-in they did not perform.
 */
function scheduleAlert(request: Request): void {
  const at = new Date().toISOString();
  const ip = clientKey(request.headers);
  const userAgent = request.headers.get("user-agent");

  after(async () => {
    try {
      const sent = await sendSignInAlert({
        at,
        ...(ip !== "unknown" ? { ipAddress: ip } : {}),
        ...(userAgent !== null ? { userAgent: userAgent.slice(0, 256) } : {}),
      });
      if (!sent.ok) {
        console.error(
          "[healdesk] admin enrolment alert failed:",
          sent.code,
          `enrolled at ${at}`,
        );
        return;
      }
      if (sent.data.delivery !== "sent") {
        console.error(
          "[healdesk] admin enrolment alert was not delivered:",
          sent.data.delivery,
          sent.data.reason ?? "no reason given",
          `enrolled at ${at}`,
        );
      }
    } catch (error) {
      console.error(
        "[healdesk] admin enrolment alert threw:",
        error,
        `enrolled at ${at}`,
      );
    }
  });
}
