import { NextResponse, after } from "next/server";

import {
  ENROLMENT_COOKIE,
  OPERATOR_COOKIE,
  enrolmentCookieOptions,
  isAdminAccountConfigured,
  issueEnrolmentToken,
  issueOperatorToken,
  normaliseEmail,
  operatorCookieOptions,
  verifyAdminPassword,
} from "@/lib/admin/operator";
import {
  burnRecoveryCode,
  getAdminTotpState,
  sendSignInAlert,
  verifyAdminTotpStep,
} from "@/lib/admin/ops-client";
import { clientKey, rateLimit } from "@/lib/rate-limit";

/**
 * POST /api/admin/session, sign the one administrator in.
 * DELETE /api/admin/session, throw the cookie away.
 *
 * ## The order below is the design, not an implementation detail
 *
 * Read it top to bottom. Every step is where it is because the step before it
 * has to have happened first, and moving any of them is a security change:
 *
 *   1. **Rate limit, before any derivation.** `HEALDESK_ADMIN_PASSWORD_HASH` is
 *      a scrypt hash with N=16384, r=8, which is roughly 16 MiB of memory and
 *      tens of milliseconds of CPU per check. That expense is the point when a
 *      stolen hash is being cracked offline, and it is a liability when the
 *      check is on an open endpoint: an unlimited POST here is a denial of
 *      service that costs the attacker one HTTP request and costs us a core.
 *      So nothing reads the body and nothing calls scrypt until the caller has
 *      proved they are inside an attempt budget, and no more than
 *      `MAX_DERIVATIONS_IN_FLIGHT` derivations run at the same instant. Those
 *      are two different bounds and both are needed: a window counter is read
 *      before the derivation and written after it, so a simultaneous burst all
 *      reads the same unspent budget and all runs scrypt. The window says how
 *      many guesses a quarter of an hour may contain; the in-flight count says
 *      how much memory-hard work one moment may contain.
 *   2. **Email and password**, both, with the derivation running either way so
 *      that "wrong address" and "right address, wrong password" take the same
 *      time. See `verifyAdminPassword`.
 *   3. **The second factor**, asked of apps/app because that is where the shared
 *      secret, the last-used step and the recovery codes live.
 *   4. **Only then the cookie.** There is no branch in this file that issues an
 *      operator cookie without having passed 2 and 3.
 *   5. **The alert email, after the response.** Never before, never blocking.
 *
 * ## Why apps/app verifies the code and this app does not
 *
 * The tempting shape is to fetch the TOTP secret and the last-used step over the
 * signed API, do the arithmetic here, and write the step back. It is tempting
 * because the arithmetic is twenty lines. It is wrong twice over.
 *
 * First, replay. "Reject a code whose step has already been used" is a
 * compare-and-set, and a compare-and-set split across a network is a race: two
 * requests carrying the same code both read the same `lastUsedStep`, both decide
 * it is fresh, and both are let in. That is precisely the attack the step
 * counter exists to stop, an attacker who watches one code go past a proxy, or
 * shoulder-surfs it, gets to use it too. The check has to be atomic where the
 * state is, so it happens in one call over there and the answer comes back as a
 * verdict.
 *
 * Second, the recovery codes. Accepting one means comparing against stored
 * hashes and burning the one that matched, atomically, for the same reason.
 * Shipping the hashes to the marketing app to do that would be moving a
 * credential across a boundary this codebase spends real effort keeping thin.
 *
 * So the marketing app never holds the TOTP secret after enrolment and never
 * holds a recovery code hash at all. It holds the password hash, because the
 * password is what this app's own form collects.
 *
 * ## What this file needs from the ops-api slice
 *
 * Four functions from `lib/admin/ops-client.ts`, which owns the signed
 * transport. The names and result shapes are that file's, not this one's:
 *
 *   getAdminTotpState(): Promise<OpsResult<{ enrolled: boolean;
 *     enrolledAt: string | null; recoveryCodesRemaining: number }>>
 *   verifyAdminTotpStep(args: { code: string }): Promise<OpsResult<
 *     | { ok: true }
 *     | { ok: false; reason: "not_enrolled" | "incorrect" | "already_used"
 *         | "unreadable" | "throttled"; message: string }>>
 *   burnRecoveryCode(args: { code: string }): Promise<OpsResult<
 *     | { ok: true; remaining: number; auditRecorded: boolean }
 *     | { ok: false; reason: "not_enrolled" | "incorrect" | "throttled";
 *         message: string }>>
 *   sendSignInAlert(args: { at: string; ipAddress?: string; userAgent?: string }):
 *     Promise<OpsResult<{ delivery: "sent" | "skipped" | "failed";
 *       reason?: string; auditRecorded: boolean }>>
 *
 * All four are called with NO operator session, because there is not one yet.
 * The client reaches them through its `callPreSessionOps`, where the HMAC alone
 * is the authority and apps/app takes the operator from its own
 * `HEALDESK_ADMIN_EMAIL`. Routing them through the ordinary `callOps`, which
 * asks `requireOperator()` first, would deadlock first sign-in: no session until
 * the code is checked, and no code check until there is a session.
 *
 * ## The refusal sentences come from upstream
 *
 * "That code has already been used", "check the clock on your phone", "the
 * stored second factor could not be read" are written in `apps/app`, next to the
 * code that decides which one is true, and carried across verbatim through the
 * client's `text()`. Re-deriving them here would put a second opinion about what
 * a rejection means into the app that cannot see the row it is describing.
 *
 * ## Failing closed on an ops failure
 *
 * If `getAdminTotpState` or `verifyAdminSecondFactor` cannot be reached, this
 * answers 503 and issues nothing. The alternative, "apps/app is down, let them
 * in on the password alone", is a way to turn an outage into a single-factor
 * console, and an attacker who can cause an outage can then choose to.
 *
 * ## Statuses
 *
 * 200 with `{ next: "admin" }` or `{ next: "enroll" }` on success, 401 on bad
 * credentials or a bad code, 429 out of budget, 400 on a malformed body, 503
 * when the account is not configured or the ops API could not answer. The last
 * is deliberately not folded into 401: "your password is wrong" and "this server
 * has no admin account" are different facts, and answering the second with the
 * first would be lying to the only person who could fix it.
 *
 * There is no CSRF token. Both cookies are `sameSite: "strict"`, so a cross-site
 * POST arrives without them and can neither read nor extend a session; and login
 * CSRF, forcing a victim to sign in as the attacker, is empty here because there
 * is exactly one account and it is the owner's.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Five attempts per fifteen minutes per client address. Room for a couple of
 * typos and a paste that picked up a trailing newline; no room for a dictionary,
 * and no room to bill us for scrypt.
 */
