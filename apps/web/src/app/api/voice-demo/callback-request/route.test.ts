import { sign, SIGNATURE_HEADER, TIMESTAMP_HEADER, DEMO_CALLBACK_OFFER } from "@healdesk/catalog";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { recordDemoUnlock } from "@/lib/leads";
import { __resetRateLimiterForTests } from "@/lib/rate-limit";
import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests } from "@/lib/sheets/schema";

const demos = vi.hoisted(() => ({ found: true }));
vi.mock("@/lib/demo/sessions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/demo/sessions")>();
  return {
    ...actual,
    getDemoSession: async (slug: string) =>
      demos.found ? ({ slug, clinicName: "Lumen Aesthetics", leadEmail: "josh@lumen.example" } as Awaited<ReturnType<typeof actual.getDemoSession>>) : null,
  };
});

import { POST } from "./route";

/**
 * The demo call's call back (owner, 26 October 2026): only apps/app may ask,
 * signed; a 2xx means the request is kept for the team's queue AND in
 * hello@'s inbox, since Aya then tells the owner someone will call; and
 * nothing but the number, a first name, the clinic and one line is kept.
 */

const SECRET = "test-provision-secret-0123456789abcdef";
const SLUG = "lumen-aesthetics-ab2cd3ef4g";

let sheets: FakeSheets;
const emails: { body: Record<string, unknown>; key: string | null }[] = [];
let emailStatus = 200;

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    slug: SLUG,
    clinicName: "Lumen Aesthetics",
    firstName: "Josh",
    phoneE164: "+15125550147",
    topic: "Pricing for two locations",
    test: false,
    offerEndsAt: Date.now() + 40 * 3_600_000,
    at: new Date().toISOString(),
    ...overrides,
  });
}

function post(raw: string, options: { secret?: string; timestamp?: string } = {}) {
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  return POST(
    new Request("http://localhost/api/voice-demo/callback-request", {
      method: "POST",
      headers: { "content-type": "application/json", [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: sign(raw, timestamp, options.secret ?? SECRET) },
      body: raw,
    }),
  );
}

const tab = (title: string) => (sheets.tabs.get(title) ?? []).slice(1);

beforeEach(() => {
  emails.length = 0;
  emailStatus = 200;
  demos.found = true;
  vi.stubEnv("HEALDESK_PROVISION_SECRET", SECRET);
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("HEALDESK_EMAIL_FROM", "healdesk <hello@healdesk.io>");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      emails.push({ body: JSON.parse(String(init.body)) as Record<string, unknown>, key: new Headers(init.headers).get("Idempotency-Key") });
      return new Response(JSON.stringify(emailStatus === 200 ? { id: "email_1" } : { message: "nope" }), { status: emailStatus });
    }),
  );
  sheets = new FakeSheets();
  __setSheetsClientForTests(sheets);
  __resetSheetSchemaForTests();
  __resetRateLimiterForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  __setSheetsClientForTests(null);
  __resetSheetSchemaForTests();
});

describe("who may ask", () => {
  test("a request not signed with the provision secret is refused, and nothing is kept or sent", async () => {
    expect((await post(body(), { secret: "someone-else" })).status).toBe(401);
    expect((await post(body(), { timestamp: String(Math.floor(Date.now() / 1000) - 3600) })).status).toBe(401);
    expect(emails).toHaveLength(0);
    expect(tab("demo_callbacks")).toHaveLength(0);
  });

  test("without the secret on this side, nothing is taken", async () => {
    vi.stubEnv("HEALDESK_PROVISION_SECRET", "");
    expect((await post(body())).status).toBe(503);
  });

  test("a number that is not E.164 or a slug that is not a demo's is refused", async () => {
    expect((await post(body({ phoneE164: "512 555 0147" }))).status).toBe(422);
    expect((await post(body({ slug: "../admin" }))).status).toBe(422);
    expect((await post("not json")).status).toBe(400);
    demos.found = false;
    expect((await post(body())).status).toBe(404);
    expect(emails).toHaveLength(0);
  });
});

