import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { emailKey, isEmailConfigured, sendSafely } from "@/lib/email";
import { contactAck } from "@/lib/email/setup-emails";
import { isBusinessEmail, isValidEmail } from "@/lib/gate";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { replyByDate } from "@/lib/reply-by";
import { site } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/contact, the "want to know more" form.
 *
 * ## Why this sends mail instead of only logging
 *
 * /api/gate logs its lead and leaves a TODO, which is survivable because the
 * visitor is not waiting on anything: they got their demo. A contact form is
 * different. Someone typed a question and expects an answer, so a handler that
 * writes to stdout and returns "we'll be in touch" is a promise kept by nobody
 * the message sits in a log nobody greps until the prospect has gone
 * elsewhere.
 *
 * So: if a transport is configured, this sends. If it is not, it refuses and
 * points at the mailbox, rather than accepting a message it cannot deliver.
 * The form shows the address alongside itself for exactly that reason.
 *
 * Through lib/email's `send`, like every other message from this site, so it
 * carries the same tags and reply-to rules; the message carries no patient
 * information (a clinic operator's business enquiry), which is the condition
 * .env.example puts on using Resend at all.
 *
 * ## The acknowledgement (P8)
 *
 * The sender gets one email naming the day we reply by, because a form that
 * answers "thanks" and then goes quiet reads as a form nobody reads. Their
 * address is unverified, so the acknowledgement echoes nothing they typed but
 * that address, and goes at most once a day per address (per instance, on
 * top of the per-IP limit above): the form must not be a way to mail a
 * stranger.
 */

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000;

const MAX_NAME = 120;
const MAX_CLINIC = 160;
const MAX_MESSAGE = 4_000;

function fail(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export async function POST(request: Request): Promise<NextResponse> {
  const ip = clientKey(request.headers);
  const limit = await rateLimit(`contact:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!limit.ok) {
    return NextResponse.json(
      { error: `You've sent a few already. Email ${site.email} directly.` },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("Invalid request body.", 400);
  }

  const raw = (body ?? {}) as Record<string, unknown>;

  // Honeypot. A field positioned off-screen and hidden from assistive tech, so
  // a person never sees it and a naive bot fills it. Answered like a success so
  // the bot has nothing to tune against.
  if (text(raw.website, 200)) {
    console.info("[healdesk] contact honeypot tripped", { ip });
    return NextResponse.json({ ok: true });
  }

  const name = text(raw.name, MAX_NAME);
  const clinic = text(raw.clinic, MAX_CLINIC);
  const message = text(raw.message, MAX_MESSAGE);
  const email = raw.email;

  if (!name) return fail("Tell us your name.", 400);
  if (!isValidEmail(email)) return fail("Enter a valid email address.", 400);
  if (message.length < 5) return fail("Add a line about what you need.", 400);

  const from = email.trim().toLowerCase();

  console.info("[healdesk] contact form", {
    name,
    clinic: clinic || undefined,
    email: from,
    business: isBusinessEmail(from),
    ip,
    at: new Date().toISOString(),
  });

  if (!isEmailConfigured()) {
    console.error(
      "[healdesk] contact form received but no transport is configured " +
        "(RESEND_API_KEY, HEALDESK_EMAIL_FROM)",
    );
    return fail(`Our form is down, email us at ${site.email} and we'll reply.`, 503);
  }

  // The form keeps no row, so the submission's own digest stands for one in
  // the email keys (lib/email emailKey): a double submit sends each email once.
  const submission = createHash("sha256")
    .update(JSON.stringify([from, name, clinic, message]))
    .digest("hex")
    .slice(0, 32);

  const toUs = await sendSafely({
    to: site.email,
    // Replying goes to the prospect rather than to our own From address.
    replyTo: from,
    subject: `Website enquiry, ${name}${clinic ? ` (${clinic})` : ""}`,
    text: [`Name:   ${name}`, `Clinic: ${clinic || "(none)"}`, `Email:  ${from}`, "", message].join("\n"),
    tag: "contact",
    idempotencyKey: emailKey("contact", submission),
  });
  if (toUs.status === "failed") {
    console.error("[healdesk] the contact email did not send", { reason: toUs.reason.slice(0, 500) });
    return fail(`We couldn't send that. Email ${site.email} instead.`, 502);
  }

  const replyBy = replyByDate();
  const addressKey = createHash("sha256").update(from).digest("hex").slice(0, 32);
  const firstToday = await rateLimit(`contact-ack:${addressKey}`, 1, 24 * 60 * 60 * 1000);
  if (firstToday.ok) {
    const ack = contactAck(from, replyBy);
    const sent = await sendSafely({
      to: from,
      subject: ack.subject,
      text: ack.text,
      tag: "contact-ack",
      idempotencyKey: emailKey("contact-ack", submission),
    });
    if (sent.status === "failed") {
      // We have their message; the acknowledgement is a courtesy.
      console.error("[healdesk] the contact acknowledgement did not send", { reason: sent.reason.slice(0, 200) });
    }
  }

  return NextResponse.json({ ok: true, replyBy });
}
