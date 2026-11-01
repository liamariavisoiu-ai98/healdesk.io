import { describe, expect, test } from "vitest";

import { connectionRows, settingsSections } from "@/lib/portal/settings-overview";

/**
 * Settings' top card (portal redesign, second slice, owner, 1 November
 * 2026): each connection, where it stands and one button to the card that
 * makes it. The button only ever links within Settings: the connecting
 * itself (Google's notice, the payment checks, the Facebook login) stays in
 * its own card.
 */

const PATH = "/c/lumen/settings";
const noCalendar = { canConnect: true, blockedLine: null, connection: null };
const healthy = {
  canConnect: true,
  blockedLine: null,
  connection: {
    email: "desk@example.com",
    account: "desk@example.com",
    calendar: "Front desk",
    health: "healthy" as const,
    healthLine: null,
    lastCheckedAt: null,
  },
};
const meta = (facebook: "none" | "connected" | "needs_reconnect", whatsapp: typeof facebook = "none", available = true) => ({
  facebook: { state: facebook, names: [] },
  whatsapp: { state: whatsapp },
  available: { facebook: available, whatsapp: available },
});

describe("connectionRows", () => {
  test("nothing connected: each says what connecting does, with Connect into its card", () => {
    const rows = connectionRows({
      settingsPath: PATH,
      calendar: noCalendar,
      payments: { connectAvailable: true, isConnected: false },
      meta: meta("none"),
    });
    expect(rows.map((r) => [r.key, r.state, r.action?.label, r.action?.href])).toEqual([
      ["calendar", "not_connected", "Connect", "/c/lumen/settings#calendar"],
      ["payments", "not_connected", "Connect", "/c/lumen/settings#payments"],
      ["facebook", "not_connected", "Connect", "/c/lumen/settings#channels"],
    ]);
    expect(rows[0]!.line).toBe("Connect it and AYA books straight into it.");
  });

  test("all connected: Manage, and the calendar named", () => {
    const rows = connectionRows({
      settingsPath: PATH,
      calendar: healthy,
      payments: { connectAvailable: true, isConnected: true },
      meta: meta("connected", "connected"),
    });
    expect(rows.map((r) => [r.state, r.stateLabel, r.action?.label])).toEqual([
      ["connected", "Connected", "Manage"],
      ["connected", "Connected", "Manage"],
      ["connected", "Connected", "Manage"],
    ]);
    expect(rows[0]!.line).toBe("AYA books into Front desk.");
  });

  test("a broken calendar or Facebook login asks to reconnect", () => {
    const rows = connectionRows({
      settingsPath: PATH,
      calendar: { ...healthy, connection: { ...healthy.connection, health: "needs_reconnect" as const } },
      payments: { connectAvailable: true, isConnected: true },
      meta: meta("needs_reconnect", "connected"),
    });
    expect(rows[0]).toMatchObject({ state: "attention", stateLabel: "Needs reconnecting", action: { label: "Reconnect" } });
    expect(rows[2]).toMatchObject({ state: "attention", action: { label: "Reconnect" } });
  });

  test("only one of Facebook and WhatsApp connected: Finish", () => {
    const rows = connectionRows({
      settingsPath: PATH,
      calendar: healthy,
      payments: { connectAvailable: true, isConnected: true },
      meta: meta("connected", "none"),
    });
    expect(rows[2]).toMatchObject({ state: "connected", action: { label: "Finish" } });
  });

  test("what cannot be connected yet says so in one line, with no button", () => {
    const rows = connectionRows({
      settingsPath: PATH,
      calendar: { canConnect: false, blockedLine: "Connecting a calendar isn't available yet.", connection: null },
      payments: { connectAvailable: false, isConnected: false },
      meta: meta("none", "none", false),
    });
    expect(rows.map((r) => [r.state, r.line, r.action])).toEqual([
      ["unavailable", "Connecting a calendar isn't available yet.", null],
      ["unavailable", "Taking deposits isn't available yet.", null],
      ["unavailable", "Connecting these isn't available yet.", null],
    ]);
  });

  test("no Facebook row when Instagram, Messenger and WhatsApp weren't bought", () => {
    const rows = connectionRows({
      settingsPath: PATH,
      calendar: noCalendar,
      payments: { connectAvailable: true, isConnected: false },
      meta: null,
    });
    expect(rows.map((r) => r.key)).toEqual(["calendar", "payments"]);
  });

  test("every button stays inside Settings", () => {
    const rows = connectionRows({
      settingsPath: PATH,
      calendar: noCalendar,
      payments: { connectAvailable: true, isConnected: false },
      meta: meta("none"),
    });
    for (const r of rows) expect(r.action?.href.startsWith(`${PATH}#`)).toBe(true);
  });
});

describe("settingsSections", () => {
  test("the cards in the page's order, Locations only when there is one", () => {
    expect(settingsSections(false).map((s) => s.id)).toEqual([
      "channels",
      "how-aya-talks",
      "calendar",
      "payments",
      "safety-net",
      "alerts",
      "sign-in",
    ]);
    expect(settingsSections(true)[0]).toEqual({ id: "locations", label: "Locations" });
  });
});
