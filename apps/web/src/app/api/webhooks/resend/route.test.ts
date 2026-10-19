import { createHmac } from "node:crypto";

import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verify } from "@healdesk/catalog";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ markDeliveryFailure: vi.fn() }));
vi.mock("@/lib/leads", () => ({ markDeliveryFailure: mocks.markDeliveryFailure }));

import { POST, verifySvix } from "./route";

const SECRET = "whsec_" + Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

function sign(id: string, ts: number, body: string, secret = SECRET): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return "v1," + createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
}

describe("Resend (Svix) signature verification", () => {
  const body = JSON.stringify({ type: "email.bounced", data: { to: ["a@b.test"] } });
  const now = 1_800_000_000_000;
  const ts = Math.floor(now / 1000);

  test("accepts a correctly signed, fresh delivery", () => {
    const headers = new Headers({
      "webhook-id": "msg_1",
      "webhook-timestamp": String(ts),
      "webhook-signature": `v0,garbage ${sign("msg_1", ts, body)}`,
    });
    expect(verifySvix(headers, body, SECRET, now)).toBe(true);
  });

  test("accepts the svix-* headers Resend documents, and prefers them", () => {
    const headers = new Headers({
      "svix-id": "msg_1",
      "svix-timestamp": String(ts),
      "svix-signature": sign("msg_1", ts, body),
      // A stale unbranded copy must not be what gets checked.
      "webhook-id": "msg_old",
      "webhook-timestamp": String(ts - 3600),
      "webhook-signature": "v1,garbage",
    });
    expect(verifySvix(headers, body, SECRET, now)).toBe(true);
  });

  test("rejects a wrong secret, a tampered body, and a stale timestamp", () => {
    const good = sign("msg_1", ts, body);
    expect(
      verifySvix(new Headers({ "webhook-id": "msg_1", "webhook-timestamp": String(ts), "webhook-signature": good }), body + " ", SECRET, now),
    ).toBe(false);
    expect(
      verifySvix(new Headers({ "webhook-id": "msg_1", "webhook-timestamp": String(ts), "webhook-signature": good }), body, "whsec_" + Buffer.from("x".repeat(32)).toString("base64"), now),
    ).toBe(false);
    const old = ts - 10 * 60;
    expect(
      verifySvix(new Headers({ "webhook-id": "msg_1", "webhook-timestamp": String(old), "webhook-signature": sign("msg_1", old, body) }), body, SECRET, now),
    ).toBe(false);
  });
});

/**
 * One webhook, two apps (Annex X3). apps/app's mail is tagged app=app, and its
 * events are relayed to apps/app as the signed ops operation `emailEvent`,
 * carrying the type, the timestamp and apps/app's own tags, and nothing else
 * from Resend's payload. This site's own mail is handled here, as before.
 * apps/app's half (the ledger update) is tested in apps/app/tests/email-relay.test.ts.
 */
