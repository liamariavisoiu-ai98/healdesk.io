import { describe, expect, test } from "vitest";

import type Stripe from "stripe";

import {
  CONNECT_WEBHOOK_EVENTS,
  CONNECT_WEBHOOK_META,
  connectEndpointProblems,
  connectEndpointUrl,
  connectSecretFile,
  desiredPortal,
  portalProblems,
} from "./stripe-account-settings";

/**
 * The pure parts of the account-settings script (build spec BD15, BD29,
 * R23): the Customer Portal offers the card and the invoices with
 * cancellation switched off, and the opt-in Connect endpoint is built only
 * from apps/app's own https origin. Importing the script must not run it.
 */

const SITE = "https://healdesk.io";

/** A configuration as Stripe returns it, shaped from what we ask for. */
function configuration(
  overrides: Partial<Record<keyof Stripe.BillingPortal.Configuration.Features, object>> = {},
): Stripe.BillingPortal.Configuration {
  const want = desiredPortal(SITE);
  return {
    id: "bpc_test",
    metadata: { healdesk: "customer-portal" },
    is_default: false,
    default_return_url: want.default_return_url,
    business_profile: {
      privacy_policy_url: want.business_profile?.privacy_policy_url,
      terms_of_service_url: want.business_profile?.terms_of_service_url,
    },
    features: {
      customer_update: { enabled: false },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      // Stripe keeps the old mode on a disabled feature.
      subscription_cancel: { enabled: false, mode: "at_period_end", proration_behavior: "none" },
      subscription_update: { enabled: false },
      ...overrides,
    },
  } as unknown as Stripe.BillingPortal.Configuration;
}

describe("the Customer Portal configuration", () => {
  test("offers the payment method and invoice history, with cancellation and plan switching off", () => {
    const want = desiredPortal(SITE);
    expect(want.metadata).toEqual({ healdesk: "customer-portal" });
    expect(want.features).toEqual({
      customer_update: { enabled: false },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: false },
      subscription_update: { enabled: false },
    });
  });

  test("a configuration with cancellation still on is a problem; the leftover mode of a disabled feature is not", () => {
    const want = desiredPortal(SITE);
    expect(portalProblems(configuration(), want)).toEqual([]);
    expect(
      portalProblems(
        configuration({
          subscription_cancel: { enabled: true, mode: "at_period_end", proration_behavior: "none" },
        }),
        want,
      ),
    ).toEqual(["subscription_cancel is true, want false"]);
    expect(
      portalProblems(
        configuration({
          subscription_cancel: {
            enabled: false,
            mode: "immediately",
            proration_behavior: "create_prorations",
          },
        }),
        want,
      ),
    ).toEqual([]);
  });
});

describe("the Connect webhook endpoint", () => {
  test("is apps/app's public origin plus the Connect route, keeping a path prefix", () => {
    expect(connectEndpointUrl("https://app.healdesk.io")).toEqual({
      url: "https://app.healdesk.io/api/webhooks/stripe-connect",
    });
    expect(connectEndpointUrl("https://example.com/app/")).toEqual({
      url: "https://example.com/app/api/webhooks/stripe-connect",
    });
  });

  test("refuses no origin, a non-https origin, the marketing site, and anything that is not a bare origin", () => {
    for (const bad of [
      undefined,
      "",
      "not a url",
      "http://app.healdesk.io",
      "https://healdesk.io",
      "https://www.healdesk.io/",
      "https://app.healdesk.io/?x=1",
      "https://user:pass@app.healdesk.io",
    ]) {
      expect(connectEndpointUrl(bad), String(bad)).toHaveProperty("error");
    }
  });

  test("subscribes to the deposit session's outcomes and the disconnection, and never invoice.created", () => {
    expect([...CONNECT_WEBHOOK_EVENTS].sort()).toEqual([
      "account.application.deauthorized",
      "checkout.session.async_payment_failed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.completed",
      "checkout.session.expired",
    ]);
    expect(CONNECT_WEBHOOK_EVENTS).not.toContain("invoice.created");
  });

  test("a found endpoint must be ours and a Connect one; events and status can be put right", () => {
    const ours = {
      enabled_events: [...CONNECT_WEBHOOK_EVENTS],
      status: "enabled",
      metadata: { ...CONNECT_WEBHOOK_META },
      api_version: "2026-08-26.dahlia",
    };
    expect(connectEndpointProblems(ours)).toEqual({ fatal: [], fixable: [] });
    expect(connectEndpointProblems({ ...ours, connect: true })).toEqual({ fatal: [], fixable: [] });
    expect(connectEndpointProblems({ ...ours, connect: false }).fatal).toEqual([
      "it is an account endpoint, not a Connect one",
    ]);
    expect(connectEndpointProblems({ ...ours, metadata: {} }).fatal).toHaveLength(1);
    expect(
      connectEndpointProblems({ ...ours, api_version: "2025-03-31.basil" }).fatal,
    ).toHaveLength(1);
    expect(
      connectEndpointProblems({
        ...ours,
        enabled_events: ["checkout.session.completed"],
        status: "disabled",
      }).fixable,
    ).toEqual(["events are [checkout.session.completed]", "status is disabled"]);
  });

  test("its secret goes to the git-ignored .env.*.local pattern, apart from the platform's", () => {
    expect(connectSecretFile(true)).toMatch(/\.env\.stripe-connect-webhook-live\.local$/);
    expect(connectSecretFile(false)).toMatch(/\.env\.stripe-connect-webhook-test\.local$/);
  });
});
