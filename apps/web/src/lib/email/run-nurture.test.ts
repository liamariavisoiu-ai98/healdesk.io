import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { recordTestPurchase, signTestAgreement } from "@/lib/checkout/records.testing";
import { findLeadByEmail, markCheckoutAbandoned, markCheckoutStarted } from "@/lib/leads";
import { gateState } from "@/lib/setup-gate";
import { createSetupRequest, updateSetupRequest } from "@/lib/setup-requests";
import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests } from "@/lib/sheets/schema";

import { runNurture } from "./run-nurture";

/**
 * P7, "still open", end to end through the cron: the webhook's record of an
 * expired Session (its ref), 24 hours, then the purchase re-read at send time
 * from its own records. In pilot mode it carries the setup link, re-signed
 * from the request's stored expiry; it names the agreement the practice
 * signed; it never goes for a purchase that was paid. Resend and the Sheet
 * are fakes.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const EMAIL = "alex@radiancemedspa.com";

type Sent = {
  to: string[];
  subject: string;
  text: string;
  tags: { name: string; value: string }[];
};
let sent: { body: Sent; key: string | null }[];
let sheets: FakeSheets;

beforeEach(() => {
  sent = [];
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("HEALDESK_EMAIL_FROM", "healdesk <noreply@healdesk.io>");
  vi.stubEnv("HEALDESK_PROVISION_SECRET", "test-secret");
  vi.stubEnv("HEALDESK_CHECKOUT_MODE", "");
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
  sheets = new FakeSheets();
  __setSheetsClientForTests(sheets);
  __resetSheetSchemaForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __setSheetsClientForTests(null);
  __resetSheetSchemaForTests();
});

/** A setup request with a live link, a signature and a press of Pay whose Session then expired. */
async function abandonedPurchase(options: { viaLink?: boolean } = {}) {
  const created = await createSetupRequest({
    name: "Alex Chen",
    clinicName: "Radiance Med Spa",
    website: "radiancemedspa.com",
    email: EMAIL,
    channels: ["phone", "web"],
    leadId: null,
    ipAddress: null,
  });
  if (!created.ok) throw new Error("the fake Sheet refused a request");
  const request = created.request;
  const linkExpiresAt = new Date(Date.now() + 10 * DAY);
  await updateSetupRequest(request.id, { status: "invited", invitedAt: new Date(), linkExpiresAt });
  const agreement = await signTestAgreement({
    clinicName: "Radiance Med Spa LLC",
    specialty: "med-spa",
    covered: "no",
    bookingSystem: "google_calendar",
    calendarAccount: "workspace_baa",
    contactName: "Alex Chen",
    contactEmail: EMAIL,
  });
  const viaLink = options.viaLink ?? true;
  const ref = viaLink ? request.id : crypto.randomUUID();
  await recordTestPurchase(agreement, {
    ref,
    inviteRef: viaLink ? request.id : null,
    sessionId: "cs_test_1",
  });
  await markCheckoutStarted({
    email: EMAIL,
    clinicName: "Radiance Med Spa",
    plan: "voice-500",
    interval: "month",
  });
  await markCheckoutAbandoned(EMAIL, { ref });
  return { request, ref, linkExpiresAt };
}

const later = (ms: number) => new Date(Date.now() + ms);

describe("P7 through the cron", () => {
  test("not before 24 hours after the expiry", async () => {
    await abandonedPurchase();
    expect((await runNurture(later(23 * HOUR))).abandonmentSent).toBe(0);
    expect(sent).toHaveLength(0);
  });

  test("in pilot mode, 24 hours on: the setup link, re-signed, the agreement by kind, once", async () => {
    const { request } = await abandonedPurchase();
    const run = await runNurture(later(25 * HOUR));
    expect(run.abandonmentSent).toBe(1);
    const [email] = sent;
    expect(email!.body.to).toEqual([EMAIL]);
    expect(email!.body.subject).toBe("Your setup link for Radiance Med Spa LLC is still open");
    expect(email!.body.tags).toContainEqual({ name: "kind", value: "still-open" });
    const lead = (await findLeadByEmail(EMAIL))!;
    expect(email!.key).toBe(`hd-still-open-${lead.id}-1`);
    // The link P4 sent, still working: it opens the purchase through the real gate.
    const token = decodeURIComponent(email!.body.text.match(/\/start\?t=(\S+)/)![1]!);
    const gate = await gateState(token);
    expect(gate).toMatchObject({ mode: "pilot", link: "valid" });
    expect(gate.mode === "pilot" && gate.link === "valid" && gate.request.id).toBe(request.id);
    // A med spa that does not bill insurance signs the BAA while the DPA is unreleased.
    expect(email!.body.text).toContain("If you signed the business associate agreement");
    expect(email!.body.text).not.toMatch(/\bsaved\b/i);
    // Once: the next run sends nothing.
    expect((await runNurture(later(26 * HOUR))).abandonmentSent).toBe(0);
    expect(sent).toHaveLength(1);
  });

  test("never for a purchase that was provisioned, or a request that was paid or stopped", async () => {
    const { ref } = await abandonedPurchase();
    const row = sheets.records("checkout_intents").findIndex((r) => r.ref === ref) + 2;
    sheets.setCell("checkout_intents", row, "provisioned_at", new Date().toISOString());
    expect((await runNurture(later(25 * HOUR))).abandonmentSent).toBe(0);
    expect(sent).toHaveLength(0);
  });

  test("never once the setup request is paid", async () => {
    const { request } = await abandonedPurchase();
    await updateSetupRequest(request.id, { status: "paid", paidAt: new Date() });
    expect((await runNurture(later(25 * HOUR))).abandonmentSent).toBe(0);
  });

  test("never after the setup-link emails were stopped", async () => {
    const { request } = await abandonedPurchase();
    await updateSetupRequest(request.id, { unsubscribedAt: new Date() });
    expect((await runNurture(later(25 * HOUR))).abandonmentSent).toBe(0);
  });

  test("not while a newer press of Pay is under way", async () => {
    await abandonedPurchase();
    await markCheckoutStarted({ email: EMAIL, plan: "voice-500", interval: "month" });
    expect((await runNurture(later(25 * HOUR))).abandonmentSent).toBe(0);
  });

  test("without a setup link, or in public mode, it says where to start again", async () => {
    vi.stubEnv("HEALDESK_CHECKOUT_MODE", "public");
    await abandonedPurchase();
    await runNurture(later(25 * HOUR));
    const [email] = sent;
    expect(email!.body.subject).toBe("Your purchase for Radiance Med Spa LLC is not finished");
    expect(email!.body.text).toContain("/get-started");
    expect(email!.body.text).not.toContain("/start?t=");
  });

  test("a week after the expiry it no longer goes", async () => {
    await abandonedPurchase();
    expect((await runNurture(later(8 * DAY))).abandonmentSent).toBe(0);
  });
});
