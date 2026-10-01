import { NextResponse } from "next/server";

import { GATE_COOKIE, verifyGateToken } from "@/lib/gate";
import { markCallPlaced, recordCallConsent } from "@/lib/leads";
import { canContactProspect } from "@/lib/prospect-consent";
import { maskPhone, normalizePhone } from "@/lib/phone";
import { clientKey, isOverLimit, rateLimit } from "@/lib/rate-limit";
import { getSpecialty } from "@/lib/specialties";
import { placeCall, readSynthflowConfig } from "@/lib/synthflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/callback, "have AYA call me" on the voice demo.
 *
 * A demo call to a clinic owner or staff member who asked for one, placed
 * through Synthflow until a Retell demo agent exists (see lib/synthflow.ts).
 * It is not a patient call-back: the product is inbound only and never dials
 * a patient, and the panel that posts here says so.
 *
 * ## This endpoint dials a phone. Treat it accordingly.
 *
 * Everything else on this site is read-only from the visitor's side. This one
 * causes a real telephone, belonging to a real person, to ring, with our name
 * on the caller ID. An unguarded version of it is a harassment tool and a
 * TCPA exposure at $500–$1,500 a call, so three checks stand in front of the
 * provider and none of them are optional:
 *
 *   1. Shape.   `normalizePhone` refuses 911, service codes and junk.
 *   2. Consent. Explicit, unbundled, and recorded WITH the version of the words
 *               that were agreed to (see lib/consent.ts).
 *   3. Volume.  Rate limited per IP *and* per destination number. The per-number
 *               limit is the one that matters: without it, one attacker with a
 *               proxy pool can point this at somebody's phone all afternoon.
 *
 * ## One path, and it is the phone field
 *
 * There is deliberately no "email us and we'll ring you" fallback. The whole
 * point of the panel is that a visitor types their number and gets a call, and
 * offering a second, slower channel at the first sign of trouble turns the one
 * thing that proves the product into a contact form. A failure here says so
 * plainly and invites a retry; the operator-actionable reason goes to the log,
 * never to the visitor, because a vendor error can name our account or balance.
 */

/**
 * Two separate per-IP budgets, because they are guarding different things.
 *
 * ATTEMPT covers every request that reaches the handler, valid or not, and only
 * has to stop somebody hammering the endpoint, validation is cheap, so it can
 * be loose. PLACED is consumed only once a request has passed every check and
 * is about to cost us a real phone call, so it is tight.
 *
 * Charging a rejected request against the tight budget is the bug this replaces:
 * a visitor who mistypes their number twice would have been locked out on the
 * third, correct, attempt, with an error message blaming them for requesting
 * too many calls when none had been placed at all.
 */
const ATTEMPT_LIMIT = 20;
const ATTEMPT_WINDOW_MS = 60 * 60 * 1000;

const PLACED_LIMIT = 3;
const PLACED_WINDOW_MS = 60 * 60 * 1000;

/** Per-destination-number, across all IPs. The anti-harassment limit. */
const NUMBER_LIMIT = 2;
const NUMBER_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Site-wide calls per UTC day. Every placed call costs real vendor minutes,
 * and this is the one budget that bounds the bill rather than a visitor.
 * Override with DEMO_DAILY_CALL_CAP; 0 switches the demo call off.
 */
const DAILY_CALL_CAP = Number(process.env.DEMO_DAILY_CALL_CAP ?? 40);

