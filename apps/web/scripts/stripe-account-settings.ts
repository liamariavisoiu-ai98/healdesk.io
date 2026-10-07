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
 * and, once apps/app has a public origin, the Connect webhook endpoint too:
 *
 *   STRIPE_SECRET_KEY=rk_... HEALDESK_APP_PUBLIC_URL=https://app.example \
 *     npx tsx apps/web/scripts/stripe-account-settings.ts --connect-endpoint
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
 * The payment method and the invoice history, and nothing else (build spec
 * BD15, BD29). Cancellation is OFF: auto-renew is the app's own switch in
 * Billing (apps/app `setAutoRenew`), which stamps the closing date at once
 * and handles the account that has not started its plan yet; a cancel in
 * Stripe's portal would bypass both. Plan switching is OFF too: the portal
 * cannot update a subscription that carries metered prices, and a package
 * change must swap the metered items to the new package's rates (apps/app
 * `changePlan`). There is no pause (docs/v1-product-spec.md, "What the portal
 * does not have").
 *
 * ## The Connect webhook endpoint (opt-in)
 *
 * Deposits are paid on each clinic's own connected Stripe account, and the
 * events for them come to apps/app's `/api/webhooks/stripe-connect` from a
 * separate, `connect: true` endpoint with its own signing secret
 * (`STRIPE_CONNECT_WEBHOOK_SECRET` on apps/app). It is created only with
 * `--connect-endpoint` and `HEALDESK_APP_PUBLIC_URL`, apps/app's PUBLIC origin:
 * never the marketing site (which has no such route), and https only, because
 * a Connect endpoint receives payment events for every connected account.
 *
 * ## Not settable here
 *
 * What Stripe does after the last retry of a failed payment is Dashboard-only:
 * Settings → Billing → Revenue recovery, and it must mark the subscription
 * unpaid, never cancel it (healdesk owns that transition: `unpaid` suspends
 * the clinic and Stripe attempts no further payment; see the closing notes of
 * stripe-setup.ts). Stripe Tax is off by the owner's decision of
 * 5 October 2026.
 */

import { chmodSync, existsSync, realpathSync, writeFileSync } from "node:fs";
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

/**
 * What the Connect endpoint subscribes to: the deposit Checkout Session's
 * outcomes on a clinic's account, and the clinic disconnecting us. Never
 * `invoice.created`: a connected account's own invoices wait on every
 * platform endpoint that subscribes to it, so a failing endpoint of ours
 * would stall the clinic's invoicing.
 */
export const CONNECT_WEBHOOK_EVENTS = [
  "account.application.deauthorized",
  "checkout.session.async_payment_failed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.completed",
  "checkout.session.expired",
] as const satisfies readonly Stripe.WebhookEndpointCreateParams.EnabledEvent[];

export const CONNECT_WEBHOOK_META = { healdesk: "connect-webhook" } as const;

/** Pinned, so the payloads apps/app reads cannot change shape under it. */
const CONNECT_API_VERSION = "2026-08-26.dahlia" as const;

/** The route on apps/app the Connect endpoint posts to. */
export const CONNECT_WEBHOOK_PATH = "/api/webhooks/stripe-connect";

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

export function desiredPortal(site: string): Stripe.BillingPortal.ConfigurationCreateParams {
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
      // Off: auto-renew is the app's own switch (see the header).
      subscription_cancel: { enabled: false },
      subscription_update: { enabled: false },
    },
  };
}

/**
 * Where an existing configuration differs from what we want; empty when it
 * matches. Cancellation is checked as switched off and nothing more: Stripe
 * keeps the old mode and proration on a disabled feature, and they no longer
 * mean anything.
 */
export function portalProblems(
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
  check("subscription_cancel", f.subscription_cancel.enabled, false);
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
      line("·", "configuration  would create: payment method + invoice history ON, cancellation OFF, plan switch OFF");
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
// 4. The Connect webhook endpoint (opt-in).
// ---------------------------------------------------------------------------

/**
 * The Connect endpoint's URL from apps/app's public origin, or why not
 * (R23). https only: the endpoint receives payment events for every
 * connected account. Never the marketing site: apps/web has no Connect
 * route, and an endpoint there would fail every delivery until Stripe
 * disabled it. A path prefix (apps/app mounted under one) is kept; a query,
 * a fragment or credentials are refused rather than dropped silently.
 */
export function connectEndpointUrl(
  raw: string | undefined,
  marketingSite: string = LIVE_SITE,
): { url: string } | { error: string } {
  const value = raw?.trim();
  if (!value) return { error: "HEALDESK_APP_PUBLIC_URL is not set: give apps/app's public origin." };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { error: "HEALDESK_APP_PUBLIC_URL is not a URL." };
  }
  if (parsed.protocol !== "https:") return { error: "HEALDESK_APP_PUBLIC_URL must be https." };
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { error: "HEALDESK_APP_PUBLIC_URL must be a bare origin, with no credentials, query or fragment." };
  }
  const marketing = new URL(marketingSite).hostname.replace(/^www\./, "");
  if (parsed.hostname.replace(/^www\./, "") === marketing) {
    return { error: `HEALDESK_APP_PUBLIC_URL is the marketing site (${marketing}); the Connect webhook is apps/app's.` };
  }
  return { url: `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}${CONNECT_WEBHOOK_PATH}` };
}

