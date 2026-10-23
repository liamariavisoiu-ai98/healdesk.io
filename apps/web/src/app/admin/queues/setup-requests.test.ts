import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { recordTestPurchase, signTestAgreement } from "@/lib/checkout/records.testing";
import { createSetupRequest, updateSetupRequest } from "@/lib/setup-requests";
import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests } from "@/lib/sheets/schema";

/**
 * Queues › Setup requests (until 23 October 2026 /admin/setup), rendered as the operator sees it: each request with what it
 * asked for and how far its link has got (sent, opened, the package chosen,
 * signed, paid), the package read from the purchase record the latest press
 * of Pay left in the Sheet.
 */

const operator = vi.hoisted(() => ({ signedIn: true }));
vi.mock("@/lib/admin/operator", () => ({
  requireOperator: async () => (operator.signedIn ? "ops@healdesk.test" : null),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { default: SetupRequestsPage } = await import("./SetupRequestsSection");

async function render(result?: string): Promise<string> {
  const element = await SetupRequestsPage({
    searchParams: Promise.resolve(result ? { result } : {}),
  });
  return renderToStaticMarkup(element).replace(/<!-- -->/g, "");
}

async function request(
  clinicName: string,
  email: string,
  channels: ("phone" | "web" | "instagram")[],
) {
  const created = await createSetupRequest({
    name: "Alex Chen",
    clinicName,
    website: "radiancemedspa.com",
    email,
    channels,
    leadId: null,
    ipAddress: null,
  });
  if (!created.ok) throw new Error("the fake Sheet refused a request");
  return created.request;
}

beforeEach(() => {
  operator.signedIn = true;
  vi.stubEnv("HEALDESK_PROVISION_SECRET", "test-secret");
  __setSheetsClientForTests(new FakeSheets());
  __resetSheetSchemaForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  __setSheetsClientForTests(null);
  __resetSheetSchemaForTests();
});

describe("/admin/setup", () => {
  test("shows each request, and the package its purchase chose once Pay was pressed", async () => {
    const waiting = await request("Quiet Clinic", "info@quiet.test", ["phone"]);
    const buying = await request("Radiance Med Spa", "alex@example.com", ["phone", "web"]);
    await updateSetupRequest(buying.id, {
      status: "invited",
      invitedAt: new Date(),
      linkExpiresAt: new Date(Date.now() + 86_400_000),
      openedAt: new Date(),
      signedAt: new Date(),
    });
    const agreement = await signTestAgreement({
      clinicName: "Radiance Med Spa LLC",
      specialty: "med-spa",
      covered: "no",
      bookingSystem: "google_calendar",
      calendarAccount: "workspace_baa",
      contactName: "Alex Chen",
      contactEmail: "alex@example.com",
    });
    await recordTestPurchase(agreement, {
      ref: buying.id,
      attempt: 1,
      sessionId: "cs_test_1",
      plan: "voice-500",
    });
    await recordTestPurchase(agreement, {
      ref: buying.id,
      attempt: 2,
      sessionId: "cs_test_2",
      plan: "voice-webchat-500-300",
      billingInterval: "year",
    });

    const html = await render();
    expect(html).toContain("Quiet Clinic");
    expect(html).toContain("Radiance Med Spa");
    expect(html).toContain("phone and website chat");
    // The latest press of Pay's package, between opened and signed.
    expect(html).toMatch(
      /Opened [^·]+ · Package: AYA Voice \+ Web Chat, 500 minutes and 300 conversations, annual · Signed/,
    );
    expect(html).not.toContain("AYA Voice, 500 minutes");
    // A request with no purchase shows no package: one line, for one purchase.
    expect(html.match(/Package:/g)).toHaveLength(1);
    expect(waiting.id).not.toBe(buying.id);
  });

  test("a paid request offers no link to send", async () => {
    const paid = await request("Paid Spa", "info@paid.test", ["web"]);
    await updateSetupRequest(paid.id, { status: "paid", paidAt: new Date() });
    const html = await render();
    expect(html).toContain("Paid Spa");
    expect(html).toMatch(/Paid \d/);
    expect(html).not.toContain("Send setup link");
  });

  test("records that cannot be read cost the package line, never the queue", async () => {
    vi.stubEnv("HEALDESK_PROVISION_SECRET", "");
    await request("Radiance Med Spa", "alex@example.com", ["phone"]);
    const html = await render();
    expect(html).toContain("Radiance Med Spa");
    expect(html).not.toContain("Package:");
  });

  test("says what an action did", async () => {
    expect(await render("closed")).toContain("HEALDESK_SETUP_LINKS=open");
  });

  test("sends anyone without a session to sign in", async () => {
    operator.signedIn = false;
    await expect(render()).rejects.toThrow("redirect /admin/sign-in");
  });
});