describe("the relay to apps/app", () => {
  const CLINIC = "0c1d2e3f-0000-4000-8000-000000000000";
  const DELIVERY = "5f0e4a1b-1111-4222-8333-444455556666";
  const PROVISION_SECRET = "provision-secret-for-tests";
  const fetchMock = vi.fn();
  const saved: Record<string, string | undefined> = {};
  const ENV = ["RESEND_WEBHOOK_SECRET", "HEALDESK_PROVISION_SECRET", "HEALDESK_APP_URL"] as const;

  beforeEach(() => {
    for (const key of ENV) saved[key] = process.env[key];
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    process.env.HEALDESK_PROVISION_SECRET = PROVISION_SECRET;
    process.env.HEALDESK_APP_URL = "https://app.internal.test";
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { recorded: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    mocks.markDeliveryFailure.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const key of ENV) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function delivery(event: unknown): Request {
    const body = JSON.stringify(event);
    const ts = Math.floor(Date.now() / 1000);
    return new Request("https://healdesk.test/api/webhooks/resend", {
      method: "POST",
      headers: {
        "svix-id": "msg_1",
        "svix-timestamp": String(ts),
        "svix-signature": sign("msg_1", ts, body),
      },
      body,
    });
  }

  function appEvent(type: string, extra: Record<string, unknown> = {}, tags: unknown = undefined) {
    return {
      type,
      created_at: "2026-10-06T15:00:00.000Z",
      data: {
        to: ["owner@radiance.test"],
        from: "healdesk <hello@healdesk.io>",
        subject: "Your payment did not go through",
        tags: tags ?? { app: "app", kind: "payment_failed", clinic: CLINIC, delivery: DELIVERY },
        ...extra,
      },
    };
  }

  /** The signed body apps/app received, after checking its signature as apps/app does. */
  function relayed(): Record<string, unknown> {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [URL, RequestInit];
    expect(String(url)).toBe("https://app.internal.test/api/ops");
    const headers = init.headers as Record<string, string>;
    const body = String(init.body);
    const signed = verify(body, headers[TIMESTAMP_HEADER]!, headers[SIGNATURE_HEADER]!, PROVISION_SECRET);
    expect(signed.ok).toBe(true);
    return JSON.parse(body) as Record<string, unknown>;
  }

  test("an app=app bounce is relayed, signed, with the type, the time and the tags", async () => {
    const event = appEvent("email.bounced", { bounce: { type: "Permanent" } });
    const response = await POST(delivery(event));
    expect(response.status).toBe(200);
    const body = relayed();
    expect(body).toEqual({
      op: "emailEvent",
      args: {
        type: "bounced",
        at: "2026-10-06T15:00:00.000Z",
        clinic: CLINIC,
        delivery: DELIVERY,
        kind: "payment_failed",
        eventId: "msg_1",
      },
    });
    // No browser behind it, so no context, and nothing of Resend's payload.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("owner@radiance.test");
    expect(raw).not.toContain("Your payment");
    expect(raw).not.toContain("hello@healdesk.io");
    expect(mocks.markDeliveryFailure).not.toHaveBeenCalled();
  });

  test("a soft bounce is relayed as delayed, never as bounced", async () => {
    await POST(delivery(appEvent("email.bounced", { bounce: { type: "Transient" } })));
    expect((relayed().args as Record<string, unknown>).type).toBe("delayed");
  });

  for (const [resendType, ledgerType] of [
    ["email.sent", "sent"],
    ["email.delivered", "delivered"],
    ["email.delivery_delayed", "delayed"],
    ["email.complained", "complained"],
    ["email.suppressed", "suppressed"],
  ] as const) {
    test(`${resendType} is relayed as ${ledgerType}`, async () => {
      await POST(delivery(appEvent(resendType)));
      expect((relayed().args as Record<string, unknown>).type).toBe(ledgerType);
    });
  }

  test("tags in the array form are read too, and a tag that is not an id is dropped", async () => {
    await POST(
      delivery(
        appEvent("email.delivered", {}, [
          { name: "app", value: "app" },
          { name: "kind", value: "ops_alert" },
          { name: "clinic", value: "owner@radiance.test" },
          { name: "delivery", value: DELIVERY },
        ]),
      ),
    );
    expect(relayed().args).toEqual({
      type: "delivered",
      at: "2026-10-06T15:00:00.000Z",
      delivery: DELIVERY,
      kind: "ops_alert",
      eventId: "msg_1",
    });
  });

  test("an event the ledger does not record is acknowledged and not relayed", async () => {
    const response = await POST(delivery(appEvent("email.opened")));
    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("when apps/app cannot take it, Resend is told to retry", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 500 }));
    const response = await POST(delivery(appEvent("email.delivered")));
    expect(response.status).toBe(503);
  });

  /**
   * The ops digest's email health is read in apps/app, which never sends this
   * site's mail, so until 19 October 2026 it left out nurture, the setup links
   * and P2 to P9, while Resend pauses the whole account at 0.08% complaints.
   */
  test("this site's own mail is handled here, then counted in apps/app: type, time, kind and the delivery's id only", async () => {
    const response = await POST(
      delivery({
        type: "email.complained",
        created_at: "2026-10-06T15:00:00.000Z",
        data: {
          to: ["lead@clinic.test"],
          subject: "Still thinking it over?",
          tags: { app: "web", kind: "setup-link" },
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.markDeliveryFailure).toHaveBeenCalledWith("lead@clinic.test", "complaint");
    const body = relayed();
    expect(body).toEqual({
      op: "emailEvent",
      args: {
        type: "complained",
        at: "2026-10-06T15:00:00.000Z",
        kind: "setup_link",
        app: "web",
        eventId: "msg_1",
      },
    });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("lead@clinic.test");
    expect(raw).not.toContain("Still thinking");
  });

  test("a count apps/app cannot take never fails the delivery: the lead is already marked", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue(new Response("{}", { status: 503 }));
    const response = await POST(
      delivery({ type: "email.bounced", data: { to: ["lead@clinic.test"], tags: { app: "web", kind: "nurture" } } }),
    );
    expect(response.status).toBe(200);
    expect(mocks.markDeliveryFailure).toHaveBeenCalledWith("lead@clinic.test", "bounce");
  });

  test("only what the digest counts is handed on: a delivery or an open is not, and untagged mail is counted as untagged", async () => {
    for (const type of ["email.delivered", "email.opened", "email.delivery_delayed"]) {
      await POST(delivery({ type, data: { to: ["lead@clinic.test"], tags: { app: "web", kind: "nurture" } } }));
    }
    expect(fetchMock).not.toHaveBeenCalled();
    await POST(delivery({ type: "email.sent", data: { to: ["lead@clinic.test"] } }));
    expect((relayed().args as Record<string, unknown>).kind).toBe("untagged");
  });
});
