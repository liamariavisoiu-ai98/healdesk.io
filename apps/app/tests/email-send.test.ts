import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { LinkNotAllowedError } from "@/lib/email/lint";
import {
  EmailEnvelopeError,
  platformTransport,
  sendEmail,
  type EmailToSend,
} from "@/lib/email/send";
import type { DeliveryTarget, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { PhiRoutingError } from "@/lib/reporting/resend-transport";

/**
 * sendEmail(), the one door (lib/email/send.ts): the class gate, the tags, the
 * reply-to, the link scanner and the transport the environment names. The
 * Resend SDK is stubbed, so what the stub receives is what would go out.
 */

const resendSend = vi.fn();

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));

class FakeTransport implements EmailTransport {
  readonly name = "fake";
  readonly calls: { target: DeliveryTarget; message: OutgoingEmail }[] = [];
  async send(target: DeliveryTarget, message: OutgoingEmail) {
    this.calls.push({ target, message });
    return { status: "sent" as const, messageId: "msg_fake" };
  }
}

const CLINIC = "0c1d2e3f-0000-4000-8000-000000000000";
const DELIVERY = "5f0e4a1b-1111-4222-8333-444455556666";

function email(overrides: Partial<EmailToSend> = {}): EmailToSend {
  return {
    to: "desk@radiance.test",
    kind: "payment_failed",
    subject: "Your payment did not go through",
    text: "Open Billing: https://app.healdesk.test/c/radiance/billing",
    html: '<p><a href="https://app.healdesk.test/c/radiance/billing">Open Billing</a></p>',
    phiClass: "none",
    clinicId: CLINIC,
    deliveryId: DELIVERY,
    idempotencyKey: `hd-payment_failed-${DELIVERY}-1`,
    ...overrides,
  };
}

const SAVED: Record<string, string | undefined> = {};
const ENV = [
  "HEALDESK_EMAIL_TRANSPORT",
  "RESEND_API_KEY",
  "HEALDESK_EMAIL_FROM",
  "BETTER_AUTH_URL",
  "NODE_ENV",
] as const;
let keys = 0;

beforeEach(() => {
  for (const key of ENV) SAVED[key] = process.env[key];
  delete process.env.HEALDESK_EMAIL_TRANSPORT;
  process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
  resendSend.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV) {
    const value = SAVED[key];
    if (value === undefined) delete (process.env as Record<string, string | undefined>)[key];
    else (process.env as Record<string, string>)[key] = value;
  }
});

describe("what sendEmail refuses before any transport is asked", () => {
  test("anything not classed none: Resend signs no business associate agreement", async () => {
    const transport = new FakeTransport();
    await expect(
      sendEmail(email({ phiClass: "may-carry-phi" }), { transport }),
    ).rejects.toBeInstanceOf(PhiRoutingError);
    expect(transport.calls).toHaveLength(0);
  });

  test("an address in a tag, or an idempotency key that is not ids", async () => {
    const transport = new FakeTransport();
    await expect(
      sendEmail(email({ clinicId: "owner@radiance.test" }), { transport }),
    ).rejects.toBeInstanceOf(EmailEnvelopeError);
    await expect(
      sendEmail(email({ idempotencyKey: "hd-payment_failed-owner@radiance.test-1" }), {
        transport,
      }),
    ).rejects.toBeInstanceOf(EmailEnvelopeError);
    await expect(
      sendEmail(email({ kind: "Payment Failed" }), { transport }),
    ).rejects.toBeInstanceOf(EmailEnvelopeError);
    expect(transport.calls).toHaveLength(0);
  });

  test("a link to anywhere but our public origin, in the body or a header", async () => {
    const transport = new FakeTransport();
    await expect(
      sendEmail(email({ html: '<a href="https://evil.example/x">x</a>' }), { transport }),
    ).rejects.toBeInstanceOf(LinkNotAllowedError);
    process.env.HEALDESK_APP_URL = "https://internal.healdesk.test";
    try {
      await expect(
        sendEmail(email({ text: "https://internal.healdesk.test/api/ops" }), { transport }),
      ).rejects.toBeInstanceOf(LinkNotAllowedError);
    } finally {
      delete process.env.HEALDESK_APP_URL;
    }
    await expect(
      sendEmail(email({ headers: { "List-Unsubscribe": "<https://evil.example/stop>" } }), {
        transport,
      }),
    ).rejects.toBeInstanceOf(LinkNotAllowedError);
    expect(transport.calls).toHaveLength(0);
  });
});

