import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { __setStripeForTests } from "@/lib/billing/stripe-client";
import { withinSignInHelpLimit } from "@/lib/connections/attempt-limit";
import type { DeliveryResult, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { parseSignInHelp, runSignInHelp, sameName } from "@/lib/sign-in/help";
import { consumeSignInLink } from "@/lib/sign-in/links";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { seedClinic, seedEntitled, type SeededClinic } from "./setup/factories";

/**
 * /sign-in/help, "I can't get in" (plan Part D5): a billing detail checked
 * against Stripe on the server; on a match O6 goes to the address already on
 * the account and nowhere else; anything else sends no link and tells ops in
 * structured fields; and the page answers every well-formed request the same
 * way, before any of it runs.
 */

const after = vi.hoisted(() => ({ queued: [] as (() => Promise<void>)[] }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => Promise<void>) => {
    after.queued.push(fn);
  },
}));
vi.mock("@/lib/session", () => ({
  requestMeta: async () => ({ requestId: "req_1", ipAddress: "203.0.113.9", userAgent: "test" }),
}));

const describeDb = hasTestDatabase ? describe : describe.skip;
const ORIGIN = "https://app.healdesk.test";

type Sent = { to: string; message: OutgoingEmail };

function fakeTransport(result: DeliveryResult = { status: "sent", messageId: "msg_1" }) {
  const sent: Sent[] = [];
  const transport: EmailTransport = {
    name: "fake",
    send: async (target, message) => {
      sent.push({ to: target.to, message });
      return result;
    },
  };
  return { sent, transport };
}

const CARD = { id: "pm_1", card: { last4: "4242", exp_month: 4, exp_year: 2028 } };

function fakeStripe(options: { cards?: unknown[]; invoices?: unknown[]; fail?: boolean } = {}) {
  const asked: { what: string; customer: string }[] = [];
  const stripe = {
    paymentMethods: {
      list: async (params: { customer: string }) => {
        if (options.fail) throw new Error("Stripe is down");
        asked.push({ what: "cards", customer: params.customer });
        return { data: options.cards ?? [CARD] };
      },
    },
    invoices: {
      list: async (params: { customer: string }) => {
        if (options.fail) throw new Error("Stripe is down");
        asked.push({ what: "invoices", customer: params.customer });
        return { data: options.invoices ?? [{ id: "in_1", number: "ABCD1234-0001" }] };
      },
    },
  };
  return { stripe, asked };
}

const SAVED: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ["BETTER_AUTH_URL", "BETTER_AUTH_SECRET"]) SAVED[key] = process.env[key];
  process.env.BETTER_AUTH_URL = ORIGIN;
  process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-tests";
  after.queued.length = 0;
});

afterEach(() => {
  __setStripeForTests(null);
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete (process.env as Record<string, string | undefined>)[key];
    else (process.env as Record<string, string>)[key] = value;
  }
});

describe("what the form accepts, by shape alone", () => {
  test("a card's last four and its expiry, or an invoice number", () => {
    expect(
      parseSignInHelp({
        email: " Info@Glow.test ",
        clinic: "Glow Med Spa",
        kind: "card",
        last4: "4242",
        expiry: "04/28",
      }),
    ).toEqual({
      ok: true,
      request: {
        email: "info@glow.test",
        clinic: "Glow Med Spa",
        detail: { kind: "card", last4: "4242", expMonth: 4, expYear: 2028 },
      },
    });
    expect(
      parseSignInHelp({
        email: "info@glow.test",
        clinic: "Glow",
        kind: "card",
        last4: "4242",
        expiry: "4/2029",
      }),
    ).toMatchObject({ ok: true, request: { detail: { expMonth: 4, expYear: 2029 } } });
    expect(
      parseSignInHelp({
        email: "info@glow.test",
        clinic: "Glow",
        kind: "invoice",
        invoice: "ABCD1234-0001",
      }),
    ).toMatchObject({
      ok: true,
      request: { detail: { kind: "invoice", number: "ABCD1234-0001" } },
    });
  });

  test("refuses what could not be a detail, naming the field", () => {
    const base = { email: "info@glow.test", clinic: "Glow" };
    expect(parseSignInHelp({ ...base, email: "nope", kind: "card" })).toMatchObject({
      ok: false,
      field: "email",
    });
    expect(parseSignInHelp({ ...base, clinic: "", kind: "card" })).toMatchObject({
      ok: false,
      field: "clinic",
    });
    for (const card of [
      { last4: "424", expiry: "04/28" },
      { last4: "4242", expiry: "13/28" },
      { last4: "4242", expiry: "0428" },
      { last4: "4242 4242 4242 4242", expiry: "04/28" },
    ]) {
      expect(
        parseSignInHelp({ ...base, kind: "card", ...card }),
        JSON.stringify(card),
      ).toMatchObject({
        ok: false,
        field: "detail",
      });
    }
    expect(parseSignInHelp({ ...base, kind: "invoice", invoice: "anything at all" })).toMatchObject(
      {
        ok: false,
        field: "detail",
      },
    );
    expect(parseSignInHelp({ ...base, kind: "phone" })).toMatchObject({
      ok: false,
      field: "detail",
    });
  });

  test("a clinic's name matches loosely, either way round", () => {
    expect(sameName("Glow Med Spa LLC", "glow med spa")).toBe(true);
    expect(sameName("Glow", "The Glow Clinic")).toBe(true);
    expect(sameName("Glow Med Spa", "Radiance")).toBe(false);
  });

  test("three a ten minutes per inbox, ten per client, counted whether or not an account exists", () => {
    const inbox = `limit-${Date.now()}@glow.test`;
    expect([1, 2, 3, 4].map(() => withinSignInHelpLimit(inbox, null))).toEqual([
      true,
      true,
      true,
      false,
    ]);
    const ip = `198.51.100.${Date.now() % 250}`;
    const results = Array.from({ length: 11 }, (_, i) =>
      withinSignInHelpLimit(`walk-${i}-${Date.now()}@glow.test`, ip),
    );
    expect(results.filter(Boolean)).toHaveLength(10);
  });
});

