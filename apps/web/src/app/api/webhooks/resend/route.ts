import { createHmac, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

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

  let event: { type?: string; data?: { to?: string[] | string; bounce?: { type?: string } } };
  try {
    event = JSON.parse(body) as typeof event;
  } catch {
    return NextResponse.json({ error: "Invalid body." }, { status: 400 });
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
  return NextResponse.json({ received: true });
}
