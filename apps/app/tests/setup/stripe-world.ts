import { parseLookupKey, PLAN_START_PLACEHOLDER_LOOKUP_KEY } from "@healdesk/catalog";

import { createStripeFake, stripeError, type StripeFake } from "./stripe-fake";

/**
 * A small, stateful Stripe for the billing-action tests, built on the
 * recording fake (tests/setup/stripe-fake.ts): one customer, one
 * subscription, its invoices, payments and refunds, and the catalog's prices
 * by lookup key. Updates are APPLIED to the subscription, so a retry sees
 * what the first attempt left behind, exactly as it would against Stripe —
 * which is what the marker-based retry detection needs to be tested
 * honestly. Every call is still recorded, and any path without a handler
 * still fails loudly.
 *
 * Ids are deterministic and readable: a price is `price_<lookup key>`, a
 * package's product `prod_<plan>`, a meter's `prod_meter_<meter>`.
 */

type Json = Record<string, unknown>;

/** A Stripe price object for a catalog lookup key, as `prices.list` and expanded items return it. */
export function priceFor(lookupKey: string): Json {
  if (lookupKey === PLAN_START_PLACEHOLDER_LOOKUP_KEY) {
    return {
      id: `price_${lookupKey}`,
      lookup_key: lookupKey,
      product: "prod_placeholder",
      unit_amount: 0,
      recurring: { interval: "month", usage_type: "licensed" },
    };
  }
  const meter = /^healdesk_meter_([a-z_]+?)_(\d+)$/.exec(lookupKey);
  if (meter) {
    return {
      id: `price_${lookupKey}`,
      lookup_key: lookupKey,
      product: `prod_meter_${meter[1]}`,
      unit_amount: Number(meter[2]),
      recurring: { interval: "month", usage_type: "metered" },
    };
  }
  const parsed = parseLookupKey(lookupKey);
  if (!parsed) throw new Error(`stripe-world: no price for ${lookupKey}`);
  return {
    id: `price_${lookupKey}`,
    lookup_key: lookupKey,
    product: `prod_${parsed.planId}`,
    unit_amount: parsed.cents,
    recurring: parsed.kind === "setup" ? null : { interval: parsed.kind, usage_type: "licensed" },
  };
}

function lookupKeyOfPriceId(priceId: string): string {
  if (!priceId.startsWith("price_")) throw new Error(`stripe-world: unknown price ${priceId}`);
  return priceId.slice("price_".length);
}

export type WorldItem = { lookupKey: string; quantity?: number };

export type StripeWorldOptions = {
  customerId: string;
  subscriptionId: string;
  items: WorldItem[];
  /** Unix seconds of the current period. */
  periodStart: number;
  periodEnd: number;
  customerDefaultPm?: string | null;
  subscriptionDefaultPm?: string | null;
  /** The clock for objects the world creates. Unix seconds. */
  nowSeconds?: number;
};

export type WorldInvoice = Json & {
  id: string;
  status: string;
  metadata: Record<string, string>;
  lines: { data: Json[]; has_more: boolean };
};

