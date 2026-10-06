import Stripe from "stripe";

import { env } from "@/lib/env";

/**
 * The platform Stripe client for apps/app (design D15).
 *
 * apps/app already held the platform secret key for Stripe Connect; the launch
 * adds plan changes, extra locations, metered usage, annual overage invoices,
 * refunds and portal sessions, all of which run here because the subscription
 * carries metered prices Stripe's own portal cannot update (design D13). One
 * client, read through env.ts, so a missing key is one error with one name
 * rather than a different failure in every caller.
 *
 * Constructed lazily and cached per process. Never call it inside a database
 * transaction: commit, call Stripe, then open a new transaction (design §2).
 *
 * The SDK's default API version is used (stripe 22.6.1, 2026-08-26.dahlia);
 * pinning a different one here would silently change the shape of every
 * payload the webhook code reads.
 */

export class StripeNotConfiguredError extends Error {
  constructor() {
    super("STRIPE_SECRET_KEY is not set; Stripe is not configured for apps/app.");
    this.name = "StripeNotConfiguredError";
  }
}

let cached: Stripe | null = null;
let cachedKey: string | null = null;
let fake: Stripe | null = null;

/** True when a secret key is present (or a test fake is installed). */
export function stripeConfigured(): boolean {
  return fake !== null || Boolean(env.stripeSecretKey());
}

/** The client, or StripeNotConfiguredError when there is no key. */
export function getStripe(): Stripe {
  if (fake) return fake;
  const key = env.stripeSecretKey();
  if (!key) throw new StripeNotConfiguredError();
  // Rebuilt if the key changes (a rotated key in a long-lived test process);
  // otherwise one client, which keeps one keep-alive agent.
  if (!cached || cachedKey !== key) {
    cached = new Stripe(key, { appInfo: { name: "healdesk-app" } });
    cachedKey = key;
  }
  return cached;
}

/**
 * Install a fake for tests (anything shaped enough like the SDK for the code
 * under test), or `null` to remove it. Test-only: refused in production.
 */
export function __setStripeForTests(replacement: unknown | null): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__setStripeForTests is not available in production.");
  }
  fake = (replacement as Stripe | null) ?? null;
}
