/**
 * The sign-in alert's content, which moved from apps/app's `renderSignInAlert`
 * to this app on 14 October 2026 and kept its content: when, from where, which
 * browser, and what to do if it was not you. No link, no code, no credential.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { printable, renderSignInAlert, sendSignInAlert } from "./sign-in-alert";

const AT = new Date("2026-10-14T09:41:27Z");

describe("the message", () => {
  it("says when, from where and in which browser, in UTC to the minute", () => {
    const { subject, text } = renderSignInAlert({
      at: AT,
      ipAddress: "198.51.100.23",
      userAgent: "Mozilla/5.0 (Macintosh)",
    });
    expect(subject).toBe("healdesk admin: signed in at 2026-10-14 09:41 UTC");
    expect(text).toContain("Time:    2026-10-14 09:41 UTC");
    expect(text).toContain("Address: 198.51.100.23");
    expect(text).toContain("Browser: Mozilla/5.0 (Macintosh)");
    expect(text).toContain("If that was you, there is nothing to do.");
    expect(text).toContain("HEALDESK_ADMIN_TOTP_SECRET");
  });

  it("says 'not recorded' rather than leaving a blank that reads like a value", () => {
    const { text } = renderSignInAlert({ at: AT });
    expect(text).toContain("Address: not recorded");
    expect(text).toContain("Browser: not recorded");
  });

  it("carries no link and offers no way to sign in", () => {
    const { subject, text } = renderSignInAlert({ at: AT, ipAddress: "198.51.100.23", userAgent: "x" });
    expect(`${subject}\n${text}`).not.toMatch(/https?:\/\/|www\./i);
    expect(text).toContain("healdesk will never email you a code, a password, or a link to sign in.");
  });

  it("cannot be given a forged line by a user agent with a line break in it", () => {
    const { text } = renderSignInAlert({
      at: AT,
      userAgent: "Mozilla/5.0\r\nTime:    1999-01-01 00:00 UTC",
    });
    const timeLines = text.split("\n").filter((line) => line.startsWith("Time:"));
    expect(timeLines).toEqual(["Time:    2026-10-14 09:41 UTC"]);
    expect(text).toContain("Browser: Mozilla/5.0\\u000d\\u000aTime:");
  });

  it("shows bidirectional overrides as escapes rather than letting them reorder the line", () => {
    expect(printable("evil\u202egnp.exe", 256)).toBe("evil\\u202egnp.exe");
    expect(printable("a\u2028b\u0007c", 256)).toBe("a\\u2028b\\u0007c");
  });

  it("caps the user agent at 256 characters, as apps/app did", () => {
    const { text } = renderSignInAlert({ at: AT, userAgent: "A".repeat(1000) });
    const line = text.split("\n").find((entry) => entry.startsWith("Browser: "))!;
    expect(line).toBe(`Browser: ${"A".repeat(256)}`);
  });
});

describe("sending it", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    vi.unstubAllGlobals();
  });

  it("goes to HEALDESK_ADMIN_EMAIL through Resend, as text, tagged", async () => {
    process.env.HEALDESK_ADMIN_EMAIL = " Owner@Example.com ";
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.HEALDESK_EMAIL_FROM = "healdesk <hello@healdesk.io>";
    const fetchSpy = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ id: "re_1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(sendSignInAlert({ at: AT, ipAddress: "198.51.100.23" })).resolves.toEqual({
      status: "sent",
      providerId: "re_1",
    });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    const body = JSON.parse(String(init.body)) as { to: string[]; subject: string; text: string; tags: unknown[] };
    expect(body.to).toEqual(["owner@example.com"]);
    expect(body.subject).toBe("healdesk admin: signed in at 2026-10-14 09:41 UTC");
    expect(body.tags).toContainEqual({ name: "kind", value: "admin-sign-in" });
  });

  it("is skipped, not thrown, when there is no account address", async () => {
    delete process.env.HEALDESK_ADMIN_EMAIL;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(sendSignInAlert({ at: AT })).resolves.toMatchObject({ status: "skipped" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