export function createStripeWorld(options: StripeWorldOptions) {
  const fake: StripeFake = createStripeFake();
  const now = options.nowSeconds ?? options.periodStart;
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}_w${(counter += 1)}`;

  const item = (spec: WorldItem): Json => ({
    id: nextId("si"),
    quantity:
      priceFor(spec.lookupKey).recurring &&
      (priceFor(spec.lookupKey).recurring as Json).usage_type === "metered"
        ? undefined
        : (spec.quantity ?? 1),
    current_period_start: options.periodStart,
    current_period_end: options.periodEnd,
    price: priceFor(spec.lookupKey),
  });

  const subscription: Json & {
    metadata: Record<string, string>;
    items: { data: Json[] };
  } = {
    id: options.subscriptionId,
    object: "subscription",
    status: "active",
    customer: options.customerId,
    cancel_at: null,
    cancel_at_period_end: false,
    default_payment_method: options.subscriptionDefaultPm ?? null,
    metadata: {},
    items: { data: options.items.map(item) },
    latest_invoice: null,
  };

  const state = {
    subscription,
    customer: {
      id: options.customerId,
      invoice_settings: { default_payment_method: options.customerDefaultPm ?? null },
    } as Json,
    invoices: [] as WorldInvoice[],
    refunds: [] as Json[],
    portalConfigurations: [] as Json[],
    /** The next `subscriptions.update` is declined (402), and nothing is applied. */
    declineNextUpdate: false,
    /** The next `subscriptions.update` is APPLIED and then answered with a 500: a lost response. */
    loseNextUpdateResponse: false,
    /** The next `subscriptions.update` fails with a 500 and applies nothing. */
    failNextUpdate: false,
    /** The next `invoices.pay` is declined. */
    declineNextPay: false,
    /** The next `invoices.create` fails with a 500 and creates nothing. */
    failNextInvoiceCreate: false,
  };

  function applyUpdate(params: Json): void {
    const items = (params.items as Json[] | undefined) ?? [];
    for (const change of items) {
      if (change.deleted === true) {
        subscription.items.data = subscription.items.data.filter((i) => i.id !== change.id);
        continue;
      }
      if (typeof change.id === "string") {
        const existing = subscription.items.data.find((i) => i.id === change.id);
        if (!existing) throw new Error(`stripe-world: no item ${change.id}`);
        if (typeof change.price === "string") {
          existing.price = priceFor(lookupKeyOfPriceId(change.price));
          // Stripe resets the quantity to 1 on a price change without one.
          existing.quantity = typeof change.quantity === "number" ? change.quantity : 1;
        } else if (typeof change.quantity === "number") {
          existing.quantity = change.quantity;
        }
        continue;
      }
      subscription.items.data.push(
        item({
          lookupKey: lookupKeyOfPriceId(change.price as string),
          quantity: change.quantity as number | undefined,
        }),
      );
    }
    if (params.metadata && typeof params.metadata === "object") {
      // Stripe merges metadata keys, and an empty value unsets one.
      for (const [key, value] of Object.entries(params.metadata as Record<string, string>)) {
        if (value === "") delete subscription.metadata[key];
        else subscription.metadata[key] = value;
      }
    }
    if (typeof params.cancel_at_period_end === "boolean") {
      subscription.cancel_at_period_end = params.cancel_at_period_end;
      subscription.cancel_at = params.cancel_at_period_end ? options.periodEnd : null;
    }
    if (params.cancel_at === "") subscription.cancel_at = null;
    if (params.proration_behavior === "always_invoice") {
      const invoice = makeInvoice({
        billing_reason: "subscription_update",
        status: "paid",
        subscription: subscription.id,
        metadata: {},
      });
      subscription.latest_invoice = invoice;
    }
  }

  function makeInvoice(fields: Json): WorldInvoice {
    const id = nextId("in");
    const invoice: WorldInvoice = {
      id,
      object: "invoice",
      customer: options.customerId,
      created: now,
      status: "draft",
      metadata: {},
      lines: { data: [], has_more: false },
      amount_due: 0,
      amount_paid: 0,
      total: 0,
      hosted_invoice_url: null,
      ...fields,
    } as WorldInvoice;
    if (invoice.status !== "draft")
      invoice.hosted_invoice_url = `https://invoice.stripe.com/i/${id}`;
    state.invoices.unshift(invoice);
    return invoice;
  }

  const invoiceById = (id: string) => {
    const found = state.invoices.find((invoice) => invoice.id === id);
    if (!found) throw new Error(`stripe-world: no invoice ${id}`);
    return found;
  };

  const snapshot = () => JSON.parse(JSON.stringify(subscription));

  fake.on("prices.list", (params) => {
    const keys = (params as { lookup_keys: string[] }).lookup_keys;
    return { data: keys.map((key) => priceFor(key)), has_more: false };
  });
  fake.on("subscriptions.retrieve", () => snapshot());
  fake.on("subscriptions.update", (_id, params) => {
    if (state.declineNextUpdate) {
      state.declineNextUpdate = false;
      throw stripeError("card", { code: "card_declined" });
    }
    if (state.failNextUpdate) {
      state.failNextUpdate = false;
      throw stripeError("api", { statusCode: 500 });
    }
    applyUpdate(params as Json);
    if (state.loseNextUpdateResponse) {
      state.loseNextUpdateResponse = false;
      throw stripeError("api", { statusCode: 500 });
    }
    return snapshot();
  });
  fake.on("customers.retrieve", () => JSON.parse(JSON.stringify(state.customer)));
  fake.on("invoices.list", (params) => {
    const p = params as { customer?: string; subscription?: string; status?: string };
    const data = state.invoices.filter(
      (invoice) =>
        (!p.subscription || invoice.subscription === p.subscription) &&
        (!p.status || invoice.status === p.status),
    );
    return { data: JSON.parse(JSON.stringify(data)), has_more: false };
  });
  fake.on("invoices.retrieve", (id) => JSON.parse(JSON.stringify(invoiceById(id as string))));
  fake.on("invoices.create", (params) => {
    if (state.failNextInvoiceCreate) {
      state.failNextInvoiceCreate = false;
      throw stripeError("api", { statusCode: 500 });
    }
    const p = params as Json;
    return JSON.parse(
      JSON.stringify(
        makeInvoice({
          status: "draft",
          metadata: (p.metadata as Record<string, string>) ?? {},
          default_payment_method: p.default_payment_method ?? null,
        }),
      ),
    );
  });
  fake.on("invoiceItems.create", (params) => {
    const p = params as Json & {
      invoice: string;
      quantity?: number;
      price_data?: { unit_amount: number; product: string };
      pricing?: { price: string };
      metadata?: Record<string, string>;
    };
    const invoice = invoiceById(p.invoice);
    const unit = p.price_data
      ? p.price_data.unit_amount
      : (priceFor(lookupKeyOfPriceId(p.pricing!.price)).unit_amount as number);
    const amount = unit * (p.quantity ?? 1);
    invoice.lines.data.push({
      id: nextId("il"),
      amount,
      metadata: p.metadata ?? {},
      parent: { type: "invoice_item_details" },
    });
    invoice.total = (invoice.total as number) + amount;
    invoice.amount_due = invoice.total;
    return { id: nextId("ii"), invoice: invoice.id, amount };
  });
  fake.on("invoices.finalizeInvoice", (id) => {
    const invoice = invoiceById(id as string);
    invoice.status = (invoice.total as number) === 0 ? "paid" : "open";
    invoice.hosted_invoice_url = `https://invoice.stripe.com/i/${invoice.id}`;
    return JSON.parse(JSON.stringify(invoice));
  });
  fake.on("invoices.pay", (id) => {
    const invoice = invoiceById(id as string);
    if (state.declineNextPay) {
      state.declineNextPay = false;
      throw stripeError("card", { code: "card_declined" });
    }
    invoice.status = "paid";
    invoice.amount_paid = invoice.amount_due;
    return JSON.parse(JSON.stringify(invoice));
  });
  fake.on("invoices.voidInvoice", (id) => {
    const invoice = invoiceById(id as string);
    invoice.status = "void";
    return JSON.parse(JSON.stringify(invoice));
  });
  fake.on("invoices.listLineItems", (id) => {
    const invoice = invoiceById(id as string);
    return { data: JSON.parse(JSON.stringify(invoice.lines.data)), has_more: false };
  });
  fake.on("invoicePayments.list", (params) => {
    const invoice = invoiceById((params as { invoice: string }).invoice);
    return invoice.status === "paid"
      ? { data: [{ payment: { type: "payment_intent", payment_intent: `pi_${invoice.id}` } }] }
      : { data: [] };
  });
  fake.on("refunds.list", (params) => {
    const pi = (params as { payment_intent: string }).payment_intent;
    return { data: state.refunds.filter((refund) => refund.payment_intent === pi) };
  });
  fake.on("refunds.create", (params) => {
    const p = params as Json;
    const refund = {
      id: nextId("re"),
      object: "refund",
      payment_intent: p.payment_intent,
      amount: p.amount,
      status: "succeeded",
      metadata: p.metadata ?? {},
    };
    state.refunds.push(refund);
    return refund;
  });
  fake.on("billingPortal.configurations.list", () => ({
    data: state.portalConfigurations,
    has_more: false,
  }));
  fake.on("billingPortal.sessions.create", () => ({
    id: nextId("bps"),
    url: "https://billing.stripe.com/p/session/test_w",
  }));

  /**
   * A paid subscription invoice, as Stripe would have raised it: lines whose
   * prices arrive expanded (listLineItems is asked to expand them).
   */
  function addPaidSubscriptionInvoice(input: {
    created: number;
    billingReason?: string;
    lines: Array<{
      lookupKey?: string;
      amount: number;
      periodStart: number;
      periodEnd: number;
      proration?: boolean;
      /** A one-off line (a setup fee): an invoice item, not a subscription item. */
      oneOff?: boolean;
    }>;
  }): WorldInvoice {
    const total = input.lines.reduce((sum, line) => sum + line.amount, 0);
    return makeInvoice({
      status: "paid",
      created: input.created,
      billing_reason: input.billingReason ?? "subscription_update",
      subscription: subscription.id,
      total,
      amount_due: total,
      amount_paid: total,
      lines: {
        has_more: false,
        data: input.lines.map((line) => ({
          id: nextId("il"),
          amount: line.amount,
          discount_amounts: [],
          period: { start: line.periodStart, end: line.periodEnd },
          parent: line.oneOff
            ? { type: "invoice_item_details", invoice_item_details: { proration: false } }
            : {
                type: "subscription_item_details",
                subscription_item_details: { proration: line.proration === true },
              },
          pricing: line.lookupKey ? { price_details: { price: priceFor(line.lookupKey) } } : null,
        })),
      },
    });
  }

  /** Any invoice, as an earlier attempt (or a person in the Dashboard) left it. */
  function addInvoice(fields: Json): WorldInvoice {
    return makeInvoice(fields);
  }

  return { fake, stripe: fake.stripe, state, addPaidSubscriptionInvoice, addInvoice, priceFor };
}

export type StripeWorld = ReturnType<typeof createStripeWorld>;

/** Every recorded call's arguments, flattened, to assert a parameter was never sent. */
export function everyParam(fake: StripeFake): string {
  return JSON.stringify(fake.calls.map((call) => call.args));
}
