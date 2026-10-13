import { createHmac, timingSafeEqual } from "node:crypto";

import { site } from "@/lib/site";

/**
 * Email from the MARKETING side. No patient information ever passes through
 * here — this module lives in apps/web, which holds none — and that is what
 * lets it use Resend without a BAA. The product's own mail (agreement copies,
 * report notices) is a different module in apps/app with different rules.
 *
 * ## The port/transport shape, borrowed from apps/app/src/lib/reporting/deliver.ts
 *
 * `send()` picks a transport from the environment: Resend when
 * RESEND_API_KEY and HEALDESK_EMAIL_FROM are set, otherwise a console
 * transport that prints what it would have sent — and throws in production,
 * because a marketing site that silently drops the nurture sequence is worse
 * than one that fails loudly on the first cron run.
 *
 * ## What every marketing message carries, by construction
 *
 *   - a working one-click unsubscribe (List-Unsubscribe + List-Unsubscribe-Post,
 *     the RFC 8058 pair Gmail and Yahoo require of bulk senders since 2024)
 *   - the same link in the footer, and the postal address from legal.ts
 *   - a From that is a real person at a subdomain that is NOT one of the cold
 *     outreach domains (docs/handover.md); the two reputations never mix
 *
 * Whether a message MAY be sent at all is decided by the caller with
 * `canEmail()` in lib/leads.ts, which checks consent, unsubscribe and bounce
 * state on the lead. This module sends what it is given.
 */

export type OutboundEmail = {
  to: string;
  subject: string;
  text: string;
  /**
   * An HTML part beside the text, for mail whose links are buttons. The text
   * stays the whole message on its own: a client that shows only text, or a
   * reader who turned HTML off, misses nothing but the styling.
   */
  html?: string;
  /**
   * Hand the message to Resend now and have it sent at this moment, up to 30
   * days ahead. The result's `providerId` is then what `cancelScheduledEmail`
   * takes, while the moment has not come.
   */
  scheduledAt?: Date;
  replyTo?: string;
  /** Present on marketing mail; absent on transactional mail. */
  unsubscribeUrl?: string;
  /** Provider-side tag, for the dashboard. Never contains a person's data. */
  tag?: string;
  /**
   * Resend's `Idempotency-Key`: the same key within 24 hours sends once.
   * Built from row ids and the kind (`setup-ack:<request id>`), never from
   * an address, because Resend keeps the key in its logs.
   */
  idempotencyKey?: string;
};

export type SendResult =
  | { status: "sent"; providerId: string | null }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.HEALDESK_EMAIL_FROM);
}

export async function send(message: OutboundEmail): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.HEALDESK_EMAIL_FROM;

  if (!apiKey || !from) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "RESEND_API_KEY and HEALDESK_EMAIL_FROM are required to send email in production.",
      );
    }
    // Development: say what would have gone, to whom (domain only), and stop.
    console.info("[healdesk] email (no transport configured; not sent)", {
      to: `@${message.to.split("@")[1] ?? "?"}`,
      subject: message.subject,
      tag: message.tag,
    });
    return { status: "skipped", reason: "no transport configured" };
  }

  const headers: Record<string, string> = {};
  if (message.unsubscribeUrl) {
    headers["List-Unsubscribe"] = `<${message.unsubscribeUrl}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(message.idempotencyKey ? { "Idempotency-Key": message.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from,
        to: [message.to],
        reply_to: message.replyTo ?? site.email,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        ...(message.scheduledAt ? { scheduled_at: message.scheduledAt.toISOString() } : {}),
        headers,
        // `app` lets the one Resend account's webhook tell this site's mail
        // from the product's (Annex X3). Tag values allow letters, digits,
        // `_` and `-` only, which the kinds used here keep to.
        tags: [
          { name: "app", value: "web" },
          ...(message.tag ? [{ name: "kind", value: message.tag }] : []),
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      return { status: "failed", reason: `resend ${response.status}: ${detail}` };
    }
    const data = (await response.json().catch(() => null)) as { id?: string } | null;
    return { status: "sent", providerId: data?.id ?? null };
  } catch (error) {
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : "unknown error",
    };
  }
}

/**
 * `send()` for callers whose own work is already done: a form whose row is
 * saved, an operator action whose state is written. `send()` throws in
 * production when no transport is configured, which is right for the cron
 * and wrong for a request that has nothing left to roll back, so here a
 * throw is a failed send the caller can log and report.
 */
export async function sendSafely(message: OutboundEmail): Promise<SendResult> {
  try {
    return await send(message);
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Call off a message `send()` scheduled, before its moment. Resend refuses
 * once the message has gone, which is reported as a failure with Resend's
 * reason. Development without a transport has nothing to cancel.
 */
export async function cancelScheduledEmail(providerId: string): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { status: "skipped", reason: "no transport configured" };
  try {
    const response = await fetch(`https://api.resend.com/emails/${encodeURIComponent(providerId)}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      return { status: "failed", reason: `resend ${response.status}: ${detail}` };
    }
    return { status: "sent", providerId };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : "unknown error" };
  }
}

