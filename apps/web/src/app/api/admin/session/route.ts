import { NextResponse, after } from "next/server";

import {
  OPERATOR_COOKIE,
  STEP_COOKIE,
  isAdminAccountConfigured,
  issueOperatorToken,
  issueStepToken,
  missingAdminConfig,
  normaliseEmail,
  operatorCookieOptions,
  stepCookieOptions,
  verifyAdminPassword,
  verifyStepToken,
} from "@/lib/admin/operator";
import { printable, sendSignInAlert } from "@/lib/admin/sign-in-alert";
import {
  TOTP_SECRET_VARIABLE,
  adminTotpSecret,
  claimStep,
  matchTotpStep,
  totpStep,
} from "@/lib/admin/totp";
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
 *   3. **The second factor**, checked here against `HEALDESK_ADMIN_TOTP_SECRET`
 *      (`lib/admin/totp.ts`), then the replay checks: the browser's signed
 *      step cookie and this process's ledger. Nothing on this path calls
 *      apps/app.
 *   4. **Only then the cookie.** There is no branch in this file that issues an
 *      operator cookie without having passed 2 and 3.
 *   5. **The alert email, after the response.** Never before, never blocking.
 *
 * ## Why this app checks the code itself (owner, 14 October 2026)
 *
 * Until 14 October the secret, the last-used step and the recovery codes lived
 * in apps/app's database, and this route asked for a verdict over the signed
 * ops API. That was the stronger replay design, because "refuse a step already
 * used" is a compare-and-set and a database can make one atomic. It also meant
 * /admin could not be signed into while the AWS host was off, so the owner
 * moved the factor onto Vercel: the secret is an environment variable, sign-in
 * makes no call to apps/app, and apps/web still has no database client.
 *
 * What that gives up is written where the replay check lives, in the notes on
 * `claimStep` in `lib/admin/totp.ts`: two different serverless instances can each
 * accept the same code once inside its ninety seconds. The password, the two
 * attempt limits below and the alert on every success are what stand in front
 * of that. Recovery codes went too: they needed a store to be spent from. A
 * lost authenticator now means running `npm run admin:totp -w @healdesk/web`
 * again and replacing the variable in Vercel, whose own account sits behind
 * its own second factor.
 *
 * ## Failing closed on a missing secret
 *
 * With `HEALDESK_ADMIN_TOTP_SECRET` unset or malformed this answers 503 and
 * issues nothing, whatever the password was. "There is no second factor
 * configured, so let them in on the password" would turn one forgotten
 * variable into a single-factor console. The 503 names the variable because
 * it is reached only after the password was right, so the only person who
 * reads the sentence is the one who can fix it; a request without the
 * password learns nothing about it.
 *
 * ## Statuses
 *
 * 200 with `{ next: "admin" }` on success, 401 on bad credentials, a missing
 * code (`next: "code"`), a wrong code or a code already used, 429 out of
 * budget, 400 on a malformed body, 503 when the account or its second factor
 * is not configured. The last is deliberately not folded into 401: "your
 * password is wrong" and "this server has no admin account" are different
 * facts, and answering the second with the first would be lying to the only
 * person who could fix it.
 *
 * ## A log line per outcome
 *
 * apps/web has no audit table, so every attempt that gets past the limiters
 * writes one structured line (`[healdesk] admin sign-in {...}`): success,
 * wrong password, code required, wrong code, replayed code, misconfigured.
 * Each carries the outcome, the time and the request's apparent address.
 * Never the code, the password, the secret, or the email address typed: a
 * password typed into the email field is the commonest way a password reaches
 * a log, so the address field is not logged even though it is usually right.
 * Volume is bounded by the same limits as the attempts: wrong passwords and
 * codes spend the global budget, and the other outcomes need the password.
 *
 * There is no CSRF token. The cookies are `sameSite: "strict"`, so a cross-site
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
 * invitation. This is the only unauthenticated JSON surface in the admin area,
 * so the helper lives here rather than in a module of its own.
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
 * The six-digit code, if this request carries one.
 *
 * `null` means none was offered, which the caller answers with `next: "code"`.
 * A refusal is a shape complaint about what the caller typed, and says nothing
 * about the secret. A `recoveryCode` field, which an old tab might still send,
 * is ignored: recovery codes were retired with the database that spent them,
 * and treating one as "no code offered" gets the right answer back.
 */
