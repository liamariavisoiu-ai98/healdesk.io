import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { recordDemoUnlock } from "@/lib/leads";
import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests } from "@/lib/sheets/schema";

import { POST } from "./route";

/**
 * "Tell us about your clinic": validation, the honeypot, the row it saves,
 * and the two emails (P3 to us, P2 to them), with Resend stubbed so what
 * would be sent can be read.
 */

type Sent = { to: string[]; reply_to: string; subject: string; text: string; headers: Record<string, string> };

let sheets: FakeSheets;
let sent: { body: Sent; idempotencyKey: string | null }[];
let counter = 0;

const resend = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
  if (String(url).startsWith("https://api.resend.com/")) {
    const headers = new Headers(init?.headers);
    sent.push({ body: JSON.parse(String(init?.body)) as Sent, idempotencyKey: headers.get("Idempotency-Key") });
    return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
  }
  throw new Error(`unexpected fetch ${String(url)}`);
});

beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("HEALDESK_EMAIL_FROM", "healdesk <noreply@healdesk.io>");
  vi.stubGlobal("fetch", resend);
  sent = [];
  sheets = new FakeSheets();
  __setSheetsClientForTests(sheets);
  __resetSheetSchemaForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  __setSheetsClientForTests(null);
  __resetSheetSchemaForTests();
});

function post(body: Record<string, unknown>, ip = `10.2.0.${++counter}`): Promise<Response> {
  return POST(
    new Request("http://localhost/api/setup-request", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    }),
  );
}

const VALID = {
  name: "Alex Chen",
  clinicName: "Radiance Med Spa",
  website: "https://radiancemedspa.com/",
  email: "info@radiancemedspa.com",
  channels: ["phone", "web", "not-a-channel"],
};

describe("POST /api/setup-request", () => {
  test("says which field is missing", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...VALID, name: " " }, "name"],
      [{ ...VALID, clinicName: "" }, "clinicName"],
      [{ ...VALID, website: "not a site" }, "website"],
      [{ ...VALID, email: "nope" }, "email"],
      [{ ...VALID, channels: ["fax"] }, "channels"],
    ];
    for (const [body, field] of cases) {
      const response = await post(body);
      expect(response.status, field).toBe(400);
      expect(((await response.json()) as { field: string }).field).toBe(field);
    }
    expect(sheets.tabs.get("setup_requests") ?? []).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  test("a clinic with no website can ask, by saying so", async () => {
    const response = await post({ ...VALID, website: "", noWebsite: true });
    expect(response.status).toBe(200);
    expect(sheets.records("setup_requests")[0]!.website).toBe("");
  });

  test("the honeypot looks like success and saves and sends nothing", async () => {
    const response = await post({ ...VALID, middleName: "bot" });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { ok: boolean }).ok).toBe(true);
    expect(sheets.tabs.get("setup_requests") ?? []).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  test("saves the request, tells us, and acknowledges with a date and nothing they typed", async () => {
    const response = await post(VALID);
    expect(response.status).toBe(200);
    const answer = (await response.json()) as { ok: boolean; replyBy: string };
    expect(answer.replyBy).toMatch(/^(Monday|Tuesday|Wednesday|Thursday|Friday) \d{1,2} [A-Z][a-z]+$/);

    const rows = sheets.records("setup_requests");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      clinic_name: "Radiance Med Spa",
      website: "radiancemedspa.com",
      email_normalized: "info@radiancemedspa.com",
      channels: "phone,web",
      status: "new",
    });

    const [toUs, ack] = sent;
    expect(toUs!.body.to).toEqual(["hello@healdesk.io"]);
    expect(toUs!.body.reply_to).toBe("info@radiancemedspa.com");
    expect(toUs!.body.text).toContain("Radiance Med Spa");
    expect(toUs!.idempotencyKey).toBe(`setup-request:${rows[0]!.id}`);

    expect(ack!.body.to).toEqual(["info@radiancemedspa.com"]);
    expect(ack!.body.subject).toBe("We've got your request");
    expect(ack!.body.text).toContain(`by ${answer.replyBy}`);
    // Sent to an address nobody has verified: no field but the address.
    expect(ack!.body.text).not.toContain("Radiance");
    expect(ack!.body.text).not.toContain("Alex");
    expect(ack!.idempotencyKey).toBe(`setup-ack:${rows[0]!.id}`);
  });

  test("acknowledges an address at most once a day, while still telling us every time", async () => {
    await post(VALID);
    await post({ ...VALID, clinicName: "Radiance Two" });
    expect(sheets.records("setup_requests")).toHaveLength(2);
    expect(sent.filter((m) => m.body.to[0] === "hello@healdesk.io")).toHaveLength(2);
    expect(sent.filter((m) => m.body.to[0] === "info@radiancemedspa.com")).toHaveLength(1);
  });

  test("keeps the lead id only when it names a real lead", async () => {
    const lead = await recordDemoUnlock({ email: "alex@radiancemedspa.com", isBusinessEmail: true });
    if (!lead.ok) throw new Error("no lead");
    await post({ ...VALID, leadId: lead.leadId });
    await post({ ...VALID, email: "other@clinic.com", leadId: crypto.randomUUID() });
    const rows = sheets.records("setup_requests");
    expect(rows[0]!.lead_id).toBe(lead.leadId);
    expect(rows[1]!.lead_id).toBe("");
  });

  test("in production, a store that isn't there is an honest 503 naming the inbox", async () => {
    __setSheetsClientForTests(null);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MARKETING_SHEET_ID", "");
    const response = await post(VALID);
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toContain("hello@healdesk.io");
  });
});