const ATTEMPT_LIMIT = 5;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Failed attempts per window across every caller, whatever address they claim.
 *
 * `clientKey()` reads the first entry of `x-forwarded-for`, which is a request
 * header, which means the CALLER picks it. Behind a proxy that overwrites the
 * header that is the client's real address; in front of `next start`, or behind
 * a proxy that appends rather than replaces, it is whatever the attacker typed.
 * A per-address counter alone is therefore a typo guard and not a brute-force
 * control.
 *
 * So there is a second counter that no header can move. Twelve times the per-
 * address allowance, so a person genuinely fumbling a password never meets it
 * and a script rotating a header meets it in seconds. Only failures spend it, so
 * the owner signing in normally cannot walk into the ceiling. Once it is spent
 * the door is shut for everyone including the owner until the window rolls,
 * which is a real availability cost and the price of the property that matters
 * more: an attacker who can rotate a header must not get unlimited guesses at a
 * six-digit code. It is bounded to fifteen minutes and to this endpoint, and an
 * existing session keeps working throughout because `requireOperator()` reads a
 * cookie and never touches this file.
 *
 * Six digits is a million codes and a thirty-second step. At sixty guesses per
 * fifteen minutes the expected time to hit a live code is measured in centuries.
 */
const GLOBAL_FAILURE_LIMIT = 60;

