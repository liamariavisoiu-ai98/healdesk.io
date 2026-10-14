import { createHash, timingSafeEqual } from "node:crypto";

import { welcomeHandoff } from "@/lib/admin/ops-client";
import { isBillingConfigured, paidSessionFor } from "@/lib/billing";

import { intentRecordsFor, recordsConfigured } from "./records";

/**
 * What this site's /welcome tells the browser Stripe has just sent back
 * (owner, 14 October 2026; docs/design/checkout-records-on-vercel-2026-10-14.md).
 *
 * Stripe used to return the buyer to apps/app's /welcome. The AWS host now
 * has a standby mode that removes its database and load balancer until the
 * first clinic pays, so the browser comes back here instead, where an answer
 * is always possible, and is sent on to apps/app's /welcome once apps/app has
 * the purchase and something to say about it:
 *
 *   - `ready`: apps/app has imported the purchase and made the account, or
 *     refused it; its /welcome, at the URL it composed, hands this browser its
 *     one-time sign-in link (checking the nonce cookie, as it always has) or
 *     says we finish by hand.
 *   - `waiting`: the payment is through (Stripe says so) and the account is
 *     being set up, or the host is not answering yet. The page says so, names
 *     the address the sign-in link will go to (masked, and only to the
 *     browser holding the purchase's nonce), and looks again.
 *   - `unknown`: Stripe does not say this Session is this purchase's and paid.
 *     Nothing about the purchase is said.
 */
export type WelcomeOutcome =
  | { kind: "ready"; url: string }
  /** `confirmed`: Stripe said this Session is paid; false when Stripe could not be asked. */
  | { kind: "waiting"; email: string | null; confirmed: boolean }
  | { kind: "unknown" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{1,200}$/;

export async function welcomeOutcome(input: {
  ref: string | null;
  sessionId: string | null;
  nonce: string | null;
}): Promise<WelcomeOutcome> {
  const { ref, sessionId } = input;
  if (!ref || !UUID.test(ref) || !sessionId || !SESSION_ID.test(sessionId)) return { kind: "unknown" };

  // Stripe first: until it says this Session is this purchase's, and paid,
  // nothing else is looked at or said.
  if (!isBillingConfigured()) return { kind: "unknown" };
  const session = await paidSessionFor(sessionId, ref);
  if (session && !session.paid) return { kind: "unknown" };

  const email = session ? await payersAddress(ref, sessionId, input.nonce) : null;

  if (session) {
    const handoff = await welcomeHandoff(ref, sessionId);
    if (handoff.ok && handoff.data.ready) return { kind: "ready", url: handoff.data.url };
  }
  // Stripe could not be asked (null session), or apps/app is not ready or
  // not reachable: the page waits, and looks again.
  return { kind: "waiting", email, confirmed: session !== null };
}

/**
 * The address the sign-in link goes to, masked, for the browser that holds
 * this purchase's nonce, and for nobody else: without the nonce, a page that
 * printed even a masked address would tell anyone holding the success URL
 * whose purchase it was. Null when it cannot be read or does not match.
 */
async function payersAddress(ref: string, sessionId: string, nonce: string | null): Promise<string | null> {
  if (!nonce || nonce.length > 200 || !recordsConfigured()) return null;
  try {
    const { records } = await intentRecordsFor(ref);
    const digest = createHash("sha256").update(nonce, "utf8").digest();
    const paid = records.find((r) => r.record.sessionId === sessionId) ?? null;
    const candidates = paid ? [paid] : records;
    const match = candidates.find((r) => {
      const stored = Buffer.from(r.intent.nonceHash, "hex");
      return stored.length === digest.length && timingSafeEqual(stored, digest);
    });
    return match ? maskEmail(match.intent.contactEmail) : null;
  } catch (error) {
    console.warn("[healdesk] welcome: the purchase records could not be read", {
      error: error instanceof Error ? error.name : "unknown error",
    });
    return null;
  }
}

/** `l•••@glowspa.com`, as apps/app's /welcome masks it. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return "•••";
  return `${email[0]}•••${email.slice(at)}`;
}
