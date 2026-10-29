import { CHANNELS } from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import type { ChannelWaitingOn } from "@/db/schema";
import type { ChannelStatus } from "@/lib/channels/state";
import {
  actionButtonLabel,
  channelActionHref,
  channelPresentation,
  metaNeedsReconnect,
  waitingLabel,
} from "@/lib/setup/channel-status";

const NOW = new Date("2026-10-19T16:00:00Z");
const ZONE = "America/New_York";

function present(
  channel: (typeof CHANNELS)[number],
  status: ChannelStatus,
  extra: {
    waitingOn?: ChannelWaitingOn | null;
    liveAt?: Date | null;
    pausedUntil?: Date | null;
    setupFinished?: boolean;
    needsReconnect?: boolean;
  } = {},
) {
  return channelPresentation(
    {
      channel,
      status,
      waitingOn: extra.waitingOn ?? null,
      liveAt: extra.liveAt ?? null,
      pausedUntil: extra.pausedUntil ?? null,
    },
    {
      setupFinished: extra.setupFinished ?? true,
      timeZone: ZONE,
      now: NOW,
      needsReconnect: extra.needsReconnect,
    },
  );
}

describe("channelPresentation", () => {
  test("live says since when and has no button", () => {
    const p = present("web", "live", { liveAt: new Date("2026-10-14T15:00:00Z") });
    expect(p.kind).toBe("live");
    expect(p.label).toBe("Live since 14 October");
    expect(p.action).toBeNull();
  });

  test("paused names its end, or that it is open-ended, with no button", () => {
    const until = present("voice", "paused", { pausedUntil: new Date("2099-03-02T19:00:00Z") });
    expect(until.kind).toBe("paused");
    expect(until.label).toMatch(/^Paused until .* 2 March 2099$/);
    expect(present("voice", "paused").label).toBe("Paused until you switch AYA back on");
    expect(until.action).toBeNull();
  });

  test("off is off, whatever else is outstanding", () => {
    const p = present("meta", "off", { setupFinished: false, needsReconnect: true });
    expect(p).toMatchObject({ kind: "off", label: "Off", action: null });
    expect(p.detail).toContain("Settings");
  });

  test("each thing a channel can wait for is named in the label and has one button", () => {
    const cases: [(typeof CHANNELS)[number], ChannelWaitingOn, string, string][] = [
      ["voice", "direct_line", "Waiting for your direct line", "Add your direct line"],
      ["web", "snippet", "Waiting for the line on your website", "Get the line to paste"],
      ["voice", "forwarding", "Waiting for call forwarding", "See the forwarding steps"],
      ["meta", "meta_connect", "Waiting for your Facebook login", "Connect with Facebook"],
      [
        "meta",
        "whatsapp_payment_method",
        "Waiting for a WhatsApp payment method",
        "Open WhatsApp in Meta",
      ],
    ];
    for (const [channel, waitingOn, label, button] of cases) {
      const p = present(channel, "waiting", { waitingOn });
      expect(p.kind).toBe("waiting");
      expect(p.label).toBe(label);
      expect(p.action).toEqual({ step: waitingOn, label: button });
    }
  });

  test("an unfinished wizard comes first for every waiting channel", () => {
    for (const channel of CHANNELS) {
      const p = present(channel, "waiting", { waitingOn: "snippet", setupFinished: false });
      expect(p.label).toBe("Waiting for you to finish setup");
      expect(p.action?.step).toBe("finish_setup");
    }
    // Ready with no named action is still the clinic's to finish.
    expect(present("web", "waiting", { waitingOn: "setup" }).action?.step).toBe("finish_setup");
    expect(present("web", "waiting", { waitingOn: null }).action?.step).toBe("finish_setup");
  });

  test("being prepared has nothing to press, finished or not", () => {
    const p = present("voice", "setting_up");
    expect(p).toMatchObject({ kind: "preparing", label: "Being prepared", action: null });
    expect(present("voice", "setting_up", { setupFinished: false }).action?.step).toBe("finish_setup");
  });

  test("a dropped Meta login is the one thing Meta waits for, live or not", () => {
    for (const status of ["live", "waiting", "setting_up"] as const) {
      const p = present("meta", status, { needsReconnect: true, liveAt: new Date("2026-10-14T15:00:00Z") });
      expect(p.kind).toBe("waiting");
      expect(p.label).toBe("Waiting for you to reconnect");
      expect(p.detail).toContain("dropped");
      expect(p.action).toEqual({ step: "reconnect", label: "Reconnect" });
    }
    // Only Meta has logins, and a pause or a switch Off wins.
    expect(present("web", "live", { needsReconnect: true }).kind).toBe("live");
    expect(present("meta", "paused", { needsReconnect: true }).kind).toBe("paused");
  });

  test("metaNeedsReconnect reads either login", () => {
    const ok = { facebook: { state: "connected" as const, names: [] }, whatsapp: { state: "none" as const } };
    expect(metaNeedsReconnect(null)).toBe(false);
    expect(metaNeedsReconnect(ok)).toBe(false);
    expect(metaNeedsReconnect({ ...ok, whatsapp: { state: "needs_reconnect" } })).toBe(true);
    expect(metaNeedsReconnect({ ...ok, facebook: { state: "needs_reconnect", names: [] } })).toBe(true);
  });

  test("no sentence promises a time or a date, and every status is present for every channel", () => {
    const statuses: ChannelStatus[] = ["off", "paused", "live", "waiting", "setting_up"];
    const waits: (ChannelWaitingOn | null)[] = [null, "setup", "direct_line", "snippet", "forwarding", "meta_connect", "whatsapp_payment_method"];
    for (const channel of CHANNELS) {
      for (const status of statuses) {
        for (const waitingOn of waits) {
          for (const setupFinished of [true, false]) {
            const p = present(channel, status, { waitingOn, setupFinished });
            const words = `${p.label} ${p.detail} ${p.action?.label ?? ""}`;
            expect(words, words).not.toMatch(/minute|\bhour|two minutes|within|soon|opens? on/i);
            expect(p.label.length).toBeGreaterThan(0);
            expect(p.detail.length).toBeGreaterThan(0);
            expect(["live", "waiting", "paused", "off", "preparing"]).toContain(p.kind);
          }
        }
      }
    }
  });

  test("labels and buttons exist for every step", () => {
    for (const step of ["finish_setup", "setup", "direct_line", "snippet", "forwarding", "meta_connect", "whatsapp_payment_method"] as const) {
      expect(waitingLabel(step)).toMatch(/^Waiting for /);
      expect(actionButtonLabel(step).length).toBeGreaterThan(0);
    }
  });
});

describe("channelActionHref", () => {
  const act = (step: Parameters<typeof actionButtonLabel>[0]) => ({ step, label: actionButtonLabel(step) });
  test("the wizard links only to where the step is not already below the row", () => {
    expect(channelActionHref("wizard", "c1", act("snippet"))).toBeNull();
    expect(channelActionHref("wizard", "c1", act("meta_connect"))).toBeNull();
    expect(channelActionHref("wizard", "c1", act("direct_line"))).toBe("/c/c1/setup?s=direct_line");
  });
  test("settings links to the card holding the step", () => {
    expect(channelActionHref("settings", "c1", act("snippet"))).toBe("#website-line");
    expect(channelActionHref("settings", "c1", act("reconnect"))).toBe("#meta-connections");
    expect(channelActionHref("settings", "c1", act("direct_line"))).toBe("/c/c1/settings#safety-net");
    expect(channelActionHref("settings", "c1", act("finish_setup"))).toBe("/c/c1/setup");
    expect(channelActionHref("settings", "c1", act("whatsapp_payment_method"))).toBeNull();
  });
});
