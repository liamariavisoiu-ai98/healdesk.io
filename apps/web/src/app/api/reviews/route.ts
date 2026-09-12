import { SIGNATURE_HEADER, TIMESTAMP_HEADER, sign } from "@healdesk/catalog";
import { NextResponse } from "next/server";

import { clientKey, rateLimit } from "@/lib/rate-limit";
import { isStateCode } from "@/lib/us-places";
import { site } from "@/lib/site";

/**
 * POST /api/reviews, a customer leaves a review.
 *
 * Two things have to be true before this returns a success, and they fail in
 * different directions:
 *
 *   1. The customer ID belongs to a real clinic. Only the product database
 *      knows that, and the marketing site never talks to it, so this signs the
 *      question and forwards it exactly the way /api/checkout and
 *      /api/agreement forward theirs.
 *   2. The review reaches a person. Nothing here publishes anything. A named
 *      testimonial that self-publishes on POST means the first human at
 *      healdesk to read it is the one who reads it on the homepage, next to
 *      whatever a competitor decided to put in a customer's mouth.
 *
 * So this route is a gate and a courier, and it holds no state of its own.
 *
 * ## Why the gate is not a login
 *
 * There is no session, no password and nothing to sign into. Clinics do not
 * operate software here (see the note at the top of KnowMore.tsx); they get a
 * service. The ID is a claim we check, and getting it wrong comes back as a
 * field error on the form rather than as an authentication failure.
 *
 * The check is deliberately not an oracle for guessing IDs. It is rate limited
 * to three attempts an hour per address, and the answer is a bare yes or no
 * with no clinic detail attached until the answer is yes.
 *
 * ## Why the portrait travels in the JSON body
 *
 * A separate upload endpoint means object storage, a lifecycle policy, and a
 * public bucket sitting in front of a form that anyone on the internet can
 * post to. The browser crops and re-encodes to a 320px JPEG first (see
 * toSquareJpeg in LeaveReview.tsx), which lands around 30KB, so it fits in the
 * request with room to spare and leaves this route with nothing to store. It is
 * checked here regardless of what the browser claims to have done: the shape of
 * the data URL, its decoded length, and its magic bytes.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT = 3;
const RATE_WINDOW_MS = 60 * 60 * 1000;

/** Generous against a 30KB portrait, tight against anything else. */
const MAX_BODY_BYTES = 400 * 1024;

const MAX_NAME = 120;
const MAX_CUSTOMER_ID = 120;
/**
 * The published card's own ceiling.
 *
 * Matched to what a card five across can show rather than to a round number,
 * and asserted on the published side by src/lib/reviews.test.ts. Trimmed here
 * rather than refused: a title one character over is not worth bouncing a
 * review for, and the moderator sees what arrived either way.
 */
const MAX_TITLE = 40;
const MAX_JOB_TITLE = 60;
const MAX_CITY = 80;
const MAX_REVIEW = 2_000;

const PHOTO_PREFIX = "data:image/jpeg;base64,";
const MAX_PHOTO_BYTES = 200 * 1024;

/** JPEG SOI + APP marker. The browser writes JPEG; anything else is not ours. */
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