describe("a call back taken", () => {
  test("kept for the queue, the consent's words recorded, the lead's event added, and hello@ emailed, before a 2xx", async () => {
    await recordDemoUnlock({ email: "josh@lumen.example", isBusinessEmail: true });
    const response = await post(body());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, repeat: false });

    const rows = tab("demo_callbacks");
    expect(rows).toHaveLength(1);
    const [id, slug, clinic, first, phone, topic, test, offerEnds, requested] = rows[0]!;
    expect([slug, clinic, first, phone, topic, test]).toEqual([SLUG, "Lumen Aesthetics", "Josh", "+15125550147", "Pricing for two locations", false]);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(offerEnds).toMatch(/Z$/);
    expect(requested).toMatch(/Z$/);

    const consents = tab("call_consents");
    expect(consents).toHaveLength(1);
    expect(consents[0]![2]).toBe("+15125550147");
    expect(consents[0]![3]).toBe(`demo-callback-${DEMO_CALLBACK_OFFER.version}`);
    expect(String(consents[0]![4])).toContain(DEMO_CALLBACK_OFFER.text);
    expect(consents[0]![1]).not.toBe("");

    expect(tab("lead_events").map((e) => e[2])).toContain("callback_requested");

    expect(emails).toHaveLength(1);
    const email = emails[0]!.body;
    expect(email.to).toEqual(["hello@healdesk.io"]);
    expect(String(email.subject)).toBe("Demo call: call back Josh, Lumen Aesthetics");
    expect(String(email.text)).toContain("+15125550147");
    expect(String(email.text)).toContain("Pricing for two locations");
    expect(String(email.text)).toContain("josh@lumen.example");
    expect(String(email.text)).toContain(`/demo/${SLUG}`);
    expect(String(email.text)).toContain("/admin/queues#demo-callbacks");
    expect(emails[0]!.key).toBe(`hd-demo-callback-${String(id)}-1`);
  });

  test("an operator's test call says so, in the subject and the row", async () => {
    expect((await post(body({ test: true }))).status).toBe(200);
    expect(String(emails[0]!.body.subject)).toMatch(/^\[Test\] Demo call: call back Josh/);
    expect(tab("demo_callbacks")[0]![6]).toBe(true);
  });

  test("the same number for the same demo again is the same request: one row, one consent, the same email key", async () => {
    expect((await post(body())).status).toBe(200);
    const second = await post(body({ topic: "Something else" }));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, repeat: true });
    expect(tab("demo_callbacks")).toHaveLength(1);
    expect(tab("call_consents")).toHaveLength(1);
    expect(emails.map((e) => e.key)).toEqual([emails[0]!.key, emails[0]!.key]);
  });

  test("a clinic name or topic that is a link or markup is not printed; the demo's own name stands in", async () => {
    expect((await post(body({ clinicName: "https://evil.example", topic: "<script>x</script>" }))).status).toBe(200);
    const row = tab("demo_callbacks")[0]!;
    expect(row[2]).toBe("Lumen Aesthetics");
    expect(row[5]).toBe("");
  });
});

describe("when the team cannot be told, Aya must not say they will call", () => {
  test("an email that does not go answers 502", async () => {
    emailStatus = 500;
    expect((await post(body())).status).toBe(502);
  });

  test("no email transport answers 503, before anything is kept", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    expect((await post(body())).status).toBe(503);
    expect(tab("demo_callbacks")).toHaveLength(0);
  });

  test("a fourth request for one demo within the hour is refused", async () => {
    for (const n of ["+15125550141", "+15125550142", "+15125550143"]) expect((await post(body({ phoneE164: n }))).status).toBe(200);
    expect((await post(body({ phoneE164: "+15125550144" }))).status).toBe(429);
  });
});
