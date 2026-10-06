import Stripe from "stripe";

/**
 * A recording Stripe fake for apps/app tests.
 *
 * Any SDK path works (`fake.stripe.subscriptions.update(...)`, and so on).
 * Each call is recorded with its raw arguments and answered by the handler
 * registered under its dotted path, so a test states exactly the Stripe
 * behaviour it relies on, and a call nobody expected fails loudly.
 *
 * It also enforces two rules across every test that uses it:
 * - no request may carry a Stripe trial parameter (`trial_end`,
 *   `trial_period_days`, `trial_settings`, `trial_from_plan`). healdesk never
 *   uses a Stripe trial (contracts §2: Stripe would print "TRIAL OVER" on the
 *   first charge);
 * - no request may run without a handler.
 *
 * Install it with `__setStripeForTests(fake.stripe)` and remove it in afterEach.
 */

type Handler = (...args: unknown[]) => unknown;

export type StripeFakeCall = { method: string; args: unknown[] };

const TRIAL_KEYS = new Set(["trial_end", "trial_period_days", "trial_settings", "trial_from_plan"]);

function findTrialKey(value: unknown, depth = 0): string | null {
  if (depth > 8 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTrialKey(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (TRIAL_KEYS.has(key)) return key;
    const found = findTrialKey(inner, depth + 1);
    if (found) return found;
  }
  return null;
}

export function createStripeFake(initial: Record<string, Handler> = {}) {
  const handlers: Record<string, Handler> = { ...initial };
  const calls: StripeFakeCall[] = [];

  const node = (path: string[]): unknown =>
    new Proxy(function stripeFakeNode() {}, {
      get(_target, prop) {
        // Never look like a promise, and never answer symbol lookups.
        if (prop === "then" || typeof prop === "symbol") return undefined;
        return node([...path, prop]);
      },
      apply(_target, _thisArg, args: unknown[]) {
        const method = path.join(".");
        calls.push({ method, args });
        const trialKey = findTrialKey(args);
        if (trialKey) {
          return Promise.reject(
            new Error(
              `Stripe fake: ${method} sent ${trialKey}; healdesk never uses a Stripe trial.`,
            ),
          );
        }
        const handler = handlers[method];
        if (!handler) {
          return Promise.reject(new Error(`Stripe fake: no handler for ${method}.`));
        }
        try {
          return Promise.resolve(handler(...args));
        } catch (error) {
          return Promise.reject(error);
        }
      },
    });

  return {
    stripe: node([]) as Stripe,
    calls,
    /** Every recorded call to one dotted path, in order. */
    callsTo(method: string): StripeFakeCall[] {
      return calls.filter((call) => call.method === method);
    },
    /** Register or replace the handler for one dotted path. */
    on(method: string, handler: Handler): void {
      handlers[method] = handler;
    },
  };
}

export type StripeFake = ReturnType<typeof createStripeFake>;

/** A real SDK error instance, so `instanceof Stripe.errors.*` checks in code under test hold. */
export function stripeError(
  kind: "card" | "api" | "invalid_request" | "idempotency" | "rate_limit" | "connection",
  raw: { message?: string; code?: string; statusCode?: number } = {},
): Error {
  const message = raw.message ?? `${kind} error`;
  const base = { message, code: raw.code, statusCode: raw.statusCode };
  switch (kind) {
    case "card":
      return new Stripe.errors.StripeCardError({
        ...base,
        type: "card_error",
        statusCode: raw.statusCode ?? 402,
      });
    case "api":
      return new Stripe.errors.StripeAPIError({
        ...base,
        type: "api_error",
        statusCode: raw.statusCode ?? 500,
      });
    case "invalid_request":
      return new Stripe.errors.StripeInvalidRequestError({
        ...base,
        type: "invalid_request_error",
        statusCode: raw.statusCode ?? 400,
      });
    case "idempotency":
      return new Stripe.errors.StripeIdempotencyError({
        ...base,
        type: "idempotency_error",
        statusCode: raw.statusCode ?? 400,
      });
    case "rate_limit":
      return new Stripe.errors.StripeRateLimitError({
        ...base,
        type: "invalid_request_error",
        statusCode: raw.statusCode ?? 429,
      });
    case "connection":
      return new Stripe.errors.StripeConnectionError({ ...base, type: "api_error" });
  }
}