function fail(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request): Promise<NextResponse> {
  // 1. Loose per-IP attempt limit, before we parse anything.
  const ip = clientKey(request.headers);
  const attempts = await rateLimit(
    `callback:attempt:${ip}`,
    ATTEMPT_LIMIT,
    ATTEMPT_WINDOW_MS,
  );
  if (!attempts.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(attempts.retryAfter) } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("Invalid request body.", 400);
  }

  const { phone, consent, consentVersion, specialtyId, name } = (body ?? {}) as {
    phone?: unknown;
    consent?: unknown;
    consentVersion?: unknown;
    specialtyId?: unknown;
    name?: unknown;
  };

  // 2. Consent, decided by the one gate every prospect contact passes
  //    through (lib/prospect-consent.ts): `=== true`, and the wording version
  //    the client rendered must be the one we publish now. A stale tab must
  //    not produce a record that claims agreement to this month's words.
  const decision = canContactProspect({ channel: "voice", consent, consentVersion });
  if (!decision.allowed) {
    return fail(decision.reason, decision.code === "stale_consent" ? 409 : 400);
  }

  // 3. Shape.
  const parsed = normalizePhone(phone);
  if (!parsed.ok) return fail(parsed.reason, 400);

  // 4. Per-number limit. Checked here but CHARGED only after the call is
  //    actually placed, at the bottom of this handler.
  //
  //    The budget exists to stop a stranger's phone being rung over and over,
  //    so a request that never reached the carrier has cost that stranger
  //    nothing and must not consume their allowance. Charging on arrival meant
  //    a spell of provider trouble, or, right now, a provider that is simply
  //    unconfigured, locked a visitor out of their own number for a day over
  //    calls that never happened.
  //
  //    Keyed on the normalized E.164 rather than the raw input, or
  //    "(415) 867-5309" and "+14158675309" would occupy separate buckets and
  //    the limit would be trivially doubled.
  const numberKey = `callback:num:${parsed.e164}`;
  if (await isOverLimit(numberKey, NUMBER_LIMIT)) {
    return NextResponse.json(
      { error: "We've already called this number today." },
      { status: 429, headers: { "Retry-After": "3600" } },
    );
  }

  // 5. The tight per-IP budget, charged only now that the request is one we
  //    would actually dial. Everything above this line is free to get wrong.
  const placed = await rateLimit(`callback:placed:${ip}`, PLACED_LIMIT, PLACED_WINDOW_MS);
  if (!placed.ok) {
    return NextResponse.json(
      { error: "You've requested a few calls already. Try again later." },
      { status: 429, headers: { "Retry-After": String(placed.retryAfter) } },
    );
  }

  // 5b. The site-wide daily ceiling. After the per-IP budget for the same
  //     reason the chat demo checks its own last: one abuser exhausts their
  //     own allowance, not everyone's.
  const daily = await rateLimit("callback:global:day", DAILY_CALL_CAP, NUMBER_WINDOW_MS);
  if (!daily.ok) {
    return NextResponse.json(
      { error: "The demo line has reached its daily limit. Try the chat demo, or book a live walkthrough from the contact page." },
      { status: 429, headers: { "Retry-After": String(daily.retryAfter) } },
    );
  }

  const specialty =
    typeof specialtyId === "string" ? getSpecialty(specialtyId) : undefined;
  const callerName =
    typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : undefined;

  // If they already unlocked the chat demo, the signed gate cookie carries
  // their email, worth attaching so the two halves of one visit are the same
  // lead rather than two.
  const gateEmail = verifyGateToken(
    request.headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${GATE_COOKIE}=`))
      ?.slice(GATE_COOKIE.length + 1),
  )?.email;

  // 6. The consent record. Written before the call is placed, so a request
  //    that fails at the vendor still leaves evidence of what was agreed to.
  //    It lives in the marketing store's call_consents table (not apps/app,
  //    which is the PHI boundary — this is a clinic operator's own business
  //    contact detail), keyed to the lead when the gate cookie names one,
  //    and it outlives the lead: the reference is SET NULL on delete.
  const consentId = await recordCallConsent({
    phoneE164: parsed.e164,
    consentVersion: decision.consentVersion,
    consentText: decision.consentText,
    ipAddress: ip,
    userAgent: request.headers.get("user-agent"),
    leadEmail: gateEmail,
  });
  console.info("[healdesk] callback requested", {
    consentId,
    specialty: specialty?.id,
    consentVersion: decision.consentVersion,
    at: new Date().toISOString(),
  });

  const config = readSynthflowConfig();
  if (!config.ok) {
    console.error(
      `[healdesk] callback requested but Synthflow is unconfigured: ${config.missing.join(", ")}`,
    );
    return fail("We couldn't connect the call. Try again in a moment.", 503);
  }

  const result = await placeCall(config.config, {
    phone: parsed.e164,
    // The API requires a recipient name and it is spoken on the call, so an
    // empty one would have AYA greeting a blank. "there" reads naturally.
    name: callerName ?? "there",
    email: gateEmail ?? undefined,
    variables: {
      specialty: specialty?.name ?? "aesthetic",
      specialty_context: specialty?.context ?? "",
      source: "healdesk.io demo",
    },
  });

  if (!result.ok) {
    // The reason is for us, never for the visitor, a vendor message can name
    // our account, our balance, or our agent configuration.
    console.error("[healdesk] synthflow call failed", {
      reason: result.reason,
      detail: result.detail,
    });
    return fail("We couldn't connect the call. Try again in a moment.", 502);
  }

  // The call is away. Only now does it come out of the number's budget.
  await rateLimit(numberKey, NUMBER_LIMIT, NUMBER_WINDOW_MS);
  await markCallPlaced(consentId);

  console.info("[healdesk] callback placed", {
    callId: result.callId,
    last4: maskPhone(parsed.e164),
  });

  return NextResponse.json({ ok: true, last4: maskPhone(parsed.e164) });
}
