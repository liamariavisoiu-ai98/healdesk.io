import { NextResponse } from "next/server";

import { recordDemoCallback } from "@/lib/demo/callbacks";
import { DEMO_PAGE_CALLBACK_CONSENT, usMobileE164 } from "@/lib/demo/v2/callback";
import { demoOfferEndsAt, demoUrl, displayName, getDemoSession, isDemoSlug } from "@/lib/demo/sessions";
import { emailKey, isEmailConfigured, sendSafely } from "@/lib/email";
import { demoCallbackInternal } from "@/lib/email/voice-follow-up";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { site } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/demo/[slug]/callback, the owner's demo page's "Questions first?
 * Our team will call you" form (lib/demo/v2, its note: "POST {phone,
 * demo_slug, source} to the server, which alerts the team instantly").
 *
 * The same queue as the call back Aya offers on a demo call
 * (api/voice-demo/callback-request): a row in the marketing Sheet's
 * `demo_callbacks` tab for Queues › Demo call backs, the words on the form
 * kept in the call-consent tab as what they said yes to, the lead's
 * `callback_requested` event, and an email to hello@. Business contact data
 * only: a clinic owner's own number for their business.
 *
 * The page says "Got it" only on a 2xx, so a 2xx means kept and in hello@'s
 * inbox; anything less and the page asks them to email hello@ instead.
 */

/** Per demo per hour, as the call's own: a corrected number is a second request, a fourth is a loop. */
const PER_DEMO_LIMIT = 3;
/** Per visitor per hour, across demos. */
const PER_CLIENT_LIMIT = 5;
const HOUR_MS = 60 * 60 * 1000;
/** All demos per day, shared with nothing: a stop on a runaway. */
const DAILY_LIMIT = 40;
const DAY_MS = 24 * HOUR_MS;

function problem(message: string, status: number): NextResponse {
  return NextResponse.json({ ok: false, message }, { status });
}

export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  const { slug } = await ctx.params;
  if (!isDemoSlug(slug)) return problem("No such demo.", 404);

  let body: { phone?: unknown } | null;
  try {
    body = (await request.json()) as { phone?: unknown } | null;
  } catch {
    return problem("The request was malformed.", 400);
  }
  const phoneE164 = usMobileE164(body?.phone);
  if (!phoneE164) return problem("Enter a 10-digit US mobile number.", 422);

  const perClient = await rateLimit(`demo-page-callback:client:${clientKey(request.headers)}`, PER_CLIENT_LIMIT, HOUR_MS);
  const perDemo = perClient.ok ? await rateLimit(`demo-page-callback:demo:${slug}`, PER_DEMO_LIMIT, HOUR_MS) : perClient;
  const daily = perDemo.ok ? await rateLimit("demo-page-callback:day", DAILY_LIMIT, DAY_MS) : perDemo;
  if (!daily.ok) return problem("Too many call backs.", 429);

  if (!isEmailConfigured()) {
    console.error("[healdesk] demo page call back has no email transport (RESEND_API_KEY, HEALDESK_EMAIL_FROM)");
    return problem("Call backs are unavailable.", 503);
  }

  const demo = await getDemoSession(slug).catch(() => null);
  if (!demo) return problem("No such demo.", 404);
  const offerEndsAt = demoOfferEndsAt(demo);

  const kept = await recordDemoCallback({
    slug,
    clinicName: displayName(demo),
    firstName: "",
    phoneE164,
    topic: "",
    test: false,
    offerEndsAt,
    leadEmail: demo.leadEmail ?? null,
    consent: DEMO_PAGE_CALLBACK_CONSENT,
  });
  if (!kept.ok) return problem("Call backs are unavailable.", 503);

  const email = demoCallbackInternal({
    clinicName: kept.callback.clinicName,
    firstName: "",
    phoneE164,
    topic: kept.callback.topic,
    test: false,
    offerEndsAt,
    demoUrl: demoUrl(slug),
    leadEmail: demo.leadEmail ?? null,
  });
  const sent = await sendSafely({
    to: site.email,
    subject: email.subject,
    text: email.text,
    tag: "demo-callback",
    idempotencyKey: emailKey("demo-callback", kept.callback.id),
  });
  if (sent.status !== "sent") {
    console.error("[healdesk] demo page call back kept but hello@ was not emailed", { status: sent.status });
    return problem("Not sent.", 502);
  }
  return NextResponse.json({ ok: true, repeat: kept.repeat });
}
