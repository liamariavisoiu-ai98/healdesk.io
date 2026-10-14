import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { runNurture } from "./email/run-nurture";
import { recordDemoUnlock } from "./leads";
import { gateState } from "./setup-gate";
import { declineSetupRequest, sendSetupLink, sendSetupLinkReminders } from "./setup-links";
import { createSetupRequest, findSetupRequest, updateSetupRequest } from "./setup-requests";
import { FakeSheets, __setSheetsClientForTests } from "./sheets/client";
import { __resetSheetSchemaForTests } from "./sheets/schema";

/**
 * What /admin/setup does (P4) and what the nurture cron adds (P5), with
 * Resend stubbed. The link in each email is followed through the real gate,
 * so "the latest link works and the old one doesn't" is tested end to end.
 */

const DAY = 24 * 60 * 60 * 1000;

type Sent = { to: string[]; subject: string; text: string; headers: Record<string, string> };

let sheets: FakeSheets;
let sent: { body: Sent; idempotencyKey: string | null }[];
let failNext = false;

const resend = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
  if (!String(url).startsWith("https://api.resend.com/")) throw new Error(`unexpected fetch ${String(url)}`);
  if (failNext) {
    failNext = false;
    return new Response("boom", { status: 500 });
  }
  const headers = new Headers(init?.headers);
  sent.push({ body: JSON.parse(String(init?.body)) as Sent, idempotencyKey: headers.get("Idempotency-Key") });
  return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
});

beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("HEALDESK_EMAIL_FROM", "healdesk <noreply@healdesk.io>");
  vi.stubEnv("HEALDESK_CHECKOUT_MODE", "");
  vi.stubGlobal("fetch", resend);
  sent = [];
  failNext = false;
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

async function request(email = "info@radiance.com") {
  const created = await createSetupRequest({
    name: "Alex Chen",
    clinicName: "Radiance Med Spa",
    website: "radiance.com",
    email,
    channels: ["web"],
    leadId: null,
    ipAddress: null,
  });
  if (!created.ok) throw new Error("the fake Sheet refused a request");
  return created.request;
}

/** The token in an email's link, as /start would read it. */
function tokenIn(text: string): string {
  const match = /\/start\?t=([^\s]+)/.exec(text);
  if (!match) throw new Error("no setup link in the email");
  return decodeURIComponent(match[1]!);
}

describe("sending a setup link (P4)", () => {
  test("production refuses until the owner opens setup links", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const saved = await request();
    expect(await sendSetupLink(saved.id)).toEqual({ ok: false, reason: "closed" });
    expect(sent).toHaveLength(0);
    expect((await findSetupRequest(saved.id))!.status).toBe("new");
  });

  test("records the link, then emails it with the opt-out a commercial email needs", async () => {
    const saved = await request();
    const outcome = await sendSetupLink(saved.id);
    expect(outcome.ok).toBe(true);

    const stored = (await findSetupRequest(saved.id))!;
    expect(stored.status).toBe("invited");
    expect(stored.linkExpiresAt?.getTime()).toBe(outcome.ok ? outcome.expiresAt.getTime() : NaN);

    const [mail] = sent;
    expect(mail!.body.to).toEqual(["info@radiance.com"]);
    expect(mail!.body.subject).toBe("Your setup link for Radiance Med Spa");
    expect(mail!.body.headers["List-Unsubscribe"]).toMatch(/^<https:\/\/.+\/api\/email\/unsubscribe\?t=s\./);
    expect(mail!.body.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(mail!.idempotencyKey).toBe(`hd-setup-link-${saved.id}-1-${stored.linkExpiresAt!.getTime()}`);

    vi.stubEnv("HEALDESK_CHECKOUT_MODE", "");
    expect(await gateState(tokenIn(mail!.body.text))).toMatchObject({ mode: "pilot", link: "valid" });
  });

  test("a new link replaces the old one", async () => {
    const saved = await request();
    await sendSetupLink(saved.id, new Date(Date.now() - DAY));
    await sendSetupLink(saved.id);
    const [first, second] = sent;
    expect(await gateState(tokenIn(first!.body.text))).toEqual({ mode: "pilot", link: "replaced" });
    expect(await gateState(tokenIn(second!.body.text))).toMatchObject({ link: "valid" });
  });

  test("is refused for a paid request, an unsubscribed one and one that isn't there", async () => {
    const paid = await request("paid@clinic.com");
    await updateSetupRequest(paid.id, { status: "paid", paidAt: new Date() });
    expect(await sendSetupLink(paid.id)).toEqual({ ok: false, reason: "paid" });

    const opted = await request("opted@clinic.com");
    await updateSetupRequest(opted.id, { unsubscribedAt: new Date() });
    expect(await sendSetupLink(opted.id)).toEqual({ ok: false, reason: "unsubscribed" });

    expect(await sendSetupLink(crypto.randomUUID())).toEqual({ ok: false, reason: "not_found" });
    expect(sent).toHaveLength(0);
  });

  test("a failed email says so, with the link already recorded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const saved = await request();
    failNext = true;
    expect(await sendSetupLink(saved.id)).toEqual({ ok: false, reason: "email_failed" });
    expect((await findSetupRequest(saved.id))!.status).toBe("invited");
  });

  test("declining stops the link working, and sends nothing", async () => {
    const saved = await request();
    await sendSetupLink(saved.id);
    expect(await declineSetupRequest(saved.id)).toBe(true);
    expect(await gateState(tokenIn(sent[0]!.body.text))).toEqual({ mode: "pilot", link: "invalid" });
    expect(sent).toHaveLength(1);
  });
});

