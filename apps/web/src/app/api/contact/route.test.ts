import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { __resetRateLimiterForTests } from "@/lib/rate-limit";
import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests } from "@/lib/sheets/schema";

import { POST } from "./route";

/**
 * The contact form: the enquiry to hello@ (P9) and the acknowledgement to the
 * sender (P8), with Resend stubbed so what would be sent can be read. Neither
 * keeps a row, so the submission's digest stands for one in the email keys.
 */

type Sent = {
  to: string[];
  reply_to: string;
  subject: string;
  text: string;
  tags: { name: string; value: string }[];
};

let sent: { body: Sent; key: string | null }[];
let sheets: FakeSheets;
let ip = 0;

beforeEach(() => {
  sent = [];
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("HEALDESK_EMAIL_FROM", "healdesk <noreply@healdesk.io>");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      if (!String(url).startsWith("https://api.resend.com/"))
        throw new Error(`unexpected fetch ${String(url)}`);
      sent.push({
        body: JSON.parse(String(init?.body)) as Sent,
        key: new Headers(init?.headers).get("Idempotency-Key"),
      });
      return Response.json({ id: `re_${sent.length}` });
    }),
  );
  vi.spyOn(console, "info").mockImplementation(() => {});
  sheets = new FakeSheets();
  __setSheetsClientForTests(sheets);
  __resetSheetSchemaForTests();
  __resetRateLimiterForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __setSheetsClientForTests(null);
  __resetSheetSchemaForTests();
});

const MESSAGE = {
  name: "Laura Owner",
  clinic: "Glow Med Spa",
  email: "Laura@GlowMedSpa.com",
  message: "Does it work with Boulevard?",
};

function post(body: Record<string, unknown>): Promise<Response> {
  ip += 1;
  return POST(
    new Request("http://localhost/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": `10.4.0.${ip}` },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/contact", () => {
  test("sends the enquiry to us and one acknowledgement to them, each with its kind and key", async () => {
    const response = await post(MESSAGE);
    expect(response.status).toBe(200);
    const [toUs, ack] = sent;
    expect(toUs!.body.to).toEqual(["hello@healdesk.io"]);
    expect(toUs!.body.reply_to).toBe("laura@glowmedspa.com");
    expect(toUs!.body.tags).toContainEqual({ name: "kind", value: "contact" });
    expect(toUs!.key).toMatch(/^hd-contact-[0-9a-f]{32}-1$/);
    expect(ack!.body.to).toEqual(["laura@glowmedspa.com"]);
    expect(ack!.body.tags).toContainEqual({ name: "kind", value: "contact-ack" });
    expect(ack!.key).toBe(toUs!.key!.replace("hd-contact-", "hd-contact-ack-"));
    // Never an address in a key, and nothing they typed in the acknowledgement.
    expect(`${toUs!.key}${ack!.key}`).not.toMatch(/laura|glow/i);
    expect(ack!.body.text).not.toContain("Boulevard");
    expect(ack!.body.text).not.toContain("Laura Owner");
  });

  test("a double submit carries the same keys, so Resend sends each email once", async () => {
    await post(MESSAGE);
    await post(MESSAGE);
    expect(sent[2]!.key).toBe(sent[0]!.key);
    await post({ ...MESSAGE, message: "And with Mindbody?" });
    expect(sent.at(-1)!.key).not.toBe(sent[0]!.key);
  });
});