describeDb("/sign-in/help", () => {
  let clinic: SeededClinic;
  let customerId: string;

  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
    // The ops log is not a clinic table, so truncateAll leaves it.
    await getMigratorPool().query(`delete from ops_alerts`);
    clinic = await seedClinic("help");
    customerId = (await seedEntitled(clinic.clinicId)).stripeCustomerId!;
  });

  afterAll(async () => {
    await closePools();
  });

  async function opsAlerts() {
    const { rows } = await getMigratorPool().query<{ fields: Record<string, unknown> }>(
      `select fields from ops_alerts where event = 'sign_in_help_unmatched' order by raised_at`,
    );
    return rows.map((r) => r.fields);
  }

  const card = { kind: "card" as const, last4: "4242", expMonth: 4, expYear: 2028 };

  test("a matching card: O6 to the address on the account, with a link that signs in", async () => {
    const { stripe, asked } = fakeStripe();
    __setStripeForTests(stripe);
    const { sent, transport } = fakeTransport();
    const outcome = await runSignInHelp(
      { email: clinic.staffEmail, clinic: "help Clinic", detail: card },
      {},
      { transport },
    );
    expect(outcome).toBe("sent");
    expect(asked).toEqual([{ what: "cards", customer: customerId }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(clinic.staffEmail);
    expect(sent[0]!.message.tags).toContainEqual({ name: "kind", value: "sign_in_help_link" });
    const token = new RegExp(`${ORIGIN.replace(/\./g, "\\.")}/link/([A-Za-z0-9_-]{43})`).exec(
      sent[0]!.message.text,
    )![1]!;
    expect(await consumeSignInLink(token, null)).toMatchObject({
      ok: true,
      userId: clinic.staffUserId,
    });
    expect(await opsAlerts()).toEqual([]);
  });

  test("a matching invoice number, in any case", async () => {
    const { stripe } = fakeStripe();
    __setStripeForTests(stripe);
    const { sent, transport } = fakeTransport();
    expect(
      await runSignInHelp(
        {
          email: clinic.staffEmail,
          clinic: "help",
          detail: { kind: "invoice", number: "abcd1234-0001" },
        },
        {},
        { transport },
      ),
    ).toBe("sent");
    expect(sent).toHaveLength(1);
  });

  test("no match: no link, and ops hear in structured fields, never what was typed", async () => {
    const { stripe } = fakeStripe({
      cards: [{ id: "pm_2", card: { last4: "1111", exp_month: 4, exp_year: 2028 } }],
    });
    __setStripeForTests(stripe);
    const { sent, transport } = fakeTransport();
    expect(
      await runSignInHelp(
        { email: clinic.staffEmail, clinic: "Somewhere Else Entirely", detail: card },
        {},
        { transport },
      ),
    ).toBe("no_match");
    expect(sent).toEqual([]);
    const alerts = await opsAlerts();
    expect(alerts).toEqual([
      { code: "no_match", clinicId: clinic.clinicId, signal: "clinic_not_named" },
    ]);
    expect(JSON.stringify(alerts)).not.toContain("Somewhere");
    const { rows } = await getMigratorPool().query<{
      metadata: Record<string, unknown>;
      ip: string;
    }>(
      `select metadata, ip_address as ip from security_events where event = 'sign_in_help_unmatched'`,
    );
    expect(rows[0]!.metadata).toEqual({
      code: "no_match",
      clinicId: clinic.clinicId,
      signal: "clinic_not_named",
    });
  });

  test("an address with no account, and Stripe unreachable: no link either way", async () => {
    const { stripe } = fakeStripe({ fail: true });
    __setStripeForTests(stripe);
    const { transport } = fakeTransport();
    expect(
      await runSignInHelp(
        { email: "nobody@nowhere.test", clinic: "Nowhere", detail: card },
        {},
        { transport },
      ),
    ).toBe("no_account");
    expect(
      await runSignInHelp(
        { email: clinic.staffEmail, clinic: "help", detail: card },
        {},
        { transport },
      ),
    ).toBe("billing_unavailable");
    expect((await opsAlerts()).map((a) => a.code)).toEqual(["no_account", "billing_unavailable"]);
  });

  test("the page's answer is the same whether or not the address has an account, and nothing runs before it", async () => {
    const { requestSignInHelp } = await import("@/app/sign-in/help/actions");
    const form = (email: string) => {
      const data = new FormData();
      data.set("email", email);
      data.set("clinic", "help Clinic");
      data.set("kind", "card");
      data.set("last4", "4242");
      data.set("expiry", "04/28");
      return data;
    };
    const known = await requestSignInHelp({ status: "idle" }, form(clinic.staffEmail));
    const unknown = await requestSignInHelp({ status: "idle" }, form("nobody-else@nowhere.test"));
    expect(known).toEqual({ status: "received" });
    expect(unknown).toEqual(known);
    expect(after.queued).toHaveLength(2);
    const { rows } = await getMigratorPool().query<{ n: number }>(
      `select count(*)::int as n from sign_in_links`,
    );
    expect(rows[0]!.n).toBe(0);

    const bad = new FormData();
    bad.set("email", "info@glow.test");
    bad.set("clinic", "Glow");
    bad.set("kind", "card");
    bad.set("last4", "12");
    expect(await requestSignInHelp({ status: "idle" }, bad)).toMatchObject({
      status: "invalid",
      field: "detail",
    });
  });
});
