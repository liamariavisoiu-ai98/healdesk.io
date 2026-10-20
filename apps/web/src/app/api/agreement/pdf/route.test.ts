import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { signTestAgreement } from "@/lib/checkout/records.testing";
import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests } from "@/lib/sheets/schema";

/**
 * GET /api/agreement/pdf, the executed agreement as a file, rendered here
 * from its sealed record since 14 October 2026, so a buyer can download what
 * they signed while the AWS host is in standby. Nothing is asked of apps/app.
 *
 * The uuid authorises nothing: the credential is the cookie minted at
 * signature, bound to one agreement. Every refusal below happens before the
 * Sheet is read, which is what keeps the status code from saying which ids
 * exist.
 */

const SECRET = "wY2kP9sLd4Rn7Vc0Xt6Hb3Mq8Ja1Zg5f";
const OTHER = "0a9c8b7d-6e5f-4321-8abc-9f8e7d6c5b4a";

let cookieValue: string | undefined;

vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === "hd_agreement" && cookieValue !== undefined ? { name, value: cookieValue } : undefined,
    }),
}));

const { DOWNLOAD_TTL_SECONDS, issueDownloadToken } = await import("@/lib/agreement-download");
const { GET } = await import("./route");

let sheets: FakeSheets;
const fetchSpy = vi.fn(async () => new Response("apps/app is not here", { status: 503 }));

beforeEach(() => {
  vi.stubEnv("HEALDESK_GATE_SECRET", SECRET);
  vi.stubEnv("HEALDESK_PROVISION_SECRET", "provision-secret-for-tests");
  vi.stubEnv("HEALDESK_APP_URL", "https://app.example.test");
  cookieValue = undefined;
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockClear();
  sheets = new FakeSheets();
  __setSheetsClientForTests(sheets);
  __resetSheetSchemaForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  __setSheetsClientForTests(null);
  __resetSheetSchemaForTests();
});

function request(id: string): Request {
  return new Request(`https://healdesk.io/api/agreement/pdf?id=${encodeURIComponent(id)}`);
}

/** A med spa that answered "Yes" signs the BAA; "No" signs the DPA since its release (20 October 2026). */
async function signed(covered: "yes" | "no" = "yes"): Promise<string> {
  const record = await signTestAgreement({
    clinicName: "Radiance Med Spa LLC",
    specialty: "med-spa",
    covered,
    bookingSystem: "google_calendar",
    calendarAccount: "workspace_baa",
    contactName: "Alex Chen",
    contactEmail: "alex@radiance.test",
  });
  return record.id;
}

/** Sheet reads since the call count was taken: none means the refusal came first. */
function sheetCalls(): number {
  return sheets.calls.filter((call) => call.startsWith("getValues agreements")).length;
}

describe("the uuid alone is not a credential", () => {
  test("no cookie: refused, and nothing is read", async () => {
    const id = await signed();
    const before = sheetCalls();
    const response = await GET(request(id));
    expect(response.status).toBe(401);
    expect(sheetCalls()).toBe(before);
  });

  test("a cookie minted for another agreement does not open this one", async () => {
    const id = await signed();
    cookieValue = issueDownloadToken(OTHER);
    const before = sheetCalls();
    expect((await GET(request(id))).status).toBe(401);
    expect(sheetCalls()).toBe(before);
  });

  test("an expired cookie is refused even though we signed it", async () => {
    const id = await signed();
    vi.useFakeTimers();
    const start = new Date("2026-10-14T09:00:00.000Z").getTime();
    vi.setSystemTime(start);
    cookieValue = issueDownloadToken(id);
    vi.setSystemTime(start + DOWNLOAD_TTL_SECONDS * 1000);
    expect((await GET(request(id))).status).toBe(401);
  });

  test("a tampered cookie is refused", async () => {
    const id = await signed();
    const token = issueDownloadToken(id);
    const last = token.slice(-1);
    cookieValue = `${token.slice(0, -1)}${last === "A" ? "B" : "A"}`;
    expect((await GET(request(id))).status).toBe(401);
  });
});

describe("the PDF, from the record, with no apps/app", () => {
  test("the cookie opens the agreement it was minted for: the catalog's PDF, rendered here", async () => {
    const id = await signed();
    cookieValue = issueDownloadToken(id);
    const response = await GET(request(id));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="healdesk-baa-[a-z0-9._-]+-\d{4}-\d{2}-\d{2}\.pdf"$/,
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(Number(response.headers.get("content-length"))).toBe(bytes.byteLength);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Deterministic: the same record renders the same file, which is what
    // lets the digest recorded with the emailed copy mean anything.
    const again = Buffer.from(await (await GET(request(id))).arrayBuffer());
    expect(createHash("sha256").update(again).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  test("a Data Protection Agreement downloads under its own name", async () => {
    const id = await signed("no");
    cookieValue = issueDownloadToken(id);
    const response = await GET(request(id));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="healdesk-dpa-[a-z0-9._-]+-\d{4}-\d{2}-\d{2}\.pdf"$/,
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  test("a record that was never written is 404, and one edited in the Sheet is 409, with no PDF", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const missing = "5d1f2e3a-4b5c-4d6e-8f70-8192a3b4c5d6";
    cookieValue = issueDownloadToken(missing);
    expect((await GET(request(missing))).status).toBe(404);

    const id = await signed();
    const row = sheets.records("agreements").findIndex((r) => r.id === id) + 2;
    const cell = String(sheets.records("agreements")[row - 2]!.record_1);
    sheets.setCell("agreements", row, "record_1", cell.replace("Radiance Med Spa LLC", "Radiance Med Spa Inc"));
    cookieValue = issueDownloadToken(id);
    const edited = await GET(request(id));
    expect(edited.status).toBe(409);
    expect(edited.headers.get("content-type")).toMatch(/json/);
  });

  test("without the records configured the buyer is sent to the text copy", async () => {
    const id = await signed();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("HEALDESK_PROVISION_SECRET", "");
    cookieValue = issueDownloadToken(id);
    const response = await GET(request(id));
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toMatch(/text copy/);
  });
});