describe("what sendEmail adds", () => {
  test("app=app, the kind, the clinic and the ledger row as tags; replies to hello@", async () => {
    const transport = new FakeTransport();
    expect(await sendEmail(email(), { transport })).toEqual({
      status: "sent",
      messageId: "msg_fake",
    });
    const { message } = transport.calls[0]!;
    expect(message.tags).toEqual([
      { name: "app", value: "app" },
      { name: "kind", value: "payment_failed" },
      { name: "clinic", value: CLINIC },
      { name: "delivery", value: DELIVERY },
    ]);
    expect(message.replyTo).toBe("hello@healdesk.io");
    expect(message.idempotencyKey).toBe(`hd-payment_failed-${DELIVERY}-1`);
    expect(message.phiClass).toBe("none");
  });

  test("mail with no clinic carries no clinic tag; a caller may name another reply-to", async () => {
    const transport = new FakeTransport();
    await sendEmail(email({ kind: "ops_alert", clinicId: null, replyTo: "ops@healdesk.test" }), {
      transport,
    });
    const { message } = transport.calls[0]!;
    expect(message.tags?.map((t) => t.name)).toEqual(["app", "kind", "delivery"]);
    expect(message.replyTo).toBe("ops@healdesk.test");
  });
});

describe("the transport the environment names", () => {
  test("the console stub when none is set, which says nothing was sent", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    expect(platformTransport().name).toBe("console");
    const result = await sendEmail(email());
    expect(result.status).toBe("skipped");
  });

  test("the console stub refuses to run in production", async () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    await expect(sendEmail(email())).rejects.toThrow(/must never run in production/);
  });

  test("Resend when HEALDESK_EMAIL_TRANSPORT=resend: tags, reply-to, headers and the idempotency key go on the wire", async () => {
    process.env.HEALDESK_EMAIL_TRANSPORT = "resend";
    process.env.RESEND_API_KEY = `re_stub_send_${keys++}`;
    process.env.HEALDESK_EMAIL_FROM = "healdesk <hello@healdesk.io>";
    resendSend.mockResolvedValue({
      data: { id: "msg_resend" },
      error: null,
      headers: { "x-resend-daily-quota": "12" },
    });
    expect(platformTransport().name).toBe("resend");

    // An optional kind, so its stop link is allowed (the scanner refuses one
    // anywhere else).
    const result = await sendEmail(
      email({
        kind: "usage_80",
        idempotencyKey: `hd-usage_80-${DELIVERY}-1`,
        headers: { "List-Unsubscribe": "<https://app.healdesk.test/email/stop/x>" },
      }),
    );
    expect(result).toEqual({ status: "sent", messageId: "msg_resend", quota: 12 });
    const [payload, options] = resendSend.mock.calls[0]!;
    expect(payload).toMatchObject({
      to: "desk@radiance.test",
      from: "healdesk <hello@healdesk.io>",
      replyTo: "hello@healdesk.io",
      headers: { "List-Unsubscribe": "<https://app.healdesk.test/email/stop/x>" },
      tags: [
        { name: "app", value: "app" },
        { name: "kind", value: "usage_80" },
        { name: "clinic", value: CLINIC },
        { name: "delivery", value: DELIVERY },
      ],
    });
    expect(options).toEqual({ idempotencyKey: `hd-usage_80-${DELIVERY}-1` });
  });

  test("Resend's refusals come back with the status and name the outbox decides on", async () => {
    process.env.HEALDESK_EMAIL_TRANSPORT = "resend";
    process.env.RESEND_API_KEY = `re_stub_send_${keys++}`;
    process.env.HEALDESK_EMAIL_FROM = "healdesk <hello@healdesk.io>";
    resendSend.mockResolvedValue({
      data: null,
      error: {
        name: "daily_quota_exceeded",
        message: "You have reached your daily email quota.",
        statusCode: 429,
      },
      headers: { "x-resend-daily-quota": "100" },
    });
    const result = await sendEmail(email());
    expect(result).toMatchObject({
      status: "failed",
      statusCode: 429,
      errorName: "daily_quota_exceeded",
      quota: 100,
    });
  });
});
