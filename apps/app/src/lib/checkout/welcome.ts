import { createHash } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { checkoutIntents } from "@/db/schema";
import { getStripe, stripeConfigured } from "@/lib/billing/stripe-client";
import { describeError, log } from "@/lib/log";
import { portalGrants } from "@/lib/portal/access";
import { publicUrl } from "@/lib/public-url";
import { issueSignInLink, maskEmail } from "@/lib/sign-in/links";

import { findIntent, nonceMatches, type StoredIntent } from "./intents";

/**
 * What /welcome tells the browser that has just paid (plan Part C3).
 *
 * - `pending`: payment is through, the account is being made. Poll again.
 * - `ready`: the account exists, and here is a one-time sign-in link, minted
 *   once per purchase, for this browser only.
 * - `failed`: provisioning refused the paid purchase. The money is safe and
 *   we finish by hand.
 * - `use_email`: the link was already handed out once (a reload, a second
 *   tab), so this browser signs in from the welcome email instead.
 * - `unknown`: this isn't the browser that paid, or the address isn't ours.
 *   Nothing about the purchase is said.
 */
export type WelcomeState =
  | { status: "pending"; email: string }
  | { status: "ready"; url: string }
  | { status: "failed"; email: string }
  | { status: "use_email"; email: string }
  | { status: "unknown" };

const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{1,200}$/;

export async function welcomeState(input: {
  ref: string | null;
  sessionId: string | null;
  nonce: string | null;
}): Promise<WelcomeState> {
  if (!input.ref || !input.sessionId || !SESSION_ID.test(input.sessionId)) return { status: "unknown" };
  const intent = await findIntent(input.ref);
  // The nonce first: without it nothing about the purchase is said, not
  // even whether the ref is real.
  if (!intent || !nonceMatches(intent.nonceHash, input.nonce)) return { status: "unknown" };
  if (!(await sessionBelongs(intent, input.sessionId))) return { status: "unknown" };

  const email = maskEmail(intent.contactEmail);
  // A dead-lettered purchase (lib/checkout/dead-letter.ts) can still be made
  // by a later redelivery, and once it is, its account is what this browser
  // came for: "failed" only while there is none.
  if (intent.provisionFailedAt && !intent.consumedAt) return { status: "failed", email };
  if (!intent.consumedAt || !intent.provisionedUserId || !intent.provisionedClinicId) {
    return { status: "pending", email };
  }

  const clinic = (await portalGrants(intent.provisionedUserId)).find(
    (g) => g.clinicId === intent.provisionedClinicId,
  );
  if (!clinic) return { status: "pending", email };

  const link = await issueSignInLink({
    userId: intent.provisionedUserId,
    purpose: "checkout",
    // One checkout link per purchase, however often this is polled.
    sourceRef: createHash("sha256").update(intent.ref).digest("hex"),
    // The plan's first screen after /welcome is "Protect patient details:
    // use Face ID" (Part D3), then setup (Part E). Nothing patient-facing
    // exists yet, so the paying browser may add the sign-in's first passkey.
    redirectTo: `/c/${clinic.slug}/protect?next=${encodeURIComponent(`/c/${clinic.slug}/setup`)}`,
    issuedBy: "welcome",
  });
  if (!link) return { status: "use_email", email };
  await unsafeDb
    .update(checkoutIntents)
    .set({ handoffIssuedAt: sql`now()` })
    .where(eq(checkoutIntents.ref, intent.ref));
  return { status: "ready", url: publicUrl(`/link/${link.token}`) };
}

/**
 * Whether the Checkout Session in the URL is this purchase's. The id apps/web
 * recorded for the latest attempt answers at once; failing that (a record
 * that never arrived), Stripe itself is asked whose session it is.
 */
async function sessionBelongs(intent: StoredIntent, sessionId: string): Promise<boolean> {
  if (intent.openSessionId === sessionId) return true;
  if (!stripeConfigured()) return false;
  try {
    const session = await getStripe().checkout.sessions.retrieve(sessionId);
    return session.metadata?.app === "healdesk" && session.metadata?.ref === intent.ref;
  } catch (error) {
    log.warn("welcome: the checkout session could not be checked", { error: describeError(error) });
    return false;
  }
}