function readCode(
  body: Record<string, unknown>,
): { ok: true; code: string | null } | { ok: false; message: string } {
  const raw = body.code;
  if (typeof raw !== "string" || raw.trim().length === 0) return { ok: true, code: null };

  // Spaces because authenticator apps display "123 456" and people copy what
  // they see. Nothing else is stripped.
  const code = raw.replace(/\s+/g, "");
  if (!TOTP_CODE.test(code)) {
    return { ok: false, message: "The authenticator code is six digits." };
  }
  return { ok: true, code };
}

/**
 * One cookie off the request's `Cookie` header, without `cookies()` from
 * `next/headers`: this handler is also run directly by its tests, outside a
 * Next request scope, and the one cookie it reads is ours and plain ASCII.
 */
function readCookie(headers: Headers, name: string): string | undefined {
  const header = headers.get("cookie");
  if (header === null) return undefined;
  for (const part of header.split(";")) {
    const equals = part.indexOf("=");
    if (equals < 0) continue;
    if (part.slice(0, equals).trim() === name) return part.slice(equals + 1).trim();
  }
  return undefined;
}

type Outcome =
  | "success"
  | "wrong_password"
  | "code_required"
  | "wrong_code"
  | "replayed_code"
  | "misconfigured";

/**
 * The one log line per attempt outcome. See "A log line per outcome" above for
 * what is in it and, more to the point, what never is.
 *
 * JSON, so the address (a header the caller wrote) cannot break the line in
 * two and forge a second entry; `printable` caps and escapes it first anyway.
 */
function logAttempt(
  outcome: Outcome,
  request: Request,
  detail: Record<string, string> = {},
): void {
  const line = `[healdesk] admin sign-in ${JSON.stringify({
    outcome,
    at: new Date().toISOString(),
    ip: printable(clientKey(request.headers), 64),
    ...detail,
  })}`;
  if (outcome === "misconfigured") console.error(line);
  else if (outcome === "success" || outcome === "code_required") console.info(line);
  else console.warn(line);
}

function tooMany(retryAfter: number): NextResponse {
  return NextResponse.json(
    { error: "Too many attempts. Try again shortly." },
    { status: 429, headers: { "Retry-After": String(Math.max(retryAfter, 1)) } },
  );
}

