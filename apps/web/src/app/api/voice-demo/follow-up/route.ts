import { createHash } from "node:crypto";

import { allPlans, type Plan, PACKAGES } from "@healdesk/catalog";
import { NextResponse } from "next/server";

import { checkoutMode } from "@/lib/checkout-mode";
import { emailKey, isEmailConfigured, sendSafely, unsubscribeUrl } from "@/lib/email";
import {
  voiceFollowUpInternal,
  voiceSetupLinkEmail,
  voiceSetupLinkSaid,
  type VoiceSetupLink,
} from "@/lib/email/voice-follow-up";
import { isValidEmail } from "@/lib/gate";
import { canEmail, leadForCommercialEmail } from "@/lib/leads";
import { rateLimit } from "@/lib/rate-limit";
import { verifyRetellSignature } from "@/lib/retell-signature";
import { site } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/voice-demo/follow-up, the demo call's one way to reach a person.
 *
 * AYA's demo calls (lib/voice-demo-prompt.ts) call this as a Retell custom
 * tool when the clinic owner on the line agrees to be emailed. Two kinds:
 *
 *   - topic "start": they said yes in the close. They are emailed the link to
 *     set up the package AYA recommended, which is the close itself, and the
 *     team is emailed the same summary. While the purchase is by invitation
 *     (lib/checkout-mode.ts), the link is to "Tell us about your clinic",
 *     and the email says so: only a setup link minted in /admin opens the
 *     purchase then (plan A2), so a link that claimed to would not.
 *   - anything else (pricing, terms, a session with the team): the request
 *     goes to the team inbox, and the team replies.
 *
 * Both go through this site's email platform (lib/email `send()`, since 19
 * October 2026; until then a fetch of its own), so each carries an
 * idempotency key, the `app` and `kind` tags and its HTML twin, and its
 * answer feeds the day's email count. No list and no automated sequence:
 * one message to them, at their request, and only the one they agreed to on
 * the call. The owner's email is commercial (P4's equivalent, Annex X1.10),
 * so it carries a one-click opt-out, kept on the address's lead row
 * (leadForCommercialEmail): an address that opted out or bounced is never
 * mailed, and with no row to keep the opt-out on, nothing is sent.
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

/**
 * Bounds the day's mail, not a person: each "start" is two emails, and
 * Resend's free plan stops every email at 100 a day, sign-in links and urgent
 * alerts included. Shared across instances (lib/rate-limit.ts). Demo calls
 * are capped upstream too.
 */
const DAILY_LIMIT = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

const TOPICS = new Set(["start", "pricing", "discount", "terms", "sales_session", "other"]);

/** Every plan by its name, lower-cased, built once: "aya voice, 500 minutes". */
let plansByName: Map<string, Plan> | null = null;

/**
 * The setup link for what AYA named, by its catalog name; the buy flow with
 * nothing chosen when she named nothing or something that does not exist, so
 * the email never links to a plan the owner did not hear. (That fallback was
 * /pricing until the owner disabled the page on 9 October 2026; the buy
 * flow's first step shows every package and its price.)
 *
 * Since 13 October 2026 her price list names packages and the clinic picks a
 * step for each product (lib/voice-demo-prompt.ts), so the name is usually a
 * package's: "AYA Voice + Meta Chat" links to `?plan=voice-metachat`, which
 * checkout opens at the default steps (lib/pricing.ts `checkoutStart`). If she
 * named a plan in full, "AYA Voice, 500 minutes", the link carries that plan.
 * In pilot mode the same address shows "Tell us about your clinic" until a
 * setup link opens the purchase.
 */
function setupLink(packageName: string): VoiceSetupLink {
  const wanted = packageName.toLowerCase();
  plansByName ??= new Map(allPlans().map((p) => [p.name.toLowerCase(), p]));
  const plan = plansByName.get(wanted);
  if (plan) return { url: `${site.url}/get-started?plan=${plan.id}`, plan: plan.name };
  const pkg = PACKAGES.find((p) => p.name.toLowerCase() === wanted);
  return pkg
    ? { url: `${site.url}/get-started?plan=${pkg.id}`, plan: pkg.name }
    : { url: `${site.url}/get-started`, plan: null };
}

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

  if (!isEmailConfigured()) {
    console.error("[healdesk] voice follow-up has no transport (RESEND_API_KEY, HEALDESK_EMAIL_FROM)");
    return reply(false, `Not sent. Give them ${site.email} instead.`, 503);
  }

  const mode = checkoutMode();
  const practice = text(body.call?.retell_llm_dynamic_variables?.practice_type, 80);
  const link = setupLink(recommended);
  // The request keeps no row of its own, so its digest stands for one in the
  // email keys (X1.4), as the contact form's does: the call, the address and
  // the topic, so a retried tool call sends once and a corrected address is a
  // new email. Never the address itself.
  const requestKey = createHash("sha256").update(JSON.stringify([callId, email, topic])).digest("hex").slice(0, 32);

  // The owner's own email first: on "start" it is the promise AYA makes, so
  // it must have gone before she is told it did.
  if (topic === "start") {
    const lead = await leadForCommercialEmail(email, "voice_follow_up");
    if (!lead) return reply(false, `Not sent. Give them ${site.email} instead.`, 503);
    const may = canEmail(lead, "relationship");
    if (!may.ok) {
      return reply(false, `Not sent: this address has asked us not to email it. Give them ${site.email} instead.`, 409);
    }
    const optOut = unsubscribeUrl(lead.id);
    const theirs = voiceSetupLinkEmail({ name, clinic, link, mode, unsubscribeUrl: optOut });
    const sentToThem = await sendSafely({
      to: email,
      subject: theirs.subject,
      text: theirs.text,
      unsubscribeUrl: optOut,
      tag: "voice-setup-link",
      idempotencyKey: emailKey("voice-setup-link", requestKey),
    });
    if (sentToThem.status !== "sent") {
      console.error("[healdesk] voice follow-up not sent to the owner", {
        callId,
        status: sentToThem.status,
        reason: sentToThem.reason.slice(0, 300),
      });
      return reply(false, `Not sent. Give them ${site.email} instead.`, 502);
    }
  }

  const ours = voiceFollowUpInternal(
    { topic, name, clinic, practice, email, preferredTime, recommended, notes, summary, callId },
    topic === "start" ? { link, mode } : null,
  );
  const sentToTeam = await sendSafely({
    to: site.email,
    replyTo: email,
    subject: ours.subject,
    text: ours.text,
    tag: "voice-follow-up",
    idempotencyKey: emailKey("voice-follow-up", requestKey),
  });

  if (topic === "start") {
    // Their link is already in their inbox; a lost copy to us is ours to
    // chase, not a reason to tell them it failed.
    if (sentToTeam.status !== "sent") console.error("[healdesk] setup link sent but the team copy failed", { callId });
    console.info("[healdesk] voice follow-up sent", { callId, topic });
    return reply(true, voiceSetupLinkSaid(link, mode));
  }
  if (sentToTeam.status !== "sent") {
    console.error("[healdesk] voice follow-up not sent to the team", { callId, status: sentToTeam.status });
    return reply(false, `Not sent. Give them ${site.email} instead.`, 502);
  }

  console.info("[healdesk] voice follow-up sent", {
    callId,
    topic,
  });
  return reply(true, "Sent to the team. You can tell them the team will email them.");
}
