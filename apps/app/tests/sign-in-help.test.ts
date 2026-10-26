import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { __setStripeForTests } from "@/lib/billing/stripe-client";
import { withinSignInHelpLimit } from "@/lib/connections/attempt-limit";
import type { DeliveryResult, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import {
  ACCESS_REQUEST_DAILY_CAP,
  parseSignInHelp,
  runSignInHelp,
  sameName,
} from "@/lib/sign-in/help";
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
    // No link, to anyone: the one email is I3's, to hello@.
    expect(sent.map((s) => s.to)).toEqual(["hello@healdesk.io"]);
    expect(sent[0]!.message.text).not.toMatch(/\/link\//);
    const alerts = await opsAlerts();
    expect(alerts).toEqual([
      {
        code: "no_match",
        clinicId: clinic.clinicId,
        windowStart: new Date().toISOString().slice(0, 10),
      },
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

  /**
   * Plan Part D5: "Anything else emails hello@ with structured fields" (Annex
   * X5's I3, access requests). Until 19 October 2026 an unmatched request
   * reached only HEALDESK_OPS_EMAIL, through notifyOps, and hello@, where a
   * person answers access requests, never heard.
   */
  test("an unmatched request emails hello@ the structured fields, never what was typed, replying to the account", async () => {
    const { stripe } = fakeStripe({
      cards: [{ id: "pm_2", card: { last4: "1111", exp_month: 4, exp_year: 2028 } }],
    });
    __setStripeForTests(stripe);
    const { sent, transport } = fakeTransport();
    await runSignInHelp(
      { email: clinic.staffEmail, clinic: "Somewhere Else Entirely", detail: { kind: "card", last4: "9876", expMonth: 7, expYear: 2029 } },
      {},
      { transport },
    );
    expect(sent).toHaveLength(1);
    const [{ to, message }] = sent as [Sent];
    expect(to).toBe("hello@healdesk.io");
    expect(message.subject).toBe("Sign-in help: no link was sent");
    expect(message.replyTo).toBe(clinic.staffEmail);
    expect(message.tags).toEqual([
      { name: "app", value: "app" },
      { name: "kind", value: "access_request" },
      { name: "delivery", value: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    ]);
    expect(message.idempotencyKey).toMatch(/^hd-access_request-[0-9a-f-]{36}-1$/);
    expect(message.text).toContain("the billing detail matched nothing on the account");
    expect(message.text).toContain(clinic.clinicId);
    expect(message.text).toContain("did not match the account's");
    expect(message.text).toContain("a card");
    // The ids are random and hex, so one can hold the four digits typed
    // ("...-798768288a0b"): the digits are looked for with the ids taken out.
    const UUIDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    for (const body of [message.text, message.html]) {
      expect(body).not.toContain("Somewhere");
      expect(body.replace(UUIDS, "")).not.toContain("9876");
      expect(body).not.toContain(clinic.staffEmail);
    }
    // Ops still hears, once an hour per clinic and code.
    expect((await opsAlerts()).map((a) => a.code)).toEqual(["no_match"]);
  });

  /**
   * The review of 19 October 2026: every unmatched request mailed hello@, an
   * address with no account included, under a fresh key and limits held only
   * in each process's memory, so made-up addresses from one IP could spend
   * Resend's 100 a day, which sign-in links and urgent alerts need.
   */
  test("a flood of made-up addresses mails nothing at all: the security log keeps them", async () => {
    const { transport, sent } = fakeTransport();
    for (let i = 0; i < 15; i += 1) {
      expect(
        await runSignInHelp(
          { email: `nobody${i}@nowhere.test`, clinic: "Nowhere", detail: card },
          {},
          { transport },
        ),
      ).toBe("no_account");
    }
    expect(sent).toEqual([]);
    // No alert either: the security log has each, and the digest counts them.
    expect(await opsAlerts()).toEqual([]);
    const { rows } = await getMigratorPool().query(
      `select 1 from security_events where event = 'sign_in_help_unmatched' and metadata->>'code' = 'no_account'`,
    );
    expect(rows).toHaveLength(15);
  });

  /**
   * The check of 19 October 2026: the ops alert was hourly per code, clinic
   * and whether the name typed matched, so a few requests an hour (one
   * made-up address, each known clinic's address with and without its name)
   * mailed 120 alerts a day on the Resend account sign-in links need.
   */
  test("ops hears once a UTC day per code and clinic, however the name is typed and however often", async () => {
    const { stripe } = fakeStripe({
      cards: [{ id: "pm_2", card: { last4: "1111", exp_month: 4, exp_year: 2028 } }],
    });
    __setStripeForTests(stripe);
    const { transport } = fakeTransport();
    const day = new Date("2026-10-19T00:30:00Z");
    for (let hour = 0; hour < 24; hour += 1) {
      const now = new Date(day.getTime() + hour * 60 * 60 * 1000);
      for (const name of ["help", "Somewhere Else"]) {
        await runSignInHelp({ email: clinic.staffEmail, clinic: name, detail: card }, {}, { transport, now });
      }
      await runSignInHelp({ email: `nobody${hour}@nowhere.test`, clinic: "x", detail: card }, {}, { transport, now });
    }
    expect(await opsAlerts()).toEqual([
      { code: "no_match", clinicId: clinic.clinicId, windowStart: "2026-10-19" },
    ]);
    // The next day is a new day.
    await runSignInHelp(
      { email: clinic.staffEmail, clinic: "help", detail: card },
      {},
      { transport, now: new Date("2026-10-20T09:00:00Z") },
    );
    expect((await opsAlerts()).map((a) => a.windowStart)).toEqual(["2026-10-19", "2026-10-20"]);
  });

  test("the same account twice in a day mails hello@ once, and a send that failed gives its place back", async () => {
    const { stripe } = fakeStripe({
      cards: [{ id: "pm_2", card: { last4: "1111", exp_month: 4, exp_year: 2028 } }],
    });
    __setStripeForTests(stripe);
    const failing = fakeTransport({ status: "failed", reason: "resend 500" });
    const ask = (transport: EmailTransport) =>
      runSignInHelp({ email: clinic.staffEmail, clinic: "help", detail: card }, {}, { transport });
    await ask(failing.transport);
    expect(failing.sent).toHaveLength(1);
    const { transport, sent } = fakeTransport();
    await ask(transport);
    await ask(transport);
    expect(sent.map((s) => s.to)).toEqual(["hello@healdesk.io"]);
    const { rows } = await getMigratorPool().query<{ status: string; event_id: string | null }>(
      `select status, event_id from email_events where kind = 'access_request' order by recorded_at`,
    );
    expect(rows.map((r) => r.status)).toEqual(["failed", "sent"]);
    // The claim is a digest: email_events, which holds no clinic, holds no clinic id.
    expect(rows[1]!.event_id).toMatch(/^i3\.[0-9a-f]{40}$/);
    expect(rows[1]!.event_id).not.toContain(clinic.clinicId);
  });

  test("past the day's cap hello@ gets nothing more, and ops hears once", async () => {
    const { stripe } = fakeStripe({
      cards: [{ id: "pm_2", card: { last4: "1111", exp_month: 4, exp_year: 2028 } }],
    });
    __setStripeForTests(stripe);
    const today = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < ACCESS_REQUEST_DAILY_CAP; i += 1) {
      await getMigratorPool().query(
        `insert into email_events (app, kind, status, at, event_id) values ('app', 'access_request', 'sent', now(), $1)`,
        [`i3.${randomUUID()}.no_match.${today}`],
      );
    }
    const { transport, sent } = fakeTransport();
    for (const code of ["help", "Elsewhere"]) {
      await runSignInHelp({ email: clinic.staffEmail, clinic: code, detail: card }, {}, { transport });
    }
    expect(sent).toEqual([]);
    const { rows } = await getMigratorPool().query(
      `select fields from ops_alerts where event = 'access_requests_capped'`,
    );
    expect(rows).toHaveLength(1);
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
    expect((await opsAlerts()).map((a) => a.code)).toEqual(["billing_unavailable"]);
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