describe("the reminder (P5)", () => {
  test("goes once, four days before expiry, carrying the very same link", async () => {
    const saved = await request();
    const sentAt = new Date(Date.now() - 11 * DAY);
    await sendSetupLink(saved.id, sentAt);
    const link = tokenIn(sent[0]!.body.text);

    expect(await sendSetupLinkReminders()).toEqual({ sent: 1, failed: 0 });
    const reminder = sent[1]!;
    expect(reminder.body.subject).toMatch(/^Your setup link works until /);
    expect(tokenIn(reminder.body.text)).toBe(link);
    expect(reminder.body.headers["List-Unsubscribe"]).toBeTruthy();

    expect(await sendSetupLinkReminders()).toEqual({ sent: 0, failed: 0 });
    expect(sent).toHaveLength(2);
  });

  test("waits until the window, and skips paid and unsubscribed requests", async () => {
    const fresh = await request("fresh@clinic.com");
    await sendSetupLink(fresh.id);
    const paid = await request("paid@clinic.com");
    await sendSetupLink(paid.id, new Date(Date.now() - 11 * DAY));
    await updateSetupRequest(paid.id, { status: "paid", paidAt: new Date() });
    const opted = await request("opted@clinic.com");
    await sendSetupLink(opted.id, new Date(Date.now() - 11 * DAY));
    await updateSetupRequest(opted.id, { unsubscribedAt: new Date() });

    expect(await sendSetupLinkReminders()).toEqual({ sent: 0, failed: 0 });
    expect(sent).toHaveLength(3);
  });
});

describe("nurture stops for anyone who asked for setup", () => {
  test("a lead whose address asked for setup gets no further touch", async () => {
    const lead = await recordDemoUnlock({ email: "info@radiance.com", isBusinessEmail: true, marketingConsent: true });
    if (!lead.ok) throw new Error("no lead");
    await request("Info@Radiance.com");
    const run = await runNurture(new Date(Date.now() + 25 * 60 * 60 * 1000));
    expect(run.nurtureSent).toBe(0);
    expect(run.skipped).toBe(1);
    expect(sent.filter((m) => m.body.to[0] === "info@radiance.com")).toHaveLength(0);
  });
});

describe("each nurture touch is keyed to its lead and step", () => {
  test("hd-nurture-<step>-<lead id>-1, so a retried run inside Resend's day sends it once", async () => {
    const lead = await recordDemoUnlock({
      email: "laura@glowmedspa.com",
      isBusinessEmail: true,
      marketingConsent: true,
      noticeVersion: "v",
      consentText: "Email me",
    });
    if (!lead.ok) throw new Error("no lead");
    const run = await runNurture(new Date(Date.now() + 25 * 60 * 60 * 1000));
    expect(run.nurtureSent).toBe(1);
    const [touch] = sent;
    expect(touch!.idempotencyKey).toBe(`hd-nurture-0-${lead.leadId}-1`);
    expect((touch!.body as unknown as { tags: unknown[] }).tags).toContainEqual({ name: "kind", value: "nurture-0" });
  });
});
