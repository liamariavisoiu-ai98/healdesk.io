import { NextResponse } from "next/server";

import { isBusinessEmail, isValidEmail } from "@/lib/gate";
import { clientKey, rateLimit } from "@/lib/rate-limit";
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
 * Resend by direct fetch rather than a client library, one POST does not
 * justify a dependency in the marketing app, and the message carries no patient
 * information (a clinic operator's business enquiry), which is the condition
 * .env.example puts on using Resend at all.
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

  const apiKey = process.env.RESEND_API_KEY;
  const sender = process.env.HEALDESK_EMAIL_FROM;
  if (!apiKey || !sender) {
    console.error(
      "[healdesk] contact form received but no transport is configured " +
        "(RESEND_API_KEY, HEALDESK_EMAIL_FROM)",
    );
    return fail(`Our form is down, email us at ${site.email} and we'll reply.`, 503);
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
        // Replying goes to the prospect rather than to our own From address.
        reply_to: from,
        subject: `Website enquiry, ${name}${clinic ? ` (${clinic})` : ""}`,
        text: [
          `Name:   ${name}`,
          `Clinic: ${clinic || "(none)"}`,
          `Email:  ${from}`,
          "",
          message,
        ].join("\n"),
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error("[healdesk] resend rejected the contact email", {
        status: response.status,
        detail: detail.slice(0, 500),
      });
      return fail(`We couldn't send that. Email ${site.email} instead.`, 502);
    }
  } catch (error) {
    console.error("[healdesk] contact email threw", error);
    return fail(`We couldn't send that. Email ${site.email} instead.`, 502);
  }

  return NextResponse.json({ ok: true });
}