/**
 * Its own counter rather than a constant key into `rateLimit`, for two reasons
 * worth stating: `rateLimit` counts on every call, so it cannot answer "is there
 * budget left?" without spending some, and a correct password would then cost
 * the same as a wrong guess, exactly the property this must not have. And a
 * single number needs none of that module's keyed map, which is the thing a
 * rotating header can grow without bound.
 *
 * In-process, so the real ceiling is (limit x instances) and a cold start resets
 * it. That is stated rather than hidden: this slows a guessing attack by a large
 * constant factor rather than stopping one, and the actual defences are a long
 * password, a scrypt hash, and a second factor. Moving to the Upstash Redis that
 * `.env.example` already stubs would make the window global.
 */
let globalFailures = { count: 0, resetAt: 0 };

/** Read-only. Says whether a credential may be evaluated at all right now. */
function globalBudget(now: number): { ok: boolean; retryAfter: number } {
  if (globalFailures.resetAt <= now) return { ok: true, retryAfter: 0 };
  return {
    ok: globalFailures.count < GLOBAL_FAILURE_LIMIT,
    retryAfter: Math.ceil((globalFailures.resetAt - now) / 1000),
  };
}

/** Spend one. Only ever called on a credential that was wrong. */
function recordGlobalFailure(now: number): void {
  if (globalFailures.resetAt <= now) {
    globalFailures = { count: 0, resetAt: now + ATTEMPT_WINDOW_MS };
  }
  globalFailures.count += 1;
}

/**
 * How many scrypt derivations this process will have running at one instant.
 *
 * The two counters above bound how many guesses are JUDGED in a window. Neither
 * bounds how many are judged AT ONCE, and that difference is a hole rather than
 * a nuance: both are read before the derivation and written after it, so every
 * request in a simultaneous burst sees the budget as it was before any of them
 * spent it. Two hundred concurrent POSTs therefore all passed `globalBudget`
 * and all ran scrypt, two hundred times sixteen mebibytes, and the whole libuv
 * thread pool, before the first of them recorded a failure. The window
 * counters then refused the two hundred and first, which is the wrong two
 * hundred requests too late.
 *
 * A check-then-act is only atomic if the act happens before the next reader
 * gets to look. So this counter is incremented in the same synchronous turn as
 * the check and released in a `finally`, which makes it the one bound here that
 * a burst cannot outrun.
 *
 * Four, because that is libuv's default thread pool: a fifth concurrent
 * derivation cannot start work anyway, it can only hold its sixteen mebibytes
 * while it waits. There is one administrator and a sign-in is one derivation,
 * so this is never met by a person. It is deliberately NOT a window: it clears
 * the instant the work finishes, so a legitimate sign-in arriving during a
 * burst waits milliseconds rather than the fifteen minutes the guess budget
 * would impose.
 *
 * Nothing rejected here spends the guess budget. No credential was evaluated,
 * so nothing was learned from the secret, and charging for it would let a burst
 * lock the owner out through a door it never opened.
 */
const MAX_DERIVATIONS_IN_FLIGHT = 4;

let derivationsInFlight = 0;

/**
 * The request body, capped, or null if it is bigger than any sign-in ever is.
 *
 * `request.json()` buffers whatever arrives before anyone looks at the size, so
 * on an unauthenticated endpoint it is an invitation to post a gigabyte. Reading
 * the stream and stopping at the cap is a few more lines and removes the
 * invitation. The same helper appears in `/api/admin/enroll`; the two routes are
 * the only unauthenticated JSON surfaces in the admin area and neither is worth
 * a shared module of its own.
 */
