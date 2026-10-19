import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { PauseSwitch } from "@/app/c/[slug]/PauseSwitch";
import { PortalShell, type ShellProps } from "@/app/c/[slug]/PortalShell";
import { pauseEndFor } from "@/lib/channels/pause-words";
import type { ChannelState } from "@/lib/channels/state";
import { answeringControl } from "@/lib/portal/header";

/**
 * The header's AYA is answering switch (plan Part F0), without a database:
 * what it holds before go-live, on, and paused, and the header as a clinic's
 * browser receives it. lib/channels/pause.ts and tests/pause-control.test.ts
 * cover what pressing it does.
 */

const ZONE = "America/New_York";
/** 11:00 am EDT, Thursday 15 October 2026. */
const NOW = new Date("2026-10-15T15:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (ms: number) => new Date(NOW.getTime() + ms);
const LINE = "+14155550123";
const DEVICE = "Front desk Mac";

function channel(over: Partial<ChannelState> & Pick<ChannelState, "channel">): ChannelState {
  return {
    enabled: true,
    readyAt: null,
    waitingOn: null,
    liveAt: null,
    firstAnswerAt: null,
    pausedUntil: null,
    status: "setting_up",
    ...over,
  };
}

describe("the header's switch", () => {
  const live = new Date("2026-10-01T00:00:00Z");
  const base = {
    directLineE164: LINE,
    pause: { pausedAt: null, byLabel: null, until: null },
    timeZone: ZONE,
    now: NOW,
  };

  test("none before go-live, nor while every live channel is switched off in Settings", () => {
    expect(answeringControl({ ...base, channels: [channel({ channel: "web" })] })).toBeNull();
    expect(
      answeringControl({
        ...base,
        channels: [channel({ channel: "web", liveAt: live, enabled: false, status: "off" })],
      }),
    ).toBeNull();
  });

  test("on: one line per channel that answers, phone first, and the three ways off", () => {
    const control = answeringControl({
      ...base,
      channels: [
        channel({ channel: "web", liveAt: live, status: "live" }),
        channel({ channel: "meta", liveAt: live, enabled: false, status: "off" }),
        channel({ channel: "voice", liveAt: live, status: "live" }),
      ],
    });
    expect(control).toEqual({
      paused: false,
      lines: [
        "Phone: calls go to your direct line ((415) 555-0123)",
        "Website chat: shows a contact form",
      ],
      banner: null,
      choices: [
        { id: "hour", label: "For 1 hour" },
        { id: "tomorrow", label: "Until tomorrow 8 am" },
        { id: "indefinite", label: "Until I turn it back on" },
      ],
    });
  });

  test("paused: the banner, from the pause's own stamps", () => {
    const until = at(HOUR);
    const control = answeringControl({
      ...base,
      pause: { pausedAt: at(-MINUTE), byLabel: DEVICE, until },
      channels: [channel({ channel: "web", liveAt: live, status: "paused", pausedUntil: until })],
    });
    expect(control).toMatchObject({
      paused: true,
      banner: "Paused from Front desk Mac at 10:59 am, until 12 pm.",
      lines: ["Website chat: shows a contact form"],
    });
  });

  function shell(over: Partial<ShellProps>): string {
    const props: ShellProps = {
      slug: "glow",
      clinicName: "Glow Med Spa",
      section: "home",
      audience: "patients",
      status: { kind: "answering" },
      timeZone: ZONE,
      locations: [],
      children: null,
      ...over,
    };
    return renderToStaticMarkup(createElement(PortalShell, props));
  }

  test("before go-live the header keeps its line and its link to the tracker, with no switch", () => {
    const html = shell({ status: { kind: "not_yet" }, answering: null });
    expect(html).toContain("AYA isn’t answering patients yet.");
    expect(html).toContain('href="/c/glow#tracker"');
    expect(html).not.toContain('role="switch"');
    expect(shell({ status: { kind: "not_yet" }, audience: "clients", answering: null })).toContain(
      "AYA isn’t answering clients yet.",
    );
  });

  test("after go-live: AYA is answering [On], a switch with its own polite status region, targets of 44px, and no undo steps", () => {
    const control = answeringControl({
      ...base,
      channels: [
        channel({ channel: "voice", liveAt: live, status: "live" }),
        channel({ channel: "web", liveAt: live, status: "live" }),
      ],
    })!;
    const html = shell({ answering: control });
    const own = renderToStaticMarkup(createElement(PauseSwitch, { slug: "glow", control }));
    expect(html).toContain("AYA is answering");
    expect(html).toMatch(
      /<button[^>]*role="switch"[^>]*aria-checked="true"[^>]*class="[^"]*min-h-11/,
    );
    expect(html).toMatch(/role="status" aria-live="polite"/);
    for (const label of ["For 1 hour", "Until tomorrow 8 am", "Until I turn it back on"]) {
      expect(html).toMatch(
        new RegExp(`<button[^>]*class="[^"]*min-h-11[^"]*"[^>]*>${label}</button>`),
      );
    }
    expect(html).toContain("Phone: calls go to your direct line ((415) 555-0123)");
    expect(html).toContain("Website chat: shows a contact form");
    // The forwarding undo codes live in Settings, Safety net, never here.
    expect(own).not.toMatch(/\*7[23]|\*9[13]|undo/i);
  });

  test("paused: the switch is Off and the banner says from which device, when, and until when", () => {
    const until = pauseEndFor("tomorrow", NOW, ZONE);
    const control = answeringControl({
      ...base,
      pause: { pausedAt: at(-46 * MINUTE), byLabel: DEVICE, until },
      channels: [channel({ channel: "voice", liveAt: live, status: "paused", pausedUntil: until })],
    })!;
    const html = shell({ status: { kind: "paused", until }, answering: control });
    expect(html).toMatch(/role="switch"[^>]*aria-checked="false"/);
    expect(html).toContain("Paused from Front desk Mac at 10:14 am, until 8 am tomorrow.");
    expect(html).toContain("Phone: calls go to your direct line ((415) 555-0123)");
  });
});
