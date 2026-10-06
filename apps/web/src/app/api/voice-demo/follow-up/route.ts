import { NextResponse } from "next/server";

import { isValidEmail } from "@/lib/gate";
import { rateLimit } from "@/lib/rate-limit";
import { verifyRetellSignature } from "@/lib/retell-signature";
import { site } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/voice-demo/follow-up, the demo call's one way to reach a person.
 *
 * AYA's demo call (lib/voice-demo-prompt.ts) calls this as a Retell custom
 * tool when the clinic owner on the line asks about pricing, a discount or
 * terms, or wants a session with sales, and agrees to be contacted. It
 * emails the request to the team inbox, the same transport the contact form
 * uses, and nothing else: no lead row, no list, no automated sequence.
 *
 * Business contact data only. The person on this call is a clinic owner
 * talking about their own business, which is why it can live in apps/web.
 * Nothing here is ever a patient's.
 *
 * ## What the agent may promise depends on this reply
 *
 * The prompt tells AYA to say the team will be in touch only when this route
 * returns ok, and to give the team's address instead when it does not. So
 * every failure below returns a non-2xx with a plain sentence the model can
 * act on, never a vendor error, which could name our account.
 *
 * ## Only Retell can call it
 *
 * Every request must carry a valid X-Retell-Signature over its raw body,
 * keyed with RETELL_WEBHOOK_KEY (the Retell API key with the webhook badge).
 * The route mails a stranger's words to our inbox, so unsigned is refused.
 */

const MAX = { name: 120, clinic: 160, topic: 40, preferredTime: 120, notes: 600, summary: 900, pkg: 60 } as const;

/** Per call: a corrected email is a second request, a third is a loop. */
const PER_CALL_LIMIT = 3;
const PER_CALL_WINDOW_MS = 60 * 60 * 1000;

/** Bounds the inbox, not a person. Demo calls are capped upstream too. */
const DAILY_LIMIT = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

const TOPICS = new Set(["pricing", "discount", "terms", "sales_session", "other"]);

type ToolCall = {
  args?: Record<string, unknown>;
  call?: {
    call_id?: unknown;
    call_type?: unknown;
    retell_llm_dynamic_variables?: Record<string, unknown>;
  };
};

function reply(ok: boolean, message: string, status = ok ? 200 : 400): NextResponse {
  return NextResponse.json({ ok, message }, { status });
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export async function POST(request: Request): Promise<NextResponse> {
  const key = process.env.RETELL_WEBHOOK_KEY;
  if (!key) {
    console.error("[healdesk] voice follow-up called but RETELL_WEBHOOK_KEY is unset");
    return reply(false, `Not sent. Give them ${site.email} instead.`, 503);
  }

  const raw = await request.text();
  if (!verifyRetellSignature(raw, request.headers.get("x-retell-signature"), key)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: ToolCall;
  try {
    body = JSON.parse(raw) as ToolCall;
  } catch {
    return reply(false, "Not sent: the request was malformed.");
  }

  const args = body.args ?? {};
  const callId = text(body.call?.call_id, 80) || "unknown";
  const name = text(args.name, MAX.name);
  const clinic = text(args.clinic, MAX.clinic);
  const topic = TOPICS.has(text(args.topic, MAX.topic)) ? text(args.topic, MAX.topic) : "other";
  const preferredTime = text(args.preferred_time, MAX.preferredTime);
  const notes = text(args.notes, MAX.notes);
  // What discovery found, so the team's first message does not ask again.
  const summary = text(args.summary, MAX.summary);
  const recommended = text(args.recommended_package, MAX.pkg);
  const emailRaw = text(args.email, 254).toLowerCase();
  const email = emailRaw && isValidEmail(emailRaw) ? emailRaw : "";

  // Email only. The number AYA dialled was given "for the demo call only"
  // (lib/consent.ts), so the team never rings it, and it is not passed on.
  if (emailRaw && !email) {
    return reply(false, "That email doesn't look complete. Read it back and ask them to spell it again.");
  }
  if (!email) {
    return reply(false, "Not sent: there is no email. Ask for one, and have them spell it.");
  }

  const perCall = await rateLimit(`voice-followup:call:${callId}`, PER_CALL_LIMIT, PER_CALL_WINDOW_MS);
  const daily = perCall.ok ? await rateLimit("voice-followup:day", DAILY_LIMIT, DAY_MS) : perCall;
  if (!perCall.ok || !daily.ok) {
    return reply(false, `Already sent for this call. If something changed, give them ${site.email}.`, 429);
  }

  const apiKey = process.env.RESEND_API_KEY;
  const sender = process.env.HEALDESK_EMAIL_FROM;
  if (!apiKey || !sender) {
    console.error("[healdesk] voice follow-up has no transport (RESEND_API_KEY, HEALDESK_EMAIL_FROM)");
    return reply(false, `Not sent. Give them ${site.email} instead.`, 503);
  }

  const practice = text(body.call?.retell_llm_dynamic_variables?.practice_type, 80);
  const subject =
    topic === "sales_session"
      ? `Demo call: session with sales, ${name || "unnamed"}${clinic ? ` (${clinic})` : ""}`
      : `Demo call: ${topic} question, ${name || "unnamed"}${clinic ? ` (${clinic})` : ""}`;

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: sender,
        to: [site.email],
        reply_to: email,
        subject,
        text: [
          `Asked about:   ${topic.replace("_", " ")}`,
          `Name:          ${name || "(not given)"}`,
          `Clinic:        ${clinic || "(not given)"}`,
          `Practice type: ${practice || "(not given)"}`,
          `Email:         ${email}`,
          `Good time:     ${preferredTime || "(not given)"}, in their words, time zone unconfirmed`,
          `Recommended:   ${recommended || "(none)"}`,
          "",
          `What they want: ${notes || "(not given)"}`,
          "",
          `What they told AYA: ${summary || "(no summary)"}`,
          "",
          `They asked for this on AYA's demo call ${callId}. Nothing has been sent to them;`,
          "the first message is ours to send, by email. They agreed to be contacted about this request only.",
          "Do not phone the number the demo called: it was given for the demo call only.",
        ].join("\n"),
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error("[healdesk] resend rejected the voice follow-up", {
        status: response.status,
        detail: detail.slice(0, 400),
      });
      return reply(false, `Not sent. Give them ${site.email} instead.`, 502);
    }
  } catch (error) {
    console.error("[healdesk] voice follow-up email threw", error);
    return reply(false, `Not sent. Give them ${site.email} instead.`, 502);
  }

  console.info("[healdesk] voice follow-up sent", {
    callId,
    topic,
  });
  return reply(true, "Sent to the team. You can tell them the team will be in touch.");
}