const ALREADY_USED = "That code has already been used. Wait for the next one.";

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
    // The names of the variables, never their values; and only to the log.
    logAttempt("misconfigured", request, {
      missing: missingAdminConfig()
        .filter((name) => name !== TOTP_SECRET_VARIABLE)
        .join(","),
    });
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

  const offered = readCode(fields);
  if (!offered.ok) {
    return NextResponse.json({ error: offered.message }, { status: 400 });
  }

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
    // Global budget is spent here and on a wrong code, nowhere else. A
    // malformed body is not a guess, and a correct password is not one either:
    // only a branch that has learned something from a secret pays.
    recordGlobalFailure(now);
    logAttempt("wrong_password", request);
    // One sentence for both halves. Saying "no such account" would confirm the
    // address, which is the one field an attacker can otherwise only guess.
    return NextResponse.json(
      { error: "That email and password did not match." },
      { status: 401 },
    );
  }

  // Step 3. Is there a second factor to check against at all? Fail closed.
  const secret = adminTotpSecret();
  if (!secret.ok) {
    logAttempt("misconfigured", request, {
      variable: TOTP_SECRET_VARIABLE,
      problem: secret.problem,
    });
    return NextResponse.json(
      {
        error:
          secret.problem === "unset"
            ? `${TOTP_SECRET_VARIABLE} is not set on this server, so no code can be checked and nothing was signed in. Run npm run admin:totp -w @healdesk/web and add it in Vercel.`
            : `${TOTP_SECRET_VARIABLE} on this server is not a 32-character base32 secret, so no code can be checked and nothing was signed in. Run npm run admin:totp -w @healdesk/web and replace it in Vercel.`,
      },
      { status: 503 },
    );
  }

  if (offered.code === null) {
    // The password was right, so this branch does confirm it. That is not a new
    // fact for anyone who reaches it: a wrong password already stopped at 401
    // above, and a right one is the thing they would have had to guess. It costs
    // no global budget because nothing was guessed at the second factor.
    logAttempt("code_required", request);
    return NextResponse.json(
      {
        error: "Enter the six-digit code from your authenticator app.",
        next: "code",
      },
      { status: 401 },
    );
  }

  /**
   * The code, then the two replay checks, all in one synchronous turn: no
   * `await` between matching the step and claiming it, so two requests in this
   * process carrying the same code cannot both read the ledger before either
   * writes it. The clock is read here rather than reusing `now`, which was taken
   * before a derivation that can take a while under load.
   */
  const step = matchTotpStep(secret.key, offered.code, totpStep(Date.now()));
  if (step === null) {
    recordGlobalFailure(now);
    logAttempt("wrong_code", request);
    return NextResponse.json(
      { error: "That code is not right. Check the clock on your phone and try the next one." },
      { status: 401 },
    );
  }

  // This browser's own record: the same code, or an older one, from here again.
  const browserStep = verifyStepToken(readCookie(request.headers, STEP_COOKIE));
  if (browserStep !== null && step <= browserStep) {
    recordGlobalFailure(now);
    logAttempt("replayed_code", request, { seen: "browser" });
    return NextResponse.json({ error: ALREADY_USED }, { status: 401 });
  }

  // This process's record, which every browser shares. See `claimStep`.
  if (!claimStep(secret.key, step)) {
    recordGlobalFailure(now);
    logAttempt("replayed_code", request, { seen: "instance" });
    return NextResponse.json({ error: ALREADY_USED }, { status: 401 });
  }

  // Step 4. Both factors, then the cookies, and only here. The same
  // normalisation the token uses, from the same module, so the address written
  // into the cookie cannot drift from the one it is checked against.
  const response = NextResponse.json({ next: "admin" }, { status: 200 });
  response.cookies.set(
    OPERATOR_COOKIE,
    issueOperatorToken(normaliseEmail(email)),
    operatorCookieOptions(),
  );
  response.cookies.set(STEP_COOKIE, issueStepToken(step), stepCookieOptions());

  logAttempt("success", request);

  // Step 5. After the response, so a slow mailer cannot hold the console shut,
  // and never on a path that could turn a mail failure into a failed sign-in.
  scheduleAlert(request);

  return response;
}

/**
 * The sign-in alert, fired after the response is sent, by this app through its
 * own Resend sender (`lib/admin/sign-in-alert.ts` says why it moved here and
 * what it carries).
 *
 * `after()` rather than a floating promise: a bare `void promise` in a
 * serverless function races the runtime freezing the instance, so the mail
 * either goes or does not depending on how quickly the response was flushed.
 * `after()` is the platform's own "keep the instance alive for this".
 *
 * Nothing it does can fail a sign-in. What it must not do is fail SILENTLY: an
 * alert nobody notices is missing is worse than no alert, because the whole
 * point of it is that the owner learns about a sign-in they did not perform.
 * So every unhappy path writes a log line naming the reason.
 */
function scheduleAlert(request: Request): void {
  const at = new Date();
  const ip = clientKey(request.headers);
  const userAgent = request.headers.get("user-agent");

  after(async () => {
    try {
      const sent = await sendSignInAlert({
        at,
        ...(ip !== "unknown" ? { ipAddress: ip } : {}),
        ...(userAgent !== null ? { userAgent } : {}),
      });
      if (sent.status !== "sent") {
        console.error(
          "[healdesk] admin sign-in alert was not delivered:",
          sent.status,
          sent.reason,
          `signed in at ${at.toISOString()}`,
        );
      }
    } catch (error) {
      console.error(
        "[healdesk] admin sign-in alert threw:",
        error instanceof Error ? error.message : "unknown error",
        `signed in at ${at.toISOString()}`,
      );
    }
  });
}

/**
 * Sign out. Unauthenticated on purpose: clearing your own cookie needs no
 * credential, is idempotent, and the worst a forged call achieves is signing the
 * owner out, which `sameSite: "strict"` already prevents from another origin,
 * and which costs one sign-in if it ever happened.
 *
 * The step cookie stays (see `stepCookieOptions`): signing out and then
 * offering the same six digits again is the reuse it exists to refuse.
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
  return response;
}
