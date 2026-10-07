import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { issueSetupToken, setupLinkExpiry } from "@/lib/setup-link";
import { createSetupRequest, findSetupRequest, updateSetupRequest } from "@/lib/setup-requests";
import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests } from "@/lib/sheets/schema";

import { POST } from "./route";

/**
 * Signing comes before paying, so while the purchase is by setup link the
 * signature is gated exactly like the payment: no link, no signature, and
 * only under the address the link was sent to. A refused signature never
 * reaches apps/app, so it never becomes a row in the append-only table.
 */

const AGREEMENT_ID = "6f1f7c1e-2f0e-4d2b-9a0a-3f5e2c1d4b7a";

const app = vi.fn(
  async (_url: URL | RequestInfo, _init?: RequestInit) =>
    new Response(JSON.stringify({ agreementId: AGREEMENT_ID, version: "1.2.1" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }),
);

let counter = 0;

beforeEach(() => {
  vi.stubEnv("HEALDESK_PROVISION_SECRET", "test-secret");
  vi.stubEnv("HEALDESK_APP_URL", "http://app.test");
  vi.stubEnv("HEALDESK_CHECKOUT_MODE", "");
  vi.stubGlobal("fetch", app);
  app.mockClear();
  __setSheetsClientForTests(new FakeSheets());
  __resetSheetSchemaForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  __setSheetsClientForTests(null);
  __resetSheetSchemaForTests();
});

/** What the agreement step sends, minus what apps/app alone checks (the hash, the label, the version). */
const SIGNATURE = {
  clinicLegalName: "Radiance Med Spa LLC",
  specialty: "med-spa",
  isCoveredEntity: false,
  attributionMode: "estimated",
  bookingSystem: "mindbody",
  calendarAccount: "workspace_no_baa",
  platform: "mindbody",
  signatoryName: "Alex Chen",
} as const;

function sign(token: string | null, signatoryEmail: string, overrides: Record<string, unknown> = {}): Promise<Response> {
  counter += 1;
  return POST(
    new Request("http://localhost/api/agreement", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": `10.3.0.${counter}`,
        ...(token ? { cookie: `hd_setup=${encodeURIComponent(token)}` } : {}),
      },
      body: JSON.stringify({ ...SIGNATURE, signatoryEmail, ...overrides }),
    }),
  );
}

async function invited(email: string) {
  const created = await createSetupRequest({
    name: "Alex Chen",
    clinicName: "Radiance Med Spa",
    website: null,
    email,
    channels: ["web"],
    leadId: null,
    ipAddress: null,
  });
  if (!created.ok) throw new Error("the fake Sheet refused a request");
  const expiresAt = setupLinkExpiry();
  await updateSetupRequest(created.request.id, { status: "invited", invitedAt: new Date(), linkExpiresAt: expiresAt });
  return { id: created.request.id, token: issueSetupToken(created.request.id, email, expiresAt) };
}

describe("POST /api/agreement, while the purchase is by setup link", () => {
  test("no link, no signature", async () => {
    const response = await sign(null, "info@radiance.com");
    expect(response.status).toBe(403);
    expect(((await response.json()) as { field: string }).field).toBe("setupLink");
    expect(app).not.toHaveBeenCalled();
  });

  test("a valid link signs only under its own address", async () => {
    const { token } = await invited("info@radiance.com");
    const other = await sign(token, "someone@else.com");
    expect(other.status).toBe(422);
    expect(((await other.json()) as { field: string }).field).toBe("signatoryEmail");
    expect(app).not.toHaveBeenCalled();
  });

  test("a valid link under its own address signs, and the request records it", async () => {
    const { id, token } = await invited("info@radiance.com");
    const response = await sign(token, "INFO@radiance.com");
    expect(response.status).toBe(201);
    expect(app).toHaveBeenCalledTimes(1);
    expect((await findSetupRequest(id))!.signedAt).toBeInstanceOf(Date);
  });

  test("public mode signs without a link, as before", async () => {
    vi.stubEnv("HEALDESK_CHECKOUT_MODE", "public");
    const response = await sign(null, "anyone@clinic.com");
    expect(response.status).toBe(201);
    expect(app).toHaveBeenCalledTimes(1);
  });
});

/**
 * The calendar answers travel with the signature (bookingSystem and
 * calendarAccount, by those names), and the platform the released agreement
 * still renders from must be the one the booking system implies. apps/app's
 * signing path does not read the first two yet, so this is where a mismatch
 * is stopped before it becomes a row.
 */
describe("POST /api/agreement checks the calendar answers before anything is signed", () => {
  beforeEach(() => {
    vi.stubEnv("HEALDESK_CHECKOUT_MODE", "public");
  });

  async function refusal(response: Response) {
    return { status: response.status, field: ((await response.json()) as { field: string }).field };
  }

  test("an unknown booking system, or none, is refused", async () => {
    expect(await refusal(await sign(null, "a@clinic.com", { bookingSystem: "zenoti" }))).toEqual({
      status: 422,
      field: "bookingSystem",
    });
    expect(await refusal(await sign(null, "a@clinic.com", { bookingSystem: undefined }))).toEqual({
      status: 422,
      field: "bookingSystem",
    });
    expect(app).not.toHaveBeenCalled();
  });

  test("an unknown Google account kind is refused", async () => {
    expect(await refusal(await sign(null, "a@clinic.com", { calendarAccount: "gmail" }))).toEqual({
      status: 422,
      field: "calendarAccount",
    });
    expect(app).not.toHaveBeenCalled();
  });

  test("a platform the booking system doesn't imply is refused", async () => {
    // Mindbody's agreement names Mindbody; Calendly has no phase-two platform, so "none".
    expect(await refusal(await sign(null, "a@clinic.com", { platform: "boulevard" }))).toEqual({
      status: 422,
      field: "platform",
    });
    expect(await refusal(await sign(null, "a@clinic.com", { bookingSystem: "calendly", platform: "calcom" }))).toEqual({
      status: 422,
      field: "platform",
    });
    expect(app).not.toHaveBeenCalled();

    const calendly = await sign(null, "a@clinic.com", { bookingSystem: "calendly", platform: "none" });
    expect(calendly.status).toBe(201);
    const forwarded = JSON.parse(String(app.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(forwarded).toMatchObject({ bookingSystem: "calendly", calendarAccount: "workspace_no_baa", platform: "none" });
  });

  test("a practice with no agreement to sign here, a veterinary one while the DPA is unreleased, is refused", async () => {
    expect(await refusal(await sign(null, "a@clinic.com", { specialty: "veterinary" }))).toEqual({
      status: 422,
      field: "specialty",
    });
    expect(app).not.toHaveBeenCalled();
  });
});
