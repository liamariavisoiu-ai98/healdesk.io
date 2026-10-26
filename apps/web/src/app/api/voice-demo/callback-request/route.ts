import { demoFirstName, isSafeTypedText, SIGNATURE_HEADER, TIMESTAMP_HEADER, verify } from "@healdesk/catalog";
import { NextResponse } from "next/server";

import { demoUrl, getDemoSession, isDemoSlug } from "@/lib/demo/sessions";
import { recordDemoCallback } from "@/lib/demo/callbacks";
import { emailKey, isEmailConfigured, sendSafely } from "@/lib/email";
import { demoCallbackInternal } from "@/lib/email/voice-follow-up";
import { rateLimit } from "@/lib/rate-limit";
import { site } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/voice-demo/callback-request: a call back a clinic owner asked
 * for on a demo call (owner, 26 October 2026: "Lead capture yes do it";
 * docs/design/demo-lead-capture-2026-10-25.md).
 *
 * ## Who calls it
 *
 * Only apps/app's demo call (lib/voice/demo-callback.ts there), signed with
 * HEALDESK_PROVISION_SECRET like every server-to-server call between the two
 * apps (catalog request-signing.ts). Aya offers a call to a hesitant owner,
 * reads the number back and asks what the team should come prepared with;
 * her structured state carries the number and that line, never her prose.
 *
 * ## What it does
 *
 * Keeps the request in the marketing Sheet's `demo_callbacks` tab, the team's
 * queue in /admin (lib/demo/callbacks.ts), records the words the owner said
 * yes to in the call-consent tab, adds a `callback_requested` event to the
 * demo's lead, and emails hello@. Business contact data only: a clinic
 * owner's own number for their business, never a patient's, which is why it
 * lives here, on the side with no PHI.
 *
 * ## What Aya may say depends on this reply
 *
 * The caller hears that someone will call only on a 2xx, so a 2xx means the
 * request is both kept and in hello@'s inbox; anything less is a failure she
 * answers with hello at healdesk dot io (apps/app, CALLBACK_FAILED_LINE). A
 * repeat of a request already kept (the same number on the same demo within
 * the hour) is not kept twice.
 */

const MAX = { clinicName: 160, topic: 160 } as const;
const E164 = /^\+[1-9]\d{7,14}$/;

/** Per demo per hour: a corrected number is a second request, a fourth is a loop. */
const PER_DEMO_LIMIT = 3;
const HOUR_MS = 60 * 60 * 1000;
/** All demos per day: far above the call backs a day of demos brings, and a stop on a runaway. */
const DAILY_LIMIT = 40;
const DAY_MS = 24 * HOUR_MS;

function problem(message: string, status: number): NextResponse {
  return NextResponse.json({ ok: false, message }, { status });
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export async function POST(request: Request): Promise<NextResponse> {
  const secret = process.env.HEALDESK_PROVISION_SECRET;
  if (!secret) {
    console.error("[healdesk] HEALDESK_PROVISION_SECRET is not set; refusing a demo call back");
    return problem("Call backs are unavailable.", 503);
  }
  const raw = await request.text();
  const verification = verify(raw, request.headers.get(TIMESTAMP_HEADER), request.headers.get(SIGNATURE_HEADER), secret);
  if (!verification.ok) {
    console.warn("[healdesk] demo call back rejected", { reason: verification.reason });
    return problem("Unauthorized.", 401);
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return problem("The request was malformed.", 400);
  }

  const slug = isDemoSlug(body.slug) ? body.slug : null;
  const phoneE164 = typeof body.phoneE164 === "string" && E164.test(body.phoneE164) ? body.phoneE164 : null;
  if (!slug || !phoneE164) return problem("A call back needs the demo and a number in E.164.", 422);
  // The clinic's name and the topic as heard, printed in our own email only
  // when they read as words, never as a link or markup (isSafeTypedText).
  const clinicName = text(body.clinicName, MAX.clinicName);
  const topic = text(body.topic, MAX.topic);
  const firstName = demoFirstName(body.firstName) ?? "";
  const test = body.test === true;
  const offerEndsAt = typeof body.offerEndsAt === "number" && Number.isFinite(body.offerEndsAt) ? new Date(body.offerEndsAt) : null;

  const perDemo = await rateLimit(`demo-callback:demo:${slug}`, PER_DEMO_LIMIT, HOUR_MS);
  const daily = perDemo.ok ? await rateLimit("demo-callback:day", DAILY_LIMIT, DAY_MS) : perDemo;
  if (!perDemo.ok || !daily.ok) return problem("Too many call backs.", 429);

  if (!isEmailConfigured()) {
    console.error("[healdesk] demo call back has no email transport (RESEND_API_KEY, HEALDESK_EMAIL_FROM)");
    return problem("Call backs are unavailable.", 503);
  }

  const demo = await getDemoSession(slug).catch(() => null);
  if (!demo) return problem("No such demo.", 404);

  const kept = await recordDemoCallback({
    slug,
    clinicName: isSafeTypedText(clinicName, MAX.clinicName) ? clinicName : demo.clinicName,
    firstName,
    phoneE164,
    topic: isSafeTypedText(topic, MAX.topic) ? topic : "",
    test,
    offerEndsAt,
    leadEmail: demo.leadEmail ?? null,
  });
  if (!kept.ok) return problem("Call backs are unavailable.", 503);

  const email = demoCallbackInternal({
    clinicName: kept.callback.clinicName,
    firstName,
    phoneE164,
    topic: kept.callback.topic,
    test,
    offerEndsAt,
    demoUrl: demoUrl(slug),
    leadEmail: demo.leadEmail ?? null,
  });
  // The row's own id stands for the request in the key, never the number,
  // so a repeat of a kept request sends once more only if the first email
  // did not go (Resend sends a key once a day).
  const sent = await sendSafely({
    to: site.email,
    subject: email.subject,
    text: email.text,
    tag: "demo-callback",
    idempotencyKey: emailKey("demo-callback", kept.callback.id),
  });
  if (sent.status !== "sent") {
    // Kept and in the queue, but nobody was told: Aya must not say anyone will call.
    console.error("[healdesk] demo call back kept but hello@ was not emailed", { status: sent.status });
    return problem("Not sent.", 502);
  }
  console.info("[healdesk] demo call back taken", { test, repeat: kept.repeat });
  return NextResponse.json({ ok: true, repeat: kept.repeat });
}
