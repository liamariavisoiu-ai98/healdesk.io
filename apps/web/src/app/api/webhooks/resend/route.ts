import { createHmac, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { relayEmailEvent, relayWebEmailEvent, type EmailEventRelay } from "@/lib/admin/ops-client";
import { markDeliveryFailure } from "@/lib/leads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Resend's delivery webhook: bounces and complaints come back here and
 * become a flag on the lead, before the next send rather than after.
 *
 * Resend signs with Svix: `svix-id`, `svix-timestamp` and `svix-signature`
 * headers (Resend's "Verify webhook requests"), HMAC-SHA256 over
 * `${id}.${timestamp}.${body}` with the base64 secret after the `whsec_`
 * prefix, compared to any of the space-separated `v1,<base64>` values.
 * Verified here without the svix package — it is thirty lines and one fewer
 * dependency on the marketing site. Five-minute tolerance on the timestamp.
 *
 * This read only the unbranded `webhook-*` names until 6 October 2026.
 * Resend's documentation names only the branded ones, so a delivery carrying
 * just those could never verify, and its bounce or complaint never reached
 * the lead. Both spellings are accepted now, the branded one first.
 *
 * ## One webhook, two apps
 *
 * The one Resend account sends both this site's mail and apps/app's, and
 * Resend's free plan documents one webhook endpoint, so every event arrives
 * here (Annex X3 of docs/design/funnel-onboarding-portal-2026-10-06.md). Each
 * app tags its own mail with `app`. An `app=web` event, or one with no tag
 * (mail sent before the tags existed), is this site's and is handled below as
 * it always was. An `app=app` event is relayed to apps/app as the signed ops
 * operation `emailEvent`, carrying its type, its timestamp and the tags
 * apps/app put on it (a clinic id, a ledger row id, a kind), and nothing
 * else: never the address, the subject or anything else in Resend's payload.
 * If apps/app cannot be reached the answer is a 503, so Resend retries the
 * delivery rather than the event being lost.
 *
 * ## This site's own mail is counted there too (19 October 2026)
 *
 * The ops digest's email health and its bounce and complaint rates are read
 * in apps/app, which never sends this site's mail, so they left out nurture,
 * the setup links and P2 to P9, the stream most likely to draw a complaint,
 * while Resend pauses the whole account at 0.08%. After its own lead handling,
 * this route hands apps/app each sent, bounced, complained or suppressed event
 * about this site's mail (relayWebEmailEvent): the type, the time, the kind
 * tag and the webhook delivery's id, nothing else. Best effort: the lead is
 * already marked, so an apps/app that cannot be reached (the host in standby)
 * costs one count, not a retried delivery.
 */
const TOLERANCE_S = 5 * 60;

export function verifySvix(
  headers: Headers,
  body: string,
  secret: string,
  now: number = Date.now(),
): boolean {
  const id = headers.get("svix-id") ?? headers.get("webhook-id");
  const timestamp = headers.get("svix-timestamp") ?? headers.get("webhook-timestamp");
  const signature = headers.get("svix-signature") ?? headers.get("webhook-signature");
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > TOLERANCE_S) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  for (const part of signature.split(" ")) {
    const [version, value] = part.split(",");
    if (version !== "v1" || !value) continue;
    const a = Buffer.from(value);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

export async function POST(request: Request): Promise<NextResponse> {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "Webhook not configured." }, { status: 503 });

  const body = await request.text();
  if (!verifySvix(request.headers, body, secret)) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  let event: ResendEvent;
  try {
    event = JSON.parse(body) as typeof event;
  } catch {
    return NextResponse.json({ error: "Invalid body." }, { status: 400 });
  }

  const tags = tagsOf(event);
  if (tags.app === "app") {
    return relayToApp(event, tags, request.headers.get("svix-id") ?? request.headers.get("webhook-id"));
  }

  const to = Array.isArray(event.data?.to) ? event.data?.to[0] : event.data?.to;
  if (!to) return NextResponse.json({ received: true });

  if (event.type === "email.complained") {
    await markDeliveryFailure(to, "complaint");
  } else if (event.type === "email.bounced") {
    // A soft bounce (mailbox full) is not a reason to stop forever; Resend
    // labels the permanent kind "Permanent"/"hard" depending on API version.
    const kind = String(event.data?.bounce?.type ?? "").toLowerCase();
    if (!kind || kind.includes("perm") || kind.includes("hard")) {
      await markDeliveryFailure(to, "bounce");
    }
  }
  await countForTheDigest(event, tags, request.headers);
  return NextResponse.json({ received: true });
}

/** The webhook delivery's id, as Svix names it: one event, however often delivered. */
const EVENT_ID = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * Hand apps/app one event about this site's own mail, to be counted for the
 * ops digest. Best effort: a relay that fails is logged and dropped, never a
 * reason to fail the delivery, whose lead handling is done.
 */
async function countForTheDigest(
  event: ResendEvent,
  tags: Record<string, string>,
  headers: Headers,
): Promise<void> {
  const type = relayTypeOf(event);
  if (type !== "sent" && type !== "bounced" && type !== "complained" && type !== "suppressed") return;
  // This site's kind tags use hyphens ("setup-link"); apps/app's kinds are
  // underscores only. Untagged mail predates the tags.
  const kind = (tags.kind ?? "untagged").toLowerCase().replace(/-/g, "_");
  if (!KIND.test(kind)) return;
  const eventId = headers.get("svix-id") ?? headers.get("webhook-id") ?? undefined;
  const at =
    typeof event.created_at === "string" && !Number.isNaN(Date.parse(event.created_at))
      ? event.created_at
      : new Date().toISOString();
  try {
    const relayed = await relayWebEmailEvent({
      type,
      at,
      kind,
      ...(eventId && EVENT_ID.test(eventId) ? { eventId } : {}),
    });
    if (!relayed.ok) console.warn(`[healdesk] resend webhook: not counted in apps/app (${relayed.code})`);
  } catch {
    console.warn("[healdesk] resend webhook: not counted in apps/app (threw)");
  }
}

type ResendEvent = {
  type?: string;
  created_at?: string;
  data?: {
    to?: string[] | string;
    bounce?: { type?: string };
    tags?: Record<string, unknown> | { name?: unknown; value?: unknown }[];
  };
};

/**
 * The event's tags as a map. Resend's webhook sends an object; the array form
 * the send API takes is read too, so a change of shape cannot route apps/app's
 * mail into this site's lead handling.
 */
function tagsOf(event: ResendEvent): Record<string, string> {
  const raw = event.data?.tags;
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (const tag of raw) {
      if (typeof tag?.name === "string" && typeof tag.value === "string") out[tag.name] = tag.value;
    }
  } else if (raw && typeof raw === "object") {
    for (const [name, value] of Object.entries(raw)) {
      if (typeof value === "string") out[name] = value;
    }
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND = /^[a-z0-9_]{1,64}$/;

/**
 * Resend's event type in the ledger's vocabulary, or null for an event the
 * ledger does not record (opens and clicks are off; scheduled and received
 * mail are not deliveries). A bounce is `bounced` only when it is permanent,
 * as this route has always read it for leads: a soft bounce is recorded as
 * `delayed`, because `bounced` is what makes a clinic's address undeliverable.
 */
function relayTypeOf(event: ResendEvent): EmailEventRelay["type"] | null {
  switch (event.type) {
    case "email.sent":
      return "sent";
    case "email.delivered":
      return "delivered";
    case "email.delivery_delayed":
      return "delayed";
    case "email.complained":
      return "complained";
    case "email.suppressed":
      return "suppressed";
    case "email.bounced": {
      const kind = String(event.data?.bounce?.type ?? "").toLowerCase();
      return !kind || kind.includes("perm") || kind.includes("hard") ? "bounced" : "delayed";
    }
    default:
      return null;
  }
}

async function relayToApp(
  event: ResendEvent,
  tags: Record<string, string>,
  eventId: string | null,
): Promise<NextResponse> {
  const type = relayTypeOf(event);
  if (!type) return NextResponse.json({ received: true });

  const at =
    typeof event.created_at === "string" && !Number.isNaN(Date.parse(event.created_at))
      ? event.created_at
      : new Date().toISOString();
  const relay: EmailEventRelay = {
    type,
    at,
    ...(tags.clinic && UUID.test(tags.clinic) ? { clinic: tags.clinic } : {}),
    ...(tags.delivery && UUID.test(tags.delivery) ? { delivery: tags.delivery } : {}),
    ...(tags.kind && KIND.test(tags.kind) ? { kind: tags.kind } : {}),
    // The delivery's own id, so a retried delivery counts once in the digest.
    ...(eventId && EVENT_ID.test(eventId) ? { eventId } : {}),
  };

  const relayed = await relayEmailEvent(relay);
  if (!relayed.ok) {
    console.error(`[healdesk] resend webhook: relay to apps/app failed (${relayed.code})`);
    return NextResponse.json({ error: "Relay failed." }, { status: 503 });
  }
  return NextResponse.json({ received: true });
}
