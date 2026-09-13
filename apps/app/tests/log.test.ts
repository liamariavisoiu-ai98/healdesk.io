import { afterEach, describe, expect, test, vi } from "vitest";

import { ALLOWED_LOG_KEYS, LogFieldError, describeError, log, scrub } from "@/lib/log";

/**
 * The logger is the last thing between application code and a log group
 * nobody has a BAA with. These tests are the "nothing checks" complaint from
 * the audit, answered.
 */

describe("log", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a field that could name a patient is refused, not redacted", () => {
    for (const key of ["phone", "name", "fullName", "email", "payload", "transcript", "contact", "body"]) {
      expect(() => log.info("x", { [key]: "anything" }), key).toThrow(LogFieldError);
      expect(ALLOWED_LOG_KEYS.has(key), `${key} must never be allowlisted`).toBe(false);
    }
  });

  test("objects and arrays cannot be logged at all", () => {
    expect(() => log.error("failed", { reason: { phone: "+15550100000" } as never })).toThrow(
      LogFieldError,
    );
  });

  test("a number or an address that reaches a free-text field never reaches the console", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    log.error("agreement copy bounced", {
      reason: "550 5.1.1 <OWNER@CLINIC.TEST>: user unknown; callback +1 (555) 010-0000 https://x.test/a?token=abc",
      clinicId: "0c1d2e3f-0000-4000-8000-000000000000",
    });
    const line = String(spy.mock.calls[0]![0]);
    expect(line).not.toMatch(/OWNER@CLINIC/i);
    expect(line).not.toContain("555");
    expect(line).not.toContain("token=abc");
    expect(line).toContain("[email redacted]");
    expect(line).toContain("[number redacted]");
    expect(line).toContain("0c1d2e3f-0000-4000-8000-000000000000");
  });

  test("the message is scrubbed too, so interpolation is not a side door", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    log.warn(`could not reach dr.chen@clinic.test`);
    expect(String(spy.mock.calls[0]![0])).toBe("[healdesk] could not reach [email redacted]");
  });

  test("scrub leaves ids, counts and HTTP codes alone", () => {
    expect(scrub("clinic=3fa85f64-5717-4562-b3fc-2c963f66afa6 written=42 status=503")).toBe(
      "clinic=3fa85f64-5717-4562-b3fc-2c963f66afa6 written=42 status=503",
    );
  });

  test("describeError keeps the name and message and drops the rest", () => {
    const error = new Error("connect ECONNREFUSED for owner@clinic.test");
    expect(describeError(error)).toBe("Error: connect ECONNREFUSED for [email redacted]");
    expect(describeError("boom")).toBe("unknown error");
  });
});
