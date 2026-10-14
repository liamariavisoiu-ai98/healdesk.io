import { NextResponse } from "next/server";

import { checkoutMode } from "@/lib/checkout-mode";
import { emailKey, sendSafely } from "@/lib/email";
import { setupRequestAck, setupRequestInternal } from "@/lib/email/setup-emails";
import { isValidEmail } from "@/lib/gate";
import { cohortCreditLive, findLeadById } from "@/lib/leads";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { replyByDate } from "@/lib/reply-by";
import { CHANNEL_IDS, cleanWebsite, createSetupRequest, type ChannelId } from "@/lib/setup-requests";
import { site } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/setup-request: "Tell us about your clinic".
 *
 * While the purchase is by invitation (lib/checkout-mode.ts), this is what
 * "Get AYA" opens. The request lands in the marketing Sheet's
 * `setup_requests` tab, hello@ gets it with the requester as reply-to (P3),
 * and the requester gets one acknowledgement naming the day we reply by (P2).
 *
 * The acknowledgement goes to an address nobody has verified, so the usual
 * defences against using the form to mail a stranger apply: a per-IP limit,
 * a honeypot, at most one acknowledgement per address per day, and nothing
 * in it the person typed but the address it goes to.
 *
 * ## Only while the purchase is by invitation
 *
 * The mode is enforced here as on the purchase routes (plan Part A2). In
 * public mode anyone may buy, so a request would promise a reply with a setup
 * link nobody needs, and would put the person on a queue instead of the
 * purchase: it is refused, saved nowhere and mailed to nobody, with the
 * purchase's address, and `mode: "public"` so the form can say where to go.
 */

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000;

const MAX_NAME = 120;
const MAX_CLINIC = 160;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function fail(message: string, status: number, field?: string): NextResponse {
  return NextResponse.json({ error: message, ...(field ? { field } : {}) }, { status });
}

export async function POST(request: Request): Promise<NextResponse> {
  if (checkoutMode() === "public") {
    return NextResponse.json(
      { error: `Purchases are open. Start at ${site.url}/get-started.`, mode: "public" },
      { status: 409 },
    );
  }

  const ip = clientKey(request.headers);
  const limit = await rateLimit(`setup-request:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!limit.ok) {
    return NextResponse.json(
      { error: `You've sent a few already. Email ${site.email} and we'll take it from there.` },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = ((await request.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return fail("Invalid request body.", 400);
  }

  // Honeypot: a field no person sees. Answered like a success so a bot has
  // nothing to tune against.
  if (text(body.middleName, 200)) {
    console.info("[healdesk] setup request honeypot tripped", { ip });
    return NextResponse.json({ ok: true, replyBy: replyByDate() });
  }

  const name = text(body.name, MAX_NAME);
  const clinicName = text(body.clinicName, MAX_CLINIC);
  const noWebsite = body.noWebsite === true;
  const website = noWebsite ? null : cleanWebsite(body.website);
  const email = body.email;
  const channels = Array.isArray(body.channels)
    ? [...new Set(body.channels.filter((c): c is ChannelId => (CHANNEL_IDS as readonly unknown[]).includes(c)))]
    : [];

  if (!name) return fail("Tell us your name.", 400, "name");
  if (clinicName.length < 2) return fail("Tell us the clinic's name.", 400, "clinicName");
  if (!noWebsite && !website) {
    return fail("Enter the clinic's website, or tick that you don't have one.", 400, "website");
  }
  if (!isValidEmail(email)) return fail("Enter a valid email address.", 400, "email");
  if (channels.length === 0) return fail("Pick at least one channel.", 400, "channels");

  // The Day 7 email's link carries the lead id. It counts only if it names a
  // real lead, and only that lead's own row decides whether the credit holds.
  const lead = typeof body.leadId === "string" && body.leadId ? await findLeadById(body.leadId) : null;

  const created = await createSetupRequest({
    name,
    clinicName,
    website,
    email,
    channels,
    leadId: lead?.id ?? null,
    ipAddress: ip,
  });

  const replyBy = replyByDate();

  if (!created.ok) {
    if (created.reason === "unconfigured" && process.env.NODE_ENV !== "production") {
      console.info("[healdesk] setup request (no lead store configured; not saved)", { clinicName });
      return NextResponse.json({ ok: true, replyBy });
    }
    return fail(`Our form is down. Email ${site.email} and we'll reply by ${replyBy}.`, 503);
  }

  const { request: saved, repeat } = created;

  const internal = setupRequestInternal(saved, { creditLive: lead ? cohortCreditLive(lead) : false });
  const toUs = await sendSafely({
    to: site.email,
    replyTo: saved.email,
    subject: internal.subject,
    text: internal.text,
    tag: "setup-request",
    idempotencyKey: emailKey("setup-request", saved.id),
  });
  if (toUs.status === "failed") {
    // The row is saved, so nothing is lost; the daily review of /admin/setup catches it.
    console.error("[healdesk] setup request saved but the email to us failed", { id: saved.id, reason: toUs.reason });
  }

  if (!repeat) {
    const ack = setupRequestAck(saved, replyBy);
    await sendSafely({
      to: saved.email,
      subject: ack.subject,
      text: ack.text,
      tag: "setup-ack",
      idempotencyKey: emailKey("setup-ack", saved.id),
    });
  }

  return NextResponse.json({ ok: true, replyBy });
}
