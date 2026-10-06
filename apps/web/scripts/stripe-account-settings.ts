/**
 * The account-level Stripe settings healdesk depends on, beyond the catalog
 * that stripe-setup.ts creates: the statement descriptor on our products, the
 * Customer Portal configuration, and the webhook endpoint.
 *
 * Run after stripe-setup.ts, once per Stripe environment, and again whenever
 * one of these changes:
 *
 *   STRIPE_SECRET_KEY=rk_... npx tsx apps/web/scripts/stripe-account-settings.ts --dry-run
 *   STRIPE_SECRET_KEY=rk_... npx tsx apps/web/scripts/stripe-account-settings.ts
 *
 * The key needs Write on Products, Webhook Endpoints and Customer Portal and
 * nothing else. A section the key cannot reach is reported, not skipped
 * silently, and the run exits non-zero. `--dry-run` reads everything and
 * writes nothing.
 *
 * ## One Stripe account serves healdesk and scalabid
 *
 * So nothing here touches an account-wide setting. The statement descriptor
 * is set on OUR products, which Stripe uses for subscription payments (the
 * first product's, when an invoice bills several), so a med spa's statement
 * reads HEALDESK while scalabid's charges keep the account's own descriptor.
 * The portal is a separate configuration tagged as ours and never the
 * account default, so scalabid's portal is untouched; healdesk passes its id
 * when it opens a portal session. The webhook endpoint is matched by URL.
 *
 * ## What the portal offers
 *
 * Payment method, invoice history, and cancellation at the end of the
 * period. Plan switching is OFF: the portal cannot update a subscription that
 * carries metered prices, and a package change must swap the metered items
 * to the new package's rates (catalog header, `planMeteredPrices`). There is
 * no pause, and no immediate cancellation (docs/v1-product-spec.md, "What the
 * portal does not have").
 *
 * ## Not settable here
 *
 * What Stripe does after the last retry of a failed payment is Dashboard-only:
 * Settings → Billing → Revenue recovery, and it must leave the subscription
 * past due, never cancel it (healdesk owns that transition; see the closing
 * notes of stripe-setup.ts). Stripe Tax is off by the owner's decision of
 * 5 October 2026.
 */

import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import Stripe from "stripe";

/** Up to 22 characters; Stripe prints it in capitals. */
const STATEMENT_DESCRIPTOR = "HEALDESK";

/** The metadata stripe-setup.ts puts on every product it creates. */
const PRODUCT_META_KEYS = ["healdesk_plan_id", "healdesk_meter"] as const;

const PORTAL_META = { healdesk: "customer-portal" } as const;

const WEBHOOK_META = { healdesk: "webhook" } as const;

/**
 * Every event app/api/webhooks/stripe handles: the ones it relays to apps/app
 * and the abandonment it records itself. Not
 * customer.subscription.paused/resumed: they only fire when a trial ends
 * without a card, and there is no trial; a Dashboard pause arrives on
 * customer.subscription.updated.
 */
const WEBHOOK_EVENTS = [
  "charge.dispute.created",
  // A refund (the first-period guarantee), relayed to apps/app for Package C.
  // Stripe only starts sending it once this script is re-run on live, which
  // is the owner's call.
  "charge.refunded",
  "checkout.session.async_payment_succeeded",
  "checkout.session.completed",
  // An abandoned checkout: the route records it in the lead store, nothing
  // reaches apps/app (ABANDONMENT_EVENTS in the route).
  "checkout.session.expired",
  "customer.subscription.deleted",
  "customer.subscription.updated",
  "invoice.paid",
  "invoice.payment_action_required",
  "invoice.payment_failed",
] as const satisfies readonly Stripe.WebhookEndpointCreateParams.EnabledEvent[];

const LIVE_SITE = "https://healdesk.io";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Reporting, in the same shape as stripe-setup.ts.
// ---------------------------------------------------------------------------

const tally = { created: 0, updated: 0, verified: 0, unreachable: 0 };

function line(glyph: string, text: string): void {
  console.log(`  ${glyph} ${text}`);
}

/**
 * Runs one section, turning a permission error into a reported gap rather
 * than a crash, so one missing permission does not hide the state of the
 * other two sections.
 */