async function readBoundedJson(
  request: Request,
  maxBytes: number,
): Promise<unknown | null> {
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

/** A six-digit code, and nothing that merely contains one. */
const TOTP_CODE = /^[0-9]{6}$/;

/**
 * Recovery codes are generated in apps/app and this app never learns their
 * alphabet, so this is a shape bound rather than a format check: long enough for
 * any sensible code, short enough that the field is not a channel.
 */
const MAX_RECOVERY_CODE_LENGTH = 64;

type Attempt = { kind: "totp"; code: string } | { kind: "recovery"; code: string };

/**
 * Which second factor, if either, this request carries.
 *
 * `null` means none was offered, which is the first-run case and not an error.
 * A refusal names which field was wrong, because these are shape complaints
 * about what the caller typed and none of them says anything about the secret.
 * "You sent something malformed" is not a hint; "your password was right" would
 * be, and that answer lives further down.
 *
 * A request carrying both is refused rather than resolved. Picking one for the
 * caller would mean this endpoint deciding which credential was meant, and a
 * caller who sends two is either confused or probing.
 */
function readAttempt(
  body: Record<string, unknown>,
): { ok: true; attempt: Attempt | null } | { ok: false; message: string } {
  const rawCode = body.code;
  const rawRecovery = body.recoveryCode;

  const hasCode = typeof rawCode === "string" && rawCode.trim().length > 0;
  const hasRecovery =
    typeof rawRecovery === "string" && rawRecovery.trim().length > 0;

  if (hasCode && hasRecovery) {
    return {
      ok: false,
      message:
        "Send either an authenticator code or a recovery code, not both.",
    };
  }

  if (hasCode) {
    // Spaces because authenticator apps display "123 456" and people copy what
    // they see. Nothing else is stripped.
    const code = (rawCode as string).replace(/\s+/g, "");
    if (!TOTP_CODE.test(code)) {
      return {
        ok: false,
        message: "The authenticator code is six digits.",
      };
    }
    return { ok: true, attempt: { kind: "totp", code } };
  }

  if (hasRecovery) {
    const code = (rawRecovery as string).trim();
    if (code.length > MAX_RECOVERY_CODE_LENGTH) {
      return { ok: false, message: "That is not a recovery code." };
    }
    return { ok: true, attempt: { kind: "recovery", code } };
  }

  return { ok: true, attempt: null };
}

function tooMany(retryAfter: number): NextResponse {
  return NextResponse.json(
    { error: "Too many attempts. Try again shortly." },
    { status: 429, headers: { "Retry-After": String(Math.max(retryAfter, 1)) } },
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  /**
   * The limiter runs before the configuration check, not after, because the
   * configuration check writes a log line. An unconfigured deployment left
   * exposed would otherwise let anyone bill the owner for log volume by
   * hammering this path. The cost is that someone poking at an unconfigured
   * server gets 429 after five tries, which is fine: the sign-in page says it is
   * unconfigured without touching this endpoint at all.
   */
  const limit = await rateLimit(
    `admin-session:${clientKey(request.headers)}`,
    ATTEMPT_LIMIT,
    ATTEMPT_WINDOW_MS,
  );
  if (!limit.ok) return tooMany(limit.retryAfter);

  /**
   * The counter above is keyed by a header the caller controls. This one is
   * keyed by nothing, and it says how many guesses a window may contain.
   *
   * What it cannot say is how many may be in flight at once. It is read here
   * and written after the derivation, so a burst arriving together all read the
   * same unspent budget. `MAX_DERIVATIONS_IN_FLIGHT`, below, is the bound that
   * closes that, and the two are deliberately separate: one is about how much a
   * quarter of an hour may cost, the other about how much one instant may.
   */
  const now = Date.now();
  const budget = globalBudget(now);
  if (!budget.ok) return tooMany(budget.retryAfter);

  if (!isAdminAccountConfigured()) {
    console.error(
      "[healdesk] admin sign-in attempted while HEALDESK_ADMIN_EMAIL, HEALDESK_ADMIN_PASSWORD_HASH or HEALDESK_ADMIN_SECRET is unset or malformed",
    );
    return NextResponse.json(
      { error: "There is no admin account configured on this server." },
      { status: 503 },
    );
  }

  const body = await readBoundedJson(request, 4096);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const fields = body as Record<string, unknown>;

  const email = fields.email;
  const password = fields.password;
  if (
    typeof email !== "string" ||
    email.trim().length === 0 ||
    typeof password !== "string" ||
    password.length === 0
  ) {
    return NextResponse.json(
      { error: "Enter the admin email address and password." },
      { status: 400 },
    );
  }

  const second = readAttempt(fields);
  if (!second.ok) {
    return NextResponse.json({ error: second.message }, { status: 400 });
  }
  const attempt = second.attempt;

  /**
   * Step 2. The derivation happens here and nowhere earlier, and no more than
   * `MAX_DERIVATIONS_IN_FLIGHT` of them happen at the same instant.
   *
   * The claim and the release are what make the check above mean anything: the
   * increment is in the same synchronous turn as the test, so a burst arriving
   * together cannot all read zero, and the `finally` returns the slot however
   * the derivation ends. Refused here costs no guess budget, see the note on
   * the constant.
   */
  if (derivationsInFlight >= MAX_DERIVATIONS_IN_FLIGHT) {
    return tooMany(1);
  }

  derivationsInFlight += 1;
  let passwordMatched: boolean;
  try {
    passwordMatched = await verifyAdminPassword(email, password);
  } finally {
    derivationsInFlight -= 1;
  }

  if (!passwordMatched) {
    // Global budget is spent here and nowhere else on this path. A malformed
    // body is not a guess, and a correct password is not one either: only this
    // branch has learned something from the secret, so only this branch pays.
    recordGlobalFailure(now);
    // One sentence for both halves. Saying "no such account" would confirm the
    // address, which is the one field an attacker can otherwise only guess.
    return NextResponse.json(
      { error: "That email and password did not match." },
      { status: 401 },
    );
  }

  // Step 3. What the second factor is, before deciding whether one is owed.
  const state = await getAdminTotpState();
  if (!state.ok) {
    console.error(
      "[healdesk] admin sign-in: could not read the second-factor state:",
      state.code,
    );
    return NextResponse.json(
      {
        error:
          "The password was right, but the second factor could not be checked just now. Nothing was signed in. Try again in a moment.",
      },
      { status: 503 },
    );
  }

  // The same normalisation the token uses, from the same module, so the address
  // written into the cookie cannot drift from the one it is checked against.
  const signedInEmail = normaliseEmail(email);

  if (!state.data.enrolled) {
    /**
     * First run. This is one factor, so what goes back is an ENROLMENT token and
     * not a session: a different cookie, under a different key, that
     * `requireOperator()` will never accept and that no ops route can be reached
     * with. The only thing it opens is `/api/admin/enroll`.
     *
     * An attempt that carried a code is not refused here. There is nothing to
     * check it against, and telling somebody "that code is wrong" when no
     * authenticator exists would be describing a state that does not exist.
     */
    const response = NextResponse.json({ next: "enroll" }, { status: 200 });
    response.cookies.set(
      ENROLMENT_COOKIE,
      issueEnrolmentToken(signedInEmail),
      enrolmentCookieOptions(),
    );
    return response;
  }

  if (attempt === null) {
    // The password was right, so this branch does confirm it. That is not a new
    // fact for anyone who reaches it: a wrong password already stopped at 401
    // above, and a right one is the thing they would have had to guess. It costs
    // no global budget because nothing was guessed at the second factor.
    return NextResponse.json(
      {
        error: "Enter the six-digit code from your authenticator app.",
        next: "code",
      },
      { status: 401 },
    );
  }

  /**
   * Two operations rather than one, because a TOTP code and a recovery code are
   * different credentials with different consequences: a step comes back in
   * thirty seconds, a recovery code never does.
   *
   * Both decide and record on the far side, in one call. That is the whole
   * reason the replay check is worth having: a compare-and-set split across a
   * network is a race, and two requests carrying the same code would both read
   * the same last-used step and both be let in.
   *
   * The refusal sentence is upstream's, because upstream is the only side that
   * knows whether the code was wrong, already spent, or refused by a throttle.
   */
  let accepted = false;
  let refusal = "That code was not accepted.";
  let codesLeft: number | null = null;

  if (attempt.kind === "totp") {
    const verdict = await verifyAdminTotpStep({ code: attempt.code });
    if (!verdict.ok) return secondFactorUnavailable(verdict.code);
    accepted = verdict.data.ok;
    if (!verdict.data.ok) refusal = verdict.data.message;
  } else {
    const verdict = await burnRecoveryCode({ code: attempt.code });
    if (!verdict.ok) return secondFactorUnavailable(verdict.code);
    accepted = verdict.data.ok;
    if (verdict.data.ok) codesLeft = verdict.data.remaining;
    else refusal = verdict.data.message;
  }

  if (!accepted) {
    recordGlobalFailure(now);
    return NextResponse.json({ error: refusal }, { status: 401 });
  }

  // Step 4. Both factors, then the cookie, and only here.
  const response = NextResponse.json(
    {
      next: "admin",
      // Present only when a recovery code was spent, so the browser can say so
      // once on the way in. There is deliberately no operation that issues more,
      // so the count matters before it runs out rather than after.
      ...(codesLeft !== null ? { recoveryCodesRemaining: codesLeft } : {}),
    },
    { status: 200 },
  );
  response.cookies.set(
    OPERATOR_COOKIE,
    issueOperatorToken(signedInEmail),
    operatorCookieOptions(),
  );
  // A stale enrolment cookie from an abandoned first run has no business
  // outliving a real sign-in. Same flags, so the browser actually replaces it.
  response.cookies.set(ENROLMENT_COOKIE, "", {
    ...enrolmentCookieOptions(),
    maxAge: 0,
  });

  // Step 5. After the response, so a slow mailer cannot hold the console shut,
  // and never on a path that could turn a mail failure into a failed sign-in.
  scheduleAlert(request);

  return response;
}

/**
 * The sign-in alert, fired after the response is sent.
 *
 * Who it goes to is deliberately not an argument. apps/app addresses it to the
 * operator it resolves from its own `HEALDESK_ADMIN_EMAIL`, so an attacker with
 * full command of this app cannot redirect the one notification that would tell
 * the owner they are there.
 *
 * `after()` rather than a floating promise: a bare `void promise` in a
 * serverless function races the runtime freezing the instance, so the mail
 * either goes or does not depending on how quickly the response was flushed.
 * `after()` is the platform's own "keep the instance alive for this".
 *
 * Nothing it does can fail a sign-in. What it must not do is fail SILENTLY: an
 * alert nobody notices is missing is worse than no alert, because the whole
 * point of it is that the owner learns about a sign-in they did not perform. So
 * every unhappy path writes a log line naming the reason.
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
          "[healdesk] admin sign-in alert failed:",
          sent.code,
          `signed in at ${at}`,
        );
        return;
      }
      if (sent.data.delivery !== "sent") {
        console.error(
          "[healdesk] admin sign-in alert was not delivered:",
          sent.data.delivery,
          sent.data.reason ?? "no reason given",
          `signed in at ${at}`,
        );
      }
    } catch (error) {
      console.error(
        "[healdesk] admin sign-in alert threw:",
        error,
        `signed in at ${at}`,
      );
    }
  });
}

/**
 * One sentence for "apps/app could not answer", used by both second-factor
 * paths. 503 and no cookie: an outage must not become a single-factor console,
 * because an attacker who can cause an outage would then be choosing to.
 */
function secondFactorUnavailable(code: string): NextResponse {
  console.error("[healdesk] admin sign-in: second factor unavailable:", code);
  return NextResponse.json(
    {
      error:
        "The code could not be checked just now. Nothing was signed in. Try again in a moment.",
    },
    { status: 503 },
  );
}

/**
 * Sign out. Unauthenticated on purpose: clearing your own cookie needs no
 * credential, is idempotent, and the worst a forged call achieves is signing the
 * owner out, which `sameSite: "strict"` already prevents from another origin,
 * and which costs one sign-in if it ever happened.
 *
 * Both cookies go. A half-finished enrolment left behind by a sign-out is a
 * one-factor credential sitting in a browser for ten minutes with nobody
 * expecting it to be there.
 *
 * The flags are repeated on the way out because a browser only replaces a cookie
 * when name, path and domain all match the original.
 */
export async function DELETE(): Promise<NextResponse> {
  const response = new NextResponse(null, { status: 204 });
  response.cookies.set(OPERATOR_COOKIE, "", {
    ...operatorCookieOptions(),
    maxAge: 0,
  });
  response.cookies.set(ENROLMENT_COOKIE, "", {
    ...enrolmentCookieOptions(),
    maxAge: 0,
  });
  return response;
}
