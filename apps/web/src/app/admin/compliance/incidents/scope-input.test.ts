import { describe, expect, test } from "vitest";

import { checkScopeQuery, holdsAll, scopeQueryFrom, type ScopeForm } from "./scope-input";

/**
 * The scope form as the query apps/app reads: UTC days to instants, the end
 * held to now, the class and discovery together or neither, the reach only
 * for the two holding vendors; and the same checks on what a browser sends
 * back, so a value off a list never reaches the signed request.
 */

const NOW = "2026-11-03T12:00:00.000Z";

const form: ScopeForm = {
  source: "vendor",
  vendor: "retell",
  channel: "voice",
  fromDay: "2026-10-30",
  toDay: "2026-10-31",
  incidentClass: "",
  discoveredAt: "",
  includeDemo: false,
  reach: "window_only",
};

describe("the form as a query", () => {
  test("a vendor's window by UTC days, no class, no reach sent for a vendor read by its window", () => {
    expect(scopeQueryFrom(form, NOW)).toEqual({ ok: true, query: { vendor: "retell", from: "2026-10-30T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" } });
    expect(scopeQueryFrom({ ...form, source: "channel", channel: "web", includeDemo: true }, NOW)).toEqual({
      ok: true,
      query: { channel: "web", from: "2026-10-30T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z", includeDemo: true },
    });
  });

  test("the window's end is held to now; a day in the future is refused", () => {
    expect(scopeQueryFrom({ ...form, toDay: "2026-11-03" }, NOW)).toMatchObject({ ok: true, query: { to: NOW } });
    expect(scopeQueryFrom({ ...form, fromDay: "2026-11-04", toDay: "2026-11-05" }, NOW)).toEqual({ ok: false, problem: "The window cannot start in the future." });
    expect(scopeQueryFrom({ ...form, fromDay: "2026-10-31", toDay: "2026-10-30" }, NOW)).toEqual({ ok: false, problem: "The window's first day must not be after its last." });
    expect(scopeQueryFrom({ ...form, fromDay: "2025-01-01", toDay: "2026-10-31" }, NOW)).toEqual({ ok: false, problem: "The window is at most 400 days." });
    expect(scopeQueryFrom({ ...form, fromDay: "2026-02-31" }, NOW)).toEqual({ ok: false, problem: "Give the window as two days, the first and the last." });
  });

  test("the class and the discovery time go together, the discovery inside the window and in the past", () => {
    expect(scopeQueryFrom({ ...form, incidentClass: "breach" }, NOW)).toEqual({ ok: false, problem: "Give the class and the discovery time together, or neither." });
    expect(scopeQueryFrom({ ...form, discoveredAt: "2026-10-31T08:00:00.000Z" }, NOW)).toEqual({ ok: false, problem: "Give the class and the discovery time together, or neither." });
    expect(scopeQueryFrom({ ...form, incidentClass: "breach", discoveredAt: "2026-10-31T08:00:00.000Z" }, NOW)).toEqual({
      ok: true,
      query: { vendor: "retell", from: "2026-10-30T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z", class: "breach", discoveredAt: "2026-10-31T08:00:00.000Z" },
    });
    expect(scopeQueryFrom({ ...form, incidentClass: "theft", discoveredAt: "2026-10-31T08:00:00.000Z" }, NOW)).toEqual({ ok: false, problem: "Pick the class from the list." });
    expect(scopeQueryFrom({ ...form, incidentClass: "breach", discoveredAt: "2026-10-29T08:00:00.000Z" }, NOW)).toEqual({ ok: false, problem: "It cannot have been discovered before the window began." });
    expect(scopeQueryFrom({ ...form, incidentClass: "breach", discoveredAt: "2026-11-03T13:00:00.000Z" }, NOW)).toEqual({ ok: false, problem: "When was it discovered? A past time." });
  });

  test("the reach: the database host and AWS may reach every clinic holding data; nothing else may", () => {
    expect(holdsAll({ source: "vendor", vendor: "aws" })).toBe(true);
    expect(holdsAll({ source: "vendor", vendor: "anthropic" })).toBe(false);
    expect(holdsAll({ source: "channel", vendor: "aws" })).toBe(false);
    expect(scopeQueryFrom({ ...form, vendor: "database_host", reach: "all_holding" }, NOW)).toMatchObject({ ok: true, query: { vendor: "database_host", reach: "all_holding" } });
    expect(scopeQueryFrom({ ...form, vendor: "database_host", reach: "window_only" }, NOW)).toMatchObject({ ok: true, query: { vendor: "database_host", reach: "window_only" } });
    expect(scopeQueryFrom({ ...form, reach: "all_holding" }, NOW)).toEqual({
      ok: false,
      problem: "Only the database host and AWS hold every clinic's data; this scope is read by its window.",
    });
    expect(scopeQueryFrom({ ...form, reach: "everyone" }, NOW)).toEqual({ ok: false, problem: "Pick the reach from the list." });
  });

  test("a vendor or a channel off the list is refused", () => {
    expect(scopeQueryFrom({ ...form, vendor: "stripe" }, NOW)).toEqual({ ok: false, problem: "Pick the vendor from the list." });
    expect(scopeQueryFrom({ ...form, source: "channel", channel: "sms" }, NOW)).toEqual({ ok: false, problem: "Pick the channel from the list." });
  });
});

describe("a query sent back by a browser", () => {
  test("the one the form made passes unchanged, its instants kept", () => {
    const made = scopeQueryFrom({ ...form, vendor: "aws", reach: "window_only", incidentClass: "security_incident", discoveredAt: "2026-10-31T08:00:00.000Z", includeDemo: true }, NOW);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(checkScopeQuery(made.query, NOW)).toEqual({ ok: true, query: made.query });
    // An end held to now is kept as it was sent.
    const clamped = scopeQueryFrom({ ...form, toDay: "2026-11-03" }, NOW);
    if (!clamped.ok) throw new Error("not made");
    expect(checkScopeQuery(clamped.query, NOW)).toEqual({ ok: true, query: clamped.query });
  });

  test("anything else is refused: a key the scope has not, both a vendor and a channel, a code off a list, a non-boolean", () => {
    expect(checkScopeQuery({ vendor: "retell", from: "2026-10-30T00:00:00.000Z", to: "2026-10-31T00:00:00.000Z", summary: "x" }, NOW)).toEqual({ ok: false, problem: "The scope could not be read." });
    expect(checkScopeQuery({ vendor: "retell", channel: "voice", from: "2026-10-30T00:00:00.000Z", to: "2026-10-31T00:00:00.000Z" }, NOW)).toEqual({
      ok: false,
      problem: "Name a vendor or a channel, one of the two.",
    });
    expect(checkScopeQuery({ vendor: "stripe", from: "2026-10-30T00:00:00.000Z", to: "2026-10-31T00:00:00.000Z" }, NOW)).toEqual({ ok: false, problem: "Pick the vendor from the list." });
    expect(checkScopeQuery({ vendor: "retell", from: "yesterday", to: "2026-10-31T00:00:00.000Z" }, NOW)).toEqual({ ok: false, problem: "Give the window as two times, from and to." });
    expect(checkScopeQuery({ vendor: "retell", from: "2026-10-30T00:00:00.000Z", to: "2026-10-31T00:00:00.000Z", includeDemo: "yes" }, NOW)).toEqual({ ok: false, problem: "The scope could not be read." });
    expect(checkScopeQuery("retell", NOW)).toEqual({ ok: false, problem: "The scope could not be read." });
  });
});