async function section(title: string, permission: string, run: () => Promise<void>): Promise<void> {
  console.log(`\n${title}`);
  try {
    await run();
  } catch (error) {
    if (error instanceof Stripe.errors.StripePermissionError) {
      tally.unreachable += 1;
      line("✗", `NOT CHECKED: the key has no "${permission}" permission (Write).`);
      return;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 1. The statement descriptor, on our products only.
// ---------------------------------------------------------------------------

async function syncStatementDescriptors(stripe: Stripe, dryRun: boolean): Promise<void> {
  let ours = 0;
  for await (const product of stripe.products.list({ active: true, limit: 100 })) {
    if (!PRODUCT_META_KEYS.some((key) => product.metadata[key])) continue;
    ours += 1;
    const label = `${product.name.padEnd(36)} ${product.id}`;
    if (product.statement_descriptor === STATEMENT_DESCRIPTOR) {
      tally.verified += 1;
      line("✓", label);
      continue;
    }
    if (dryRun) {
      line("·", `${label}  would set "${STATEMENT_DESCRIPTOR}" (now ${JSON.stringify(product.statement_descriptor)})`);
      continue;
    }
    await stripe.products.update(product.id, { statement_descriptor: STATEMENT_DESCRIPTOR });
    tally.updated += 1;
    line("~", `${label}  set "${STATEMENT_DESCRIPTOR}"`);
  }
  if (ours === 0) {
    line("✗", "No healdesk products found. Run stripe-setup.ts first.");
    tally.unreachable += 1;
  }
}

// ---------------------------------------------------------------------------
// 2. The Customer Portal, as its own configuration.
// ---------------------------------------------------------------------------

function desiredPortal(site: string): Stripe.BillingPortal.ConfigurationCreateParams {
  return {
    name: "healdesk",
    metadata: { ...PORTAL_META },
    business_profile: {
      privacy_policy_url: `${site}/privacy`,
      terms_of_service_url: `${site}/terms`,
    },
    default_return_url: site,
    features: {
      customer_update: { enabled: false },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: {
        enabled: true,
        mode: "at_period_end",
        proration_behavior: "none",
      },
      subscription_update: { enabled: false },
    },
  };
}

/** Where an existing configuration differs from what we want; empty when it matches. */
function portalProblems(
  have: Stripe.BillingPortal.Configuration,
  want: Stripe.BillingPortal.ConfigurationCreateParams,
): string[] {
  const f = have.features;
  const problems: string[] = [];
  const check = (what: string, actual: unknown, expected: unknown) => {
    if (actual !== expected) problems.push(`${what} is ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  };
  check("customer_update", f.customer_update.enabled, false);
  check("invoice_history", f.invoice_history.enabled, true);
  check("payment_method_update", f.payment_method_update.enabled, true);
  check("subscription_cancel", f.subscription_cancel.enabled, true);
  check("subscription_cancel.mode", f.subscription_cancel.mode, "at_period_end");
  check("subscription_cancel.proration_behavior", f.subscription_cancel.proration_behavior, "none");
  check("subscription_update", f.subscription_update.enabled, false);
  check("privacy_policy_url", have.business_profile.privacy_policy_url, want.business_profile?.privacy_policy_url);
  check("terms_of_service_url", have.business_profile.terms_of_service_url, want.business_profile?.terms_of_service_url);
  check("default_return_url", have.default_return_url, want.default_return_url);
  return problems;
}

async function syncPortal(stripe: Stripe, site: string, dryRun: boolean): Promise<void> {
  const want = desiredPortal(site);
  let found: Stripe.BillingPortal.Configuration | undefined;
  let others = 0;
  for await (const config of stripe.billingPortal.configurations.list({ active: true, limit: 100 })) {
    if (config.metadata?.healdesk === PORTAL_META.healdesk) found ??= config;
    else others += 1;
  }

  if (!found) {
    if (dryRun) {
      line("·", "configuration  would create: payment method + invoice history ON, cancel at period end ON, plan switch OFF");
      return;
    }
    const created = await stripe.billingPortal.configurations.create(want);
    tally.created += 1;
    line("+", `configuration  ${created.id}  (not the account default)`);
    return;
  }

  // The default is what a portal session without a configuration id gets, so
  // ours being it would hand scalabid our portal. Stripe makes an account's
  // first configuration the default and allows no account without one, so
  // when ours is the only configuration (as on 6 October 2026: scalabid had
  // none) that is unavoidable and harmless, and only noted.
  if (found.is_default && others > 0) {
    line("✗", `configuration  ${found.id} is the ACCOUNT DEFAULT over ${others} other(s); scalabid's portal would get ours. Make theirs the default by hand.`);
    tally.unreachable += 1;
  } else if (found.is_default) {
    line(" ", `configuration  ${found.id} is the account default only because it is the account's only one`);
  }
  const problems = portalProblems(found, want);
  if (problems.length === 0) {
    tally.verified += 1;
    line("✓", `configuration  ${found.id}`);
    return;
  }
  if (dryRun) {
    line("·", `configuration  ${found.id}  would update: ${problems.join("; ")}`);
    return;
  }
  const { metadata: _metadata, ...update } = want;
  await stripe.billingPortal.configurations.update(found.id, update);
  tally.updated += 1;
  line("~", `configuration  ${found.id}  updated: ${problems.join("; ")}`);
}

// ---------------------------------------------------------------------------
// 3. The webhook endpoint.
// ---------------------------------------------------------------------------

/**
 * Where a new endpoint's signing secret is written. Stripe shows it exactly
 * once, at creation, and it never goes to stdout: a terminal log is where
 * secrets leak from. The `.env.*.local` pattern is git-ignored.
 */
function secretFile(live: boolean): string {
  return join(HERE, "..", `.env.stripe-webhook-${live ? "live" : "test"}.local`);
}

async function syncWebhook(stripe: Stripe, url: string, live: boolean, dryRun: boolean): Promise<void> {
  const want = [...WEBHOOK_EVENTS].sort();
  let found: Stripe.WebhookEndpoint | undefined;
  for await (const endpoint of stripe.webhookEndpoints.list({ limit: 100 })) {
    if (endpoint.url === url) {
      found = endpoint;
      break;
    }
  }

  if (!found) {
    if (dryRun) {
      line("·", `endpoint  would create ${url} for ${want.length} events`);
      return;
    }
    const file = secretFile(live);
    if (existsSync(file)) {
      throw new Error(`${relative(process.cwd(), file)} already exists. Move it aside before creating a new endpoint.`);
    }
    const created = await stripe.webhookEndpoints.create({
      url,
      enabled_events: want,
      description: "healdesk: checkout, subscription lifecycle, disputes",
      metadata: { ...WEBHOOK_META },
    });
    writeFileSync(file, `STRIPE_WEBHOOK_SECRET=${created.secret}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    tally.created += 1;
    line("+", `endpoint  ${created.id}  ${url}`);
    line(" ", `signing secret written to ${relative(process.cwd(), file)} (not printed)`);
    return;
  }

  const have = [...found.enabled_events].sort();
  const eventsMatch = have.length === want.length && have.every((event, i) => event === want[i]);
  const enabled = found.status === "enabled";
  if (eventsMatch && enabled) {
    tally.verified += 1;
    line("✓", `endpoint  ${found.id}  ${url}`);
    return;
  }
  const problems = [
    eventsMatch ? null : `events are [${have.join(", ")}]`,
    enabled ? null : `status is ${found.status}`,
  ].filter(Boolean);
  if (dryRun) {
    line("·", `endpoint  ${found.id}  would update: ${problems.join("; ")}`);
    return;
  }
  await stripe.webhookEndpoints.update(found.id, { enabled_events: want, disabled: false });
  tally.updated += 1;
  line("~", `endpoint  ${found.id}  updated: ${problems.join("; ")}`);
  line(" ", "its signing secret is unchanged; Stripe shows it only at creation");
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error("STRIPE_SECRET_KEY is not set.");
    process.exit(1);
  }
  const live = /^(sk|rk)_live_/.test(key);
  const stripe = new Stripe(key);

  console.log(`healdesk → Stripe account settings (${live ? "LIVE" : "test"} mode${dryRun ? ", dry run: nothing is written" : ""})`);

  await section(`Statement descriptor "${STATEMENT_DESCRIPTOR}" on healdesk products`, "Products", () =>
    syncStatementDescriptors(stripe, dryRun),
  );
  await section("Customer Portal", "Customer Portal", () => syncPortal(stripe, LIVE_SITE, dryRun));
  if (live) {
    await section("Webhook endpoint", "Webhook Endpoints", () =>
      syncWebhook(stripe, `${LIVE_SITE}/api/webhooks/stripe`, live, dryRun),
    );
  } else {
    console.log(
      "\nWebhook endpoint\n  · skipped in test mode: there is no staging domain. Locally:\n" +
        "    stripe listen --forward-to localhost:3000/api/webhooks/stripe",
    );
  }

  console.log(
    `\n${tally.created} created, ${tally.updated} updated, ${tally.verified} verified, ` +
      `${tally.unreachable} not checked.`,
  );
  console.log(
    "\nStill by hand in the Dashboard: Settings → Billing → Revenue recovery → after the\n" +
      "last retry, leave the subscription PAST DUE (never cancel it).",
  );
  if (tally.unreachable > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
