import { createHmac, timingSafeEqual } from "node:crypto";

import { eq } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { clinics } from "@/db/schema";
import { recordSecurityEvent } from "@/lib/audit";
import { env } from "@/lib/env";
import { withTenant } from "@/lib/tenant";

/**
 * Stripe Connect, Standard accounts: the scaffold for deposits into the
 * clinic's OWN Stripe.
 *
 * Standard is the lowest-liability shape: the clinic keeps its own Stripe
 * login and its own funds, and the platform holds an account id that lets it
 * create a checkout on the clinic's behalf. Nothing here moves money yet —
 * a deposit link needs a channel to send it on (SMS, which waits on 10DLC)
 * — so what ships is the authorisation: an OAuth link on the onboarding
 * page, a callback that exchanges the code and stores the account id, and a
 * per-clinic deposit rule the agent states on the call. Until a clinic is
 * connected the deposit is collected by the front desk, and every booking
 * with one owed is flagged `pending_front_desk`.
 *
 * The state parameter is signed (HMAC over clinic id and issue time with the
 * provisioning secret) and valid for an hour, so a callback cannot attach a
 * stranger's Stripe account to a clinic by guessing an id.
 */
const STATE_TTL_MS = 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function connectConfigured(): boolean {
  return Boolean(process.env.STRIPE_CONNECT_CLIENT_ID && process.env.STRIPE_SECRET_KEY);
}

function sign(clinicId: string, issuedAt: number, secret: string): string {
  return createHmac("sha256", secret).update(`${clinicId}.${issuedAt}`).digest("base64url");
}

export function connectState(clinicId: string, now: Date = new Date(), secret: string = env.provisionSecret()): string {
  const issuedAt = now.getTime();
  return `${clinicId}.${issuedAt}.${sign(clinicId, issuedAt, secret)}`;
}

export function verifyConnectState(
  state: string | null | undefined,
  now: Date = new Date(),
  secret: string = env.provisionSecret(),
): string | null {
  if (!state) return null;
  const [clinicId, issuedRaw, mac] = state.split(".");
  if (!clinicId || !issuedRaw || !mac || !UUID.test(clinicId)) return null;
  const issuedAt = Number(issuedRaw);
  if (!Number.isFinite(issuedAt)) return null;
  if (now.getTime() - issuedAt > STATE_TTL_MS || issuedAt > now.getTime() + 60_000) return null;
  const expected = Buffer.from(sign(clinicId, issuedAt, secret));
  const presented = Buffer.from(mac);
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return null;
  return clinicId;
}

/** The callback URL Stripe sends the clinic back to; registered on the platform. */
export function connectRedirectUri(): string {
  return `${env.betterAuthUrl().replace(/\/$/, "")}/api/connect/stripe`;
}

/** The link the onboarding page shows, or null when the platform is not enabled. */
export function connectAuthorizeUrl(clinicId: string, now: Date = new Date()): string | null {
  const clientId = process.env.STRIPE_CONNECT_CLIENT_ID;
  if (!clientId || !process.env.STRIPE_SECRET_KEY) return null;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: "read_write",
    redirect_uri: connectRedirectUri(),
    state: connectState(clinicId, now),
  });
  return `https://connect.stripe.com/oauth/authorize?${params.toString()}`;
}

export type CodeExchange = (code: string) => Promise<{ accountId: string }>;

/** The real exchange: Stripe's OAuth token endpoint, through the SDK. */
export async function exchangeWithStripe(code: string): Promise<{ accountId: string }> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set.");
  const { default: Stripe } = await import("stripe");
  const stripe = new Stripe(key);
  const token = await stripe.oauth.token({ grant_type: "authorization_code", code });
  if (!token.stripe_user_id) throw new Error("Stripe returned no account id.");
  return { accountId: token.stripe_user_id };
}

export type ConnectResult =
  | { status: "connected"; clinicId: string; accountId: string }
  | { status: "invalid_state" }
  | { status: "failed"; reason: string };

/** The callback's work: verify the state, exchange the code, store the account. */
export async function completeConnect(
  input: { code: string | null; state: string | null },
  exchange: CodeExchange = exchangeWithStripe,
  now: Date = new Date(),
): Promise<ConnectResult> {
  const clinicId = verifyConnectState(input.state, now);
  if (!clinicId || !input.code) return { status: "invalid_state" };

  let accountId: string;
  try {
    ({ accountId } = await exchange(input.code));
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message.slice(0, 200) : "exchange failed" };
  }
  if (!/^acct_[A-Za-z0-9]+$/.test(accountId)) return { status: "failed", reason: "not an account id" };

  const actor = { type: "service", serviceName: "stripe-connect" } as const;
  await withTenant({ clinicId, actor }, async (tx) => {
    await tx.db
      .update(clinics)
      .set({ stripeConnectAccountId: accountId, stripeConnectConnectedAt: now, updatedAt: now })
      .where(eq(clinics.id, tx.clinicId));
    tx.audit.record({ action: "update", resourceType: "clinic_stripe_connect", resourceId: tx.clinicId, metadata: { connected: true } });
  });
  await recordSecurityEvent(unsafeDb, {
    event: "stripe_connect_linked",
    actorLabel: "stripe-connect",
    metadata: { clinicId, accountId },
  });
  return { status: "connected", clinicId, accountId };
}
