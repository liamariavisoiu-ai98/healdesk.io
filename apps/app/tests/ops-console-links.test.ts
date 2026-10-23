import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { assertPayloadAllowed, consoleOrigin, linkProblem, linkProblems } from "@/lib/email/lint";
import { OPS_REASON } from "@/lib/email/templates/context";
import { renderOpsAlert } from "@/lib/email/templates/ops_alert";
import { opsConsoleLink } from "@/lib/ops/notify";
import { slackText } from "@/lib/ops/slack";

/**
 * Console links in ops alerts (owner decision D3, 23 October 2026; design
 * E3, "OWNER DECISION, email links"). One extra origin, the console's
 * (HEALDESK_CONSOLE_ORIGIN), accepted by the link scanner for the `ops_alert`
 * kind only and for pages under /admin/ only; every other kind, path, query
 * and token-shaped segment is still refused, and with the origin unset there
 * is no link at all. The email and the Slack copy print the same URL, built
 * in one place (opsConsoleLink).
 */

const CLINIC = "0c1d2e3f-0000-4000-8000-000000000000";
const CTX = {
  clinicName: null,
  audience: "patients",
  reason: OPS_REASON,
  raisedAt: new Date("2026-10-23T12:00:00Z"),
  timeZone: "UTC",
} as const;

beforeEach(() => {
  vi.stubEnv("BETTER_AUTH_URL", "https://app.healdesk.test");
  vi.stubEnv("HEALDESK_APP_URL", "https://app-internal.healdesk.test");
  vi.stubEnv("HEALDESK_CONSOLE_ORIGIN", "https://healdesk.test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the console origin", () => {
  test("is an https origin and nothing else", () => {
    expect(consoleOrigin()).toBe("https://healdesk.test");
    for (const bad of ["", "__unset__", "http://healdesk.test", "https://healdesk.test/admin", "not a url"]) {
      vi.stubEnv("HEALDESK_CONSOLE_ORIGIN", bad);
      expect(consoleOrigin(), bad).toBeNull();
    }
  });
});

describe("the link scanner and the console", () => {
  const page = `https://healdesk.test/admin/ops/${CLINIC}/care`;

  test("an ops alert may link to a page under /admin/", () => {
    expect(linkProblem(page, "ops_alert")).toBeNull();
    expect(linkProblem(`https://healdesk.test/admin/ops/${CLINIC}/onboarding#calendar-writes`, "ops_alert")).toBeNull();
  });

  test("every other kind is refused, a clinic's email above all", () => {
    for (const kind of ["usage_80", "setup_reminder", "booking_request", "sign_in_link", "ops_digest", undefined]) {
      expect(linkProblem(page, kind), String(kind)).toMatch(/not an ops alert/);
    }
  });

  test("every other path on the console's origin is refused, even in an ops alert", () => {
    for (const path of ["/", "/admin", "/pricing", "/administrator/x", "/api/ops", "/x/../admin-ish"]) {
      expect(linkProblem(`https://healdesk.test${path}`, "ops_alert"), path).toMatch(/outside \/admin\//);
    }
  });

  test("a query, credentials or a token-shaped segment is refused, even under /admin/", () => {
    expect(linkProblem(`${page}?clinic=${CLINIC}`, "ops_alert")).toMatch(/with a query/);
    expect(linkProblem(`https://user:pw@healdesk.test/admin/ops`, "ops_alert")).toMatch(/credentials/);
    const token = "aB3dEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdE";
    expect(linkProblem(`https://healdesk.test/admin/connect/${token}`, "ops_alert")).toMatch(/single-use token/);
  });

  test("with the origin unset, the console is just another origin, refused everywhere", () => {
    vi.stubEnv("HEALDESK_CONSOLE_ORIGIN", "");
    expect(linkProblem(page, "ops_alert")).toMatch(/not a public origin of ours/);
  });

  test("the internal origin stays refused, whatever the console origin says", () => {
    vi.stubEnv("HEALDESK_CONSOLE_ORIGIN", "https://app-internal.healdesk.test");
    expect(linkProblem("https://app-internal.healdesk.test/admin/ops", "ops_alert")).toMatch(/HEALDESK_APP_URL/);
  });

  test("a console link in a clinic's payload is refused by the payload allowlist too", () => {
    expect(() => assertPayloadAllowed({ consoleUrl: page }, "usage_80")).toThrow(/not a link an email may carry/);
    expect(() => assertPayloadAllowed({ consoleUrl: page }, "ops_alert")).not.toThrow();
  });
});

describe("one link for the email and the Slack copy", () => {
  test("is the clinic's console page, ids alone, and null without a clinic or an origin", () => {
    expect(opsConsoleLink("critical_notice_undelivered", { clinicId: CLINIC })).toBe(
      `https://healdesk.test/admin/ops/${CLINIC}/care`,
    );
    expect(opsConsoleLink("calendar_broken", { clinicId: CLINIC })).toBe(
      `https://healdesk.test/admin/ops/${CLINIC}/onboarding`,
    );
    expect(opsConsoleLink("dmarc_review_due", {})).toBeNull();
    expect(opsConsoleLink("calendar_broken", { clinicId: "not-a-uuid" })).toBeNull();
    vi.stubEnv("HEALDESK_CONSOLE_ORIGIN", "");
    expect(opsConsoleLink("calendar_broken", { clinicId: CLINIC })).toBeNull();
  });

  test("the email prints it as its one link, and passes the scanner", () => {
    const consoleUrl = opsConsoleLink("calendar_broken", { clinicId: CLINIC })!;
    const rendered = renderOpsAlert({ event: "calendar_broken", clinicId: CLINIC, consoleUrl }, CTX);
    expect(rendered.text).toContain(consoleUrl);
    expect(rendered.html).toContain(consoleUrl);
    expect(linkProblems(rendered, "ops_alert")).toEqual([]);
    // The same message in any other kind would be refused.
    expect(linkProblems(rendered, "usage_80")).not.toEqual([]);
  });

  test("the Slack copy prints the identical URL", () => {
    const consoleUrl = opsConsoleLink("calendar_broken", { clinicId: CLINIC })!;
    const text = slackText({ event: "calendar_broken", fields: { clinicId: CLINIC }, clinicName: null });
    expect(text).toContain(`<${consoleUrl}|Open in the console>`);
  });
});