/** Where a new Connect endpoint's signing secret is written: the same git-ignored pattern as the platform's. */
export function connectSecretFile(live: boolean): string {
  return join(HERE, "..", `.env.stripe-connect-webhook-${live ? "live" : "test"}.local`);
}

/**
 * Where a found endpoint at our URL differs from the Connect endpoint we
 * want; empty when it matches. `connect` and the API version cannot be
 * changed on an existing endpoint, so either being wrong means deleting it
 * and running again. An endpoint this script did not create (no tag) is
 * treated the same way: it may be an account endpoint at the same URL, and
 * Stripe's object does not always say.
 */
export function connectEndpointProblems(
  endpoint: Pick<Stripe.WebhookEndpoint, "enabled_events" | "status" | "metadata"> & {
    connect?: boolean;
    api_version?: string | null;
  },
): { fatal: string[]; fixable: string[] } {
  const fatal: string[] = [];
  const fixable: string[] = [];
  if (endpoint.connect === false) fatal.push("it is an account endpoint, not a Connect one");
  if (endpoint.metadata?.healdesk !== CONNECT_WEBHOOK_META.healdesk) {
    fatal.push("it was not created by this script as the Connect endpoint");
  }
  if (endpoint.api_version && endpoint.api_version !== CONNECT_API_VERSION) {
    fatal.push(`its API version is ${endpoint.api_version}, want ${CONNECT_API_VERSION}`);
  }
  const want = [...CONNECT_WEBHOOK_EVENTS].sort();
  const have = [...endpoint.enabled_events].sort();
  if (have.length !== want.length || have.some((event, i) => event !== want[i])) {
    fixable.push(`events are [${have.join(", ")}]`);
  }
  if (endpoint.status !== "enabled") fixable.push(`status is ${endpoint.status}`);
  return { fatal, fixable };
}

async function syncConnectWebhook(stripe: Stripe, url: string, live: boolean, dryRun: boolean): Promise<void> {
  let found: Stripe.WebhookEndpoint | undefined;
  for await (const endpoint of stripe.webhookEndpoints.list({ limit: 100 })) {
    if (endpoint.url === url) {
      found = endpoint;
      break;
    }
  }

  if (!found) {
    if (dryRun) {
      line("·", `connect endpoint  would create ${url} for ${CONNECT_WEBHOOK_EVENTS.length} events (connect: true)`);
      return;
    }
    const file = connectSecretFile(live);
    if (existsSync(file)) {
      throw new Error(`${relative(process.cwd(), file)} already exists. Move it aside before creating a new endpoint.`);
    }
    const created = await stripe.webhookEndpoints.create({
      url,
      connect: true,
      api_version: CONNECT_API_VERSION,
      enabled_events: [...CONNECT_WEBHOOK_EVENTS].sort(),
      description: "healdesk: deposits on clinics' connected accounts, and disconnections",
      metadata: { ...CONNECT_WEBHOOK_META },
    });
    writeFileSync(file, `STRIPE_CONNECT_WEBHOOK_SECRET=${created.secret}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    tally.created += 1;
    line("+", `connect endpoint  ${created.id}  ${url}`);
    line(" ", `signing secret written to ${relative(process.cwd(), file)} (not printed); set it on apps/app`);
    return;
  }

  const { fatal, fixable } = connectEndpointProblems(found as Stripe.WebhookEndpoint & { connect?: boolean });
  if (fatal.length > 0) {
    tally.unreachable += 1;
    line("✗", `connect endpoint  ${found.id} at ${url} can't be used: ${fatal.join("; ")}. Delete it in the Dashboard, then run again.`);
    return;
  }
  if (fixable.length === 0) {
    tally.verified += 1;
    line("✓", `connect endpoint  ${found.id}  ${url}`);
    return;
  }
  if (dryRun) {
    line("·", `connect endpoint  ${found.id}  would update: ${fixable.join("; ")}`);
    return;
  }
  await stripe.webhookEndpoints.update(found.id, { enabled_events: [...CONNECT_WEBHOOK_EVENTS].sort(), disabled: false });
  tally.updated += 1;
  line("~", `connect endpoint  ${found.id}  updated: ${fixable.join("; ")}`);
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

  if (process.argv.includes("--connect-endpoint")) {
    const target = connectEndpointUrl(process.env.HEALDESK_APP_PUBLIC_URL);
    if ("error" in target) {
      console.log(`\nConnect webhook endpoint\n  ✗ ${target.error}`);
      tally.unreachable += 1;
    } else {
      await section("Connect webhook endpoint", "Webhook Endpoints", () =>
        syncConnectWebhook(stripe, target.url, live, dryRun),
      );
    }
  } else {
    console.log(
      "\nConnect webhook endpoint\n  · not asked for: once apps/app has a public origin, run with\n" +
        "    --connect-endpoint and HEALDESK_APP_PUBLIC_URL=<apps/app's origin>",
    );
  }

  console.log(
    `\n${tally.created} created, ${tally.updated} updated, ${tally.verified} verified, ` +
      `${tally.unreachable} not checked.`,
  );
  console.log(
    "\nStill by hand in the Dashboard: Settings → Billing → Revenue recovery → after the\n" +
      "last retry, mark the subscription UNPAID (never cancel it).",
  );
  if (tally.unreachable > 0) process.exitCode = 1;
}

/**
 * Run only when executed as a script, so a test can import the pure parts
 * above without the run starting (and asking for a key).
 */
function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