// -----------------------------------------------------------------------------
// Unsubscribe tokens
// -----------------------------------------------------------------------------

/**
 * The link in every marketing email is `/api/email/unsubscribe?t=<token>`,
 * where the token is the lead id plus an HMAC over it. Signed, so the URL
 * cannot be edited into someone else's unsubscribe; not expiring, because an
 * unsubscribe link in a six-month-old email must still work.
 *
 * Signed with HEALDESK_GATE_SECRET under its own purpose string, the same
 * way the agreement-download cookie derives its key: one variable, two keys,
 * neither usable as the other.
 */
function unsubscribeKey(): string {
  const secret = process.env.HEALDESK_GATE_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("HEALDESK_GATE_SECRET is required to sign unsubscribe links.");
    }
    return "dev-only-insecure-secret";
  }
  return createHmac("sha256", secret).update("email-unsubscribe").digest("hex");
}

export function unsubscribeToken(leadId: string): string {
  const sig = createHmac("sha256", unsubscribeKey()).update(leadId).digest("base64url");
  return `${leadId}.${sig}`;
}

export function verifyUnsubscribeToken(token: string | null | undefined): string | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const leadId = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^[0-9a-f-]{36}$/i.test(leadId)) return null;
  const expected = createHmac("sha256", unsubscribeKey()).update(leadId).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return leadId;
}

export function unsubscribeUrl(leadId: string): string {
  return `${site.url}/api/email/unsubscribe?t=${encodeURIComponent(unsubscribeToken(leadId))}`;
}

/**
 * The opt-out on the setup-link emails (P4, P5), which are about one setup
 * request rather than one lead: a request can exist with no lead behind it.
 * `s.<request id>.<hmac over "setup:<id>">`, under the same derived key. A
 * lead token is a bare uuid first, and no uuid starts with "s.", so the two
 * shapes cannot be mistaken for each other.
 */
export function setupUnsubscribeUrl(requestId: string): string {
  const sig = createHmac("sha256", unsubscribeKey()).update(`setup:${requestId}`).digest("base64url");
  return `${site.url}/api/email/unsubscribe?t=${encodeURIComponent(`s.${requestId}.${sig}`)}`;
}

/**
 * The opt-out on the email that says a demo's setup offer has ended
 * (lib/demo/offer-ended.ts), which is about one demo: a demo can exist with
 * no lead behind it. `d.<demo id>.<hmac over "demo:<id>">`, the setup shape
 * under its own purpose string.
 */
export function demoUnsubscribeUrl(demoId: string): string {
  const sig = createHmac("sha256", unsubscribeKey()).update(`demo:${demoId}`).digest("base64url");
  return `${site.url}/api/email/unsubscribe?t=${encodeURIComponent(`d.${demoId}.${sig}`)}`;
}

export type UnsubscribeTarget = { kind: "lead" | "setup" | "demo"; id: string };

const SCOPED: Record<string, { kind: "setup" | "demo"; purpose: string }> = {
  "s.": { kind: "setup", purpose: "setup" },
  "d.": { kind: "demo", purpose: "demo" },
};

export function verifyUnsubscribeTarget(token: string | null | undefined): UnsubscribeTarget | null {
  if (!token) return null;
  const scope = SCOPED[token.slice(0, 2)];
  if (scope) {
    const rest = token.slice(2);
    const dot = rest.lastIndexOf(".");
    if (dot <= 0) return null;
    const id = rest.slice(0, dot);
    const sig = rest.slice(dot + 1);
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const expected = createHmac("sha256", unsubscribeKey()).update(`${scope.purpose}:${id}`).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return { kind: scope.kind, id };
  }
  const leadId = verifyUnsubscribeToken(token);
  return leadId ? { kind: "lead", id: leadId } : null;
}
