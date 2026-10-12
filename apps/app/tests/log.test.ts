import { DrizzleQueryError } from "drizzle-orm";
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

  test("Google's OAuth material never reaches the console, whatever field or message carries it", () => {
    // Synthetic values in each of the shapes Google issues (plan §12), built
    // from parts so this file holds nothing a secret scanner reads as one.
    const secrets = {
      access: ["ya29", "a0AfB_byC-synthetic_ACCESS", "token-123"].join("."),
      refresh: ["1", "", "0gSyntheticRefresh-Token_456"].join("/"),
      code: ["4", "0AQSTgQSyntheticAuthCode_789"].join("/"),
      idToken: ["eyJhbGciOiJSUzI1NiJ9", "eyJzdWIiOiJzeW50aGV0aWMifQ", "c2lnbmF0dXJl"].join("."),
      secret: ["GOCSPX", "SyntheticClientSecret_0"].join("-"),
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    log.error(`token refresh failed for ${secrets.refresh}`, {
      reason: `Bearer ${secrets.access}; code=${secrets.code} id_token=${secrets.idToken}`,
      error: `client_secret ${secrets.secret} rejected`,
      connectionId: "0c1d2e3f-0000-4000-8000-000000000000",
    });
    const line = String(spy.mock.calls[0]![0]);
    for (const [name, value] of Object.entries(secrets)) {
      expect(line, name).not.toContain(value);
    }
    expect(line).toContain("[token redacted]");
    expect(line).toContain("Bearer [token redacted]");
    expect(line).toContain("0c1d2e3f-0000-4000-8000-000000000000");
    expect(describeError(new Error(`invalid_grant for ${secrets.refresh}`))).toBe(
      "Error: invalid_grant for [token redacted]",
    );
    // Ordinary words that share a prefix with one of those shapes are left alone.
    expect(scrub("status=401 scope=calendar.events.owned v4/events eyJ")).toBe(
      "status=401 scope=calendar.events.owned v4/events eyJ",
    );
  });

  test("Google's OAuth material is caught form- and URL-encoded too, as its token, revoke and callback traffic carries it", () => {
    // Synthetic, and built from parts, as above.
    const refresh = ["1", "", "0gSyntheticRefresh-Token_456"].join("/");
    const code = ["4", "0AQSTgQSyntheticAuthCode_789"].join("/");
    const secret = ["GOCSPX", "SyntheticClientSecret_0"].join("-");
    const verifier = ["synthetic", "code", "verifier", "0123456789abcdef"].join("-");
    const opaque = ["opaque", "access", "value", "42"].join("_");

    // The refresh exchange, the code exchange and the revocation, as the
    // connectors send them (packages/connectors/src/google/oauth.ts).
    const refreshBody = new URLSearchParams({
      client_id: "synthetic-client.apps.googleusercontent.test",
      client_secret: secret,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }).toString();
    const codeBody = new URLSearchParams({
      code,
      code_verifier: verifier,
      redirect_uri: "https://app.healdesk.test/api/calendar/google/callback",
      grant_type: "authorization_code",
    }).toString();
    const revokeBody = new URLSearchParams({ token: refresh }).toString();
    // Google's redirect back, as a path with no scheme: the code URL-encoded.
    const callback = `/api/calendar/google/callback?code=${encodeURIComponent(code)}&state=abc`;
    // A token of no shape Google is known to issue, named by its parameter.
    const named = `access_token=${opaque}&token_type=Bearer`;

    for (const text of [refreshBody, codeBody, revokeBody, callback, named]) {
      const out = scrub(text);
      for (const value of [refresh, code, secret, verifier, opaque]) {
        expect(out, text).not.toContain(value);
        expect(out, text).not.toContain(encodeURIComponent(value));
      }
    }
    expect(scrub(revokeBody)).toBe("token=[token redacted]");
    expect(scrub(callback)).toBe("/api/calendar/google/callback?code=[token redacted]&state=abc");
    expect(scrub(named)).toBe("access_token=[token redacted]&token_type=Bearer");
    expect(scrub(refreshBody)).toContain("refresh_token=[token redacted]&grant_type=refresh_token");

    // And through the logger, in a message and a field alike.
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    log.warn(`google token exchange refused: ${refreshBody}`, { reason: codeBody });
    const line = String(spy.mock.calls[0]![0]);
    for (const value of [refresh, code, secret, verifier]) {
      expect(line).not.toContain(encodeURIComponent(value));
    }
  });

  test("describeError keeps the name and message and drops the rest", () => {
    const error = new Error("connect ECONNREFUSED for owner@clinic.test");
    expect(describeError(error)).toBe("Error: connect ECONNREFUSED for [email redacted]");
    expect(describeError("boom")).toBe("unknown error");
  });

  test("describeError gives the database's own error under drizzle's wrapper, never the query or its parameters", () => {
    // drizzle-orm 0.45 puts the SQL and every bound value in its wrapper's
    // message; the values here are the shapes a booking's own would take.
    const query =
      'update "booking_requests" set "status" = $1, "confirmed_for" = $2, "decided_by_label" = $3 where "booking_requests"."id" = $4';
    const params = [
      "confirmed",
      "2026-10-15T14:00:00.000Z",
      "assistant (direct booking)",
      "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    ];
    const cause = Object.assign(
      new Error('duplicate key value violates unique constraint "booking_requests_vendor_call_idx"'),
      { name: "DatabaseError", code: "23505" },
    );
    const wrapped = new DrizzleQueryError(query, params, cause);
    expect(wrapped.message).toContain("2026-10-15T14:00:00.000Z");

    const described = describeError(wrapped);
    expect(described).toBe(
      'DatabaseError: duplicate key value violates unique constraint "booking_requests_vendor_call_idx"',
    );
    for (const leaked of ["Failed query", "params", 'update "booking_requests"', "2026-10-15", "direct booking"]) {
      expect(described).not.toContain(leaked);
    }

    // With nothing under it (a pool timeout, a dropped socket): only that it failed.
    expect(describeError(new DrizzleQueryError(query, params))).toBe(
      "Error: query failed before the database answered",
    );

    // And through the logger, as every caller passes it.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    log.error("assistant calendar write failed after the call moved on", {
      error: describeError(wrapped),
    });
    const line = String(spy.mock.calls[0]![0]);
    expect(line).not.toContain("2026-10-15");
    expect(line).not.toContain("assistant (direct booking)");
    expect(line).toContain("booking_requests_vendor_call_idx");
  });
});
