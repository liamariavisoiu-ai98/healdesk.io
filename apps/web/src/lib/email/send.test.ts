import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { EMAIL_LOGO } from "@healdesk/catalog";

import { emailKey, send } from "./index";

/**
 * apps/web's sender (Annex X3, "apps/web"): every email goes through `send()`
 * with a kind tag and an idempotency key in one shape,
 * `hd-<kind>-<row id>-<recipient n>` (X1.4), never an address, and a key
 * Resend has already used for this email counts as sent.
 */

type Call = { headers: Headers; body: Record<string, unknown> };
let calls: Call[];
let answer: () => Response;

beforeEach(() => {
  calls = [];
  answer = () => Response.json({ id: "re_1" });
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("HEALDESK_EMAIL_FROM", "healdesk <noreply@healdesk.io>");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls.push({
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return answer();
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("emailKey", () => {
  test("hd-<kind>-<row id>-<recipient n>, with the attempt on a link email", () => {
    const id = "6f1f7c1e-2f0e-4d2b-9a0a-3f5e2c1d4b7a";
    expect(emailKey("setup-ack", id)).toBe(`hd-setup-ack-${id}-1`);
    expect(emailKey("setup-request", id)).toBe(`hd-setup-request-${id}-1`);
    expect(emailKey("contact", "ab12", 2)).toBe("hd-contact-ab12-2");
    expect(emailKey("setup-link", id, 1, 1_760_000_000_000)).toBe(
      `hd-setup-link-${id}-1-1760000000000`,
    );
  });

  test("refuses anything that could carry an address or break the shape", () => {
    expect(() => emailKey("contact", "laura@glowmedspa.com")).toThrow();
    expect(() => emailKey("contact ack", "ab12")).toThrow();
    expect(() => emailKey("contact", "")).toThrow();
    expect(() => emailKey("contact", "ab12", 0)).toThrow();
    expect(() => emailKey("setup-link", "ab12", 1, "a:b")).toThrow();
  });
});

describe("send", () => {
  test("carries the key, the app tag and the kind tag", async () => {
    const result = await send({
      to: "info@glowmedspa.com",
      subject: "We've got your message",
      text: "Hi",
      tag: "contact-ack",
      idempotencyKey: emailKey("contact-ack", "ab12"),
    });
    expect(result).toEqual({ status: "sent", providerId: "re_1" });
    expect(calls[0]!.headers.get("Idempotency-Key")).toBe("hd-contact-ack-ab12-1");
    expect(calls[0]!.body.tags).toEqual([
      { name: "app", value: "web" },
      { name: "kind", value: "contact-ack" },
    ]);
  });

  test("a key Resend already used for this email is a send, not a failure (X1.4)", async () => {
    answer = () =>
      Response.json(
        {
          name: "invalid_idempotent_request",
          message: "Same idempotency key used with a different request payload.",
        },
        { status: 409 },
      );
    expect(
      await send({
        to: "a@b.test",
        subject: "s",
        text: "t",
        idempotencyKey: emailKey("contact", "ab12"),
      }),
    ).toEqual({ status: "sent", providerId: null });
  });

  test("any other refusal is a failure, a 409 without a key included", async () => {
    answer = () => Response.json({ name: "concurrent_idempotent_requests" }, { status: 409 });
    expect(
      (await send({ to: "a@b.test", subject: "s", text: "t", idempotencyKey: "hd-x-1-1" })).status,
    ).toBe("failed");
    answer = () => Response.json({ name: "invalid_idempotent_request" }, { status: 409 });
    expect((await send({ to: "a@b.test", subject: "s", text: "t" })).status).toBe("failed");
    answer = () => Response.json({ name: "validation_error" }, { status: 422 });
    expect(
      (await send({ to: "a@b.test", subject: "s", text: "t", idempotencyKey: "hd-x-1-1" })).status,
    ).toBe("failed");
  });

  /**
   * Annex X1.8: plain text first, with a light HTML twin built from the
   * same words. Before 19 October 2026 every email this site sent but the
   * agreement copy was text alone.
   */
  test("a text email goes with its HTML twin, built from the text and nothing else", async () => {
    const text = [
      "Hi,",
      "",
      "Here is the demo: https://healdesk.io/demo/smith-dental-k7q2mz9xwa",
      "",
      "--",
      "Replies reach the healdesk team. Please leave out patient details.",
    ].join("\n");
    await send({ to: "a@b.test", subject: "Your demo", text, tag: "demo-ready" });
    const html = String(calls[0]!.body.html);
    expect(calls[0]!.body.text).toBe(text);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<a href="https://healdesk.io/demo/smith-dental-k7q2mz9xwa"');
    expect(html).toContain("Replies reach the healdesk team. Please leave out patient details.");
    // Branded (owner, 1 November 2026): the healdesk logo is the one image,
    // at its one fixed URL, and nothing else is fetched.
    expect([...html.matchAll(/\bsrc="([^"]*)"/g)].map((m) => m[1])).toEqual([EMAIL_LOGO.url]);
    expect(html).not.toMatch(/url\(|@import|<link|<script/i);
    expect(new TextEncoder().encode(html).length).toBeLessThan(100 * 1024);
  });

  test("an HTML body the caller renders is sent as it is, and a text too long for a twin goes alone", async () => {
    await send({ to: "a@b.test", subject: "s", text: "t", html: "<p>own</p>" });
    expect(calls[0]!.body.html).toBe("<p>own</p>");
    await send({ to: "a@b.test", subject: "s", text: "x".repeat(110 * 1024) });
    expect(calls[1]!.body).not.toHaveProperty("html");
  });
});