function fail(message: string, status: number, field?: string): NextResponse {
  return NextResponse.json({ error: message, field }, { status });
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * Decode the portrait, or say why not.
 *
 * Returns null for "no photo was sent", which is the common case and not an
 * error. A string is the failure message.
 */
function readPhoto(
  value: unknown,
): { ok: true; jpeg: Buffer | null } | { ok: false; reason: string } {
  if (value === null || value === undefined || value === "") {
    return { ok: true, jpeg: null };
  }
  if (typeof value !== "string" || !value.startsWith(PHOTO_PREFIX)) {
    return { ok: false, reason: "That photo wasn't in a format we can take." };
  }

  const jpeg = Buffer.from(value.slice(PHOTO_PREFIX.length), "base64");

  if (jpeg.length === 0) {
    return { ok: false, reason: "That photo wasn't in a format we can take." };
  }
  if (jpeg.length > MAX_PHOTO_BYTES) {
    return { ok: false, reason: "That photo is too large." };
  }
  // The prefix is a claim by the sender. This is the file saying so itself.
  if (!jpeg.subarray(0, 3).equals(JPEG_MAGIC)) {
    return { ok: false, reason: "That photo wasn't in a format we can take." };
  }

  return { ok: true, jpeg };
}

type CustomerCheck =
  | { status: "found"; clinic: { name: string; specialty: string } }
  | { status: "unknown" }
  | { status: "unavailable" };

/**
 * Ask the product whether this customer ID exists.
 *
 * Signed over body and timestamp with the shared provisioning secret, so the
 * endpoint on the other side answers us and nobody else. An unreachable app is
 * reported as "unavailable" rather than folded into "unknown": telling a real
 * customer their ID is wrong because our own network was down would be the
 * worst answer of the three.
 */
async function checkCustomer(customerId: string): Promise<CustomerCheck> {
  const secret = process.env.HEALDESK_PROVISION_SECRET;
  const target = process.env.HEALDESK_APP_URL;

  if (!secret || !target) {
    console.error(
      "[healdesk] HEALDESK_PROVISION_SECRET or HEALDESK_APP_URL is not set",
    );
    return { status: "unavailable" };
  }

  const payload = JSON.stringify({ customerId });
  const timestamp = Math.floor(Date.now() / 1000).toString();

  let response: Response;
  try {
    response = await fetch(new URL("/api/reviews/verify", target), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: sign(payload, timestamp, secret),
      },
      body: payload,
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    console.error("[healdesk] customer verification unreachable", error);
    return { status: "unavailable" };
  }

  if (response.status === 404) return { status: "unknown" };

  if (!response.ok) {
    console.error("[healdesk] customer verification failed", {
      status: response.status,
    });
    return { status: "unavailable" };
  }

  const body = (await response.json().catch(() => null)) as {
    clinic?: { name?: unknown; specialty?: unknown };
  } | null;

  const name = typeof body?.clinic?.name === "string" ? body.clinic.name : "";
  const specialty =
    typeof body?.clinic?.specialty === "string" ? body.clinic.specialty : "";

  if (!name) {
    console.error("[healdesk] customer verification returned an unusable body");
    return { status: "unavailable" };
  }

  return { status: "found", clinic: { name, specialty } };
}

export async function POST(request: Request): Promise<NextResponse> {
  const ip = clientKey(request.headers);
  const limit = rateLimit(`reviews:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!limit.ok) {
    return NextResponse.json(
      { error: `That's a few attempts now. Email ${site.email} instead.` },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }

  // Checked before the body is read rather than after, so an oversized post is
  // refused instead of buffered.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return fail("That review is too large to send.", 413);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return fail("That review is too large to send.", 413);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("Invalid request body.", 400);
  }

  const input = (parsed ?? {}) as Record<string, unknown>;

  // Honeypot. Answered like a success so a bot has nothing to tune against.
  if (text(input.website, 200)) {
    console.info("[healdesk] review honeypot tripped", { ip });
    return NextResponse.json({ ok: true });
  }

  const name = text(input.name, MAX_NAME);
  const customerId = text(input.customerId, MAX_CUSTOMER_ID);
  const title = text(input.title, MAX_TITLE);
  const jobTitle = text(input.jobTitle, MAX_JOB_TITLE);
  const city = text(input.city, MAX_CITY);
  const stateCode = text(input.state, 2).toUpperCase();
  const body = text(input.body, MAX_REVIEW);
  const rating = Number(input.rating);

  if (!name) return fail("Tell us your name.", 400, "name");
  if (!customerId) return fail("Your customer ID is missing.", 400, "customerId");
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return fail("Pick a rating first.", 400, "rating");
  }
  // The town is optional and the job title is optional, but a card has to say
  // where the reviewer is, so the state is the one part of the location that
  // is required. "Other" in the town picker is what leaves just this.
  if (!isStateCode(stateCode)) {
    return fail("Pick your state.", 400, "state");
  }
  /*
   * The rating is required. The words are not, and there is no floor on them.
   *
   * Both halves of that are deliberate. A rating on its own is a real
   * submission rather than an abandoned one, which is why the homepage counts
   * ratings and written reviews separately. And a two-word review is a real
   * review: "Just excellent!" is what somebody between patients actually
   * types, one of the fifteen on the homepage says exactly that, and a form
   * that refuses on the way in what the page displays on the way out is a
   * form arguing with its own wall.
   */

  const photo = readPhoto(input.photo);
  if (!photo.ok) return fail(photo.reason, 400, "photo");

  const check = await checkCustomer(customerId);

  if (check.status === "unavailable") {
    return fail(
      `We can't check customer IDs at the moment. Email your review to ${site.email} and we'll post it.`,
      503,
    );
  }
  if (check.status === "unknown") {
    return fail(
      "We can't find that customer ID. Check it against your account, or email us and we'll look it up.",
      403,
      "customerId",
    );
  }

  console.info("[healdesk] review submitted", {
    clinic: check.clinic.name,
    rating,
    hasTitle: title.length > 0,
    hasPhoto: photo.jpeg !== null,
    ip,
    at: new Date().toISOString(),
  });

  const apiKey = process.env.RESEND_API_KEY;
  const sender = process.env.HEALDESK_EMAIL_FROM;
  if (!apiKey || !sender) {
    console.error(
      "[healdesk] review accepted but no transport is configured " +
        "(RESEND_API_KEY, HEALDESK_EMAIL_FROM)",
    );
    return fail(
      `Our form is down. Email your review to ${site.email} and we'll post it.`,
      503,
    );
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: sender,
        to: [site.email],
        subject: `Review (${rating}/5), ${check.clinic.name}`,
        text: [
          `Rating:   ${rating}/5`,
          `Title:    ${title || "(none)"}`,
          `From:     ${name}`,
          `Role:     ${jobTitle || "(none)"}`,
          `Place:    ${city ? `${city} ${stateCode}` : `${stateCode} (state only)`}`,
          `Clinic:   ${check.clinic.name}`,
          `Specialty:${check.clinic.specialty || " (none)"}`,
          `Customer: ${customerId}`,
          `Photo:    ${photo.jpeg ? "attached" : "none"}`,
          "",
          body || "(rating only, no review written)",
          "",
          "Read it before it goes on the site. See src/lib/reviews.ts.",
        ].join("\n"),
        attachments: photo.jpeg
          ? [{ filename: "portrait.jpg", content: photo.jpeg.toString("base64") }]
          : undefined,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error("[healdesk] resend rejected the review email", {
        status: response.status,
        detail: detail.slice(0, 500),
      });
      return fail(`We couldn't send that. Email ${site.email} instead.`, 502);
    }
  } catch (error) {
    console.error("[healdesk] review email threw", error);
    return fail(`We couldn't send that. Email ${site.email} instead.`, 502);
  }

  return NextResponse.json({ ok: true });
}
