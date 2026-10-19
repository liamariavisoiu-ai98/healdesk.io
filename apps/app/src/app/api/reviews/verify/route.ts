import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verify,
} from "@healdesk/catalog";

import { env } from "@/lib/env";
import { listClinics } from "@/lib/ops/clinics";
import { log } from "@/lib/log";

/**
 * POST /api/reviews/verify — does this customer ID belong to a clinic?
 *
 * Called server-to-server by the marketing site when somebody fills in the
 * "leave a review" form, signed with the same shared secret as provisioning and
 * agreements. The marketing site has no database, so this is the only place the
 * question can be answered.
 *
 * The answer is deliberately thin: a name and a specialty, and only once the ID
 * has already matched. Nothing about the clinic's plan, contacts, volumes or
 * status crosses this boundary, because the caller's whole job is to decide
 * whether to accept a paragraph of text and put a subject line on an email.
 *
 * ## Why it reads through listClinics
 *
 * With no tenant set, the runtime role sees zero rows in `clinics` — that is
 * row-level security working as designed, and it is why an obvious
 * `select ... from clinics where slug = $1` here would always answer "no such
 * customer". The `app_clinics_overview()` SECURITY DEFINER function is the one
 * sanctioned exception, and src/lib/ops/clinics.ts is where its projection is
 * pinned down, so this route goes through that rather than writing its own SQL
 * and widening it by accident.
 *
 * The cost is that a lookup reads every clinic and filters in memory, which is
 * the wrong shape at ten thousand tenants and completely irrelevant at ours:
 * the caller allows three attempts per hour per address, so this runs a handful
 * of times a day. Give it its own filtered function when that stops being true.
 *
 * ## What counts as a customer ID
 *
 * The clinic's slug, which is the identifier a human can actually read off an
 * account and retype, or the clinic's UUID for anyone pasting from a report.
 * Matching is case-insensitive, because people capitalise things.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CUSTOMER_ID = 120;

export async function POST(request: Request): Promise<Response> {
  const secret = env.provisionSecret();
  if (!secret) {
    log.error("HEALDESK_PROVISION_SECRET is not set");
    return Response.json({ error: "Verification is unavailable." }, { status: 503 });
  }

  const raw = await request.text();
  const verification = verify(
    raw,
    request.headers.get(TIMESTAMP_HEADER),
    request.headers.get(SIGNATURE_HEADER),
    secret,
  );
  if (!verification.ok) {
    log.warn("review verification rejected", { reason: verification.reason });
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const candidate = (body as { customerId?: unknown } | null)?.customerId;
  const wanted =
    typeof candidate === "string"
      ? candidate.trim().slice(0, MAX_CUSTOMER_ID).toLowerCase()
      : "";

  if (!wanted) {
    return Response.json({ error: "No customer ID supplied." }, { status: 400 });
  }

  const clinics = await listClinics();

  /**
   * Exact first, then punctuation-insensitive.
   *
   * The form presents the ID as XX-XXX-XXXX, and what the database holds is a
   * slug or a UUID, so a customer reading a dashed code off an account and a
   * customer pasting a slug have to land on the same row. Squashing to letters
   * and digits makes "ab-cde-1234", "AB CDE 1234" and "abcde1234" the same
   * question.
   *
   * Exact still wins, because squashing can in principle collide two different
   * slugs ("a-bc" and "ab-c"), and the exact match is the one that cannot.
   *
   */
  const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const squashed = squash(wanted);

  const match =
    clinics.find(
      (clinic) =>
        clinic.slug.toLowerCase() === wanted || clinic.id.toLowerCase() === wanted,
    ) ??
    clinics.find(
      (clinic) =>
        squash(clinic.slug) === squashed || squash(clinic.id) === squashed,
    );

  // 404 rather than a 200 carrying `found: false`, so the caller can tell "no
  // such customer" from "we could not ask" by status alone. Getting those two
  // confused is how a real customer is told their ID is wrong during an outage.
  if (!match) {
    return Response.json({ found: false }, { status: 404 });
  }

  return Response.json({
    found: true,
    clinic: { name: match.name, specialty: match.specialty },
  });
}
