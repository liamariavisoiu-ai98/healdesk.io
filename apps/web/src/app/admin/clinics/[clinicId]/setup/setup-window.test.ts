// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { LifecycleRow } from "@/lib/admin/ops-client";

import { daysLeft, defaultExtendDays, LET_CLOSE_CONFIRM, SetupWindow } from "./SetupWindow";

/**
 * The Setup tab's "Setup window" card (wave 2, lane A3): the watch's row in
 * words, the billing view's deadline with the days left computed from it,
 * the recommendation sentence as it came, and the controls the alerts
 * quote, each drawn only where it applies and each calling the right
 * operation with the right argument: "Extend the setup window" names the
 * deadline shown; "Let it close" asks once with a true sentence.
 */

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const NOW = "2026-10-24T09:00:00.000Z";
const DEADLINE = { at: "2026-11-01 00:00 UTC", iso: "2026-11-01T00:00:00.000Z" };
const NEVER = async (): Promise<never> => {
  throw new Error("an action ran during a static render");
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&rsquo;|’/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const row: LifecycleRow = {
  clinicId: CLINIC,
  clinicSlug: "radiance",
  clinicName: "Radiance Med Spa",
  stage: "in_setup",
  stageSince: "2026-10-02T09:00:00.000Z",
  stepsLeft: 2,
  channelsWaiting: 1,
  lastProgressAt: "2026-10-15T14:00:00.000Z",
  // The watch's own snapshot of the deadline, which the card must not extend from.
  deadlineAt: "2026-10-25T00:00:00.000Z",
  remainingDays: 1,
  decision: "none",
  decidedBy: null,
  decidedAt: null,
  snoozedUntil: null,
  snoozedBy: null,
  undeliveredCount: 1,
  decisionOwed: true,
  recommendation: { action: "extend", days: 14, reason: "The clinic made progress in the last week and two steps are left: extend by 14 days." },
};

const base = { row, deadline: DEADLINE, canExtend: true, now: NOW, onExtend: NEVER, onDecide: NEVER, onSnooze: NEVER };

describe("the card's words", () => {
  test("stage, the billing deadline with the days left from it, last progress, decision, snooze, and the watch's sentence once", () => {
    const html = renderToStaticMarkup(h(SetupWindow, base));
    const page = text(html);
    expect(html).toContain('id="setup-window"');
    expect(page).toContain("Stage in setup since 2026-10-02");
    // The billing view's deadline and its days, not the watch's snapshot (1 day).
    expect(page).toContain("Window ends 2026-11-01 00:00 UTC: 8 days left");
    expect(page).not.toContain("1 day left");
    expect(page).toContain("Last progress 2026-10-15");
    expect(page).toContain("Decision so far none yet");
    expect(page).toContain("Routine ops alerts on");
    expect(page).toContain("The clinic made progress in the last week and two steps are left: extend by 14 days.");
    expect(page).not.toContain("Recommended:");
    // Not repeated here: the header's stage chip, the summary's steps and channels, the Reminders count.
    expect(page).not.toContain("Steps left");
    expect(page).not.toContain("channel waiting");
    expect(page).not.toContain("undelivered");
    expect(html).toMatch(/aria-label="Days to extend by"[^>]*value="14"/);
    for (const label of ["Extend the setup window", "Offered a call", "Let it close", "Snooze alerts"]) expect(page).toContain(label);
  });

  test("a decided, snoozed clinic says so; an extended one says 'Extended on'", () => {
    const decided: LifecycleRow = { ...row, decision: "extension_offered", decidedAt: "2026-10-20T10:00:00.000Z", decidedBy: "ops@healdesk.test", snoozedUntil: "2026-10-30T00:00:00.000Z", snoozedBy: "ops@healdesk.test" };
    const page = text(renderToStaticMarkup(h(SetupWindow, { ...base, row: decided })));
    expect(page).toContain("Decision so far a call was offered (2026-10-20, ops@healdesk.test)");
    expect(page).toContain("Routine ops alerts snoozed until 2026-10-30 by ops@healdesk.test");
    const extended = text(renderToStaticMarkup(h(SetupWindow, { ...base, row: { ...row, decision: "extended", decidedAt: "2026-10-21T10:00:00.000Z", decidedBy: "ops@healdesk.test" } })));
    expect(extended).toContain("Decision so far Extended on 2026-10-21, ops@healdesk.test");
    expect(extended).not.toContain("setup deadline extended");
  });

  test("Extend is drawn only while the plan has not started and a deadline exists; the decisions only in the deciding stages", () => {
    const noPlanGate = text(renderToStaticMarkup(h(SetupWindow, { ...base, canExtend: false })));
    expect(noPlanGate).not.toContain("Extend the setup window");
    expect(noPlanGate).toContain("Offered a call");
    const noDeadline = text(renderToStaticMarkup(h(SetupWindow, { ...base, deadline: null })));
    expect(noDeadline).toContain("Window ends no setup deadline on the billing account");
    expect(noDeadline).not.toContain("Extend the setup window");
    for (const stage of ["partly_live", "live", "closed"] as const) {
      const page = text(renderToStaticMarkup(h(SetupWindow, { ...base, row: { ...row, stage }, canExtend: false })));
      for (const label of ["Offered a call", "Let it close", "Snooze alerts", "Extend the setup window"]) expect(page, stage).not.toContain(label);
    }
    for (const stage of ["not_started", "in_setup", "waiting_on_us"] as const) {
      const page = text(renderToStaticMarkup(h(SetupWindow, { ...base, row: { ...row, stage } })));
      for (const label of ["Offered a call", "Let it close", "Snooze alerts"]) expect(page, stage).toContain(label);
    }
  });

  test("the days left and the default days are held to what is true and allowed", () => {
    expect(daysLeft("2026-11-01T00:00:00.000Z", NOW)).toBe(8);
    expect(daysLeft("2026-10-24T08:00:00.000Z", NOW)).toBe(0);
    expect(daysLeft("soon", NOW)).toBeNull();
    expect(defaultExtendDays(14)).toBe(14);
    expect(defaultExtendDays(null)).toBe(7);
    expect(defaultExtendDays(0)).toBe(1);
    expect(defaultExtendDays(45)).toBe(30);
    expect(defaultExtendDays(2.6)).toBe(3);
  });
});

describe("the four controls", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  function button(label: string): HTMLButtonElement {
    const found = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
    if (!found) throw new Error(`no button "${label}"`);
    return found;
  }
  const statuses = () => [...container.querySelectorAll('[role="status"]')].map((n) => n.textContent ?? "");

  test("Extend names the deadline shown and the days typed; Offered a call and Snooze send their arguments", async () => {
    const onExtend = vi.fn(async (input: { days: number; fromDeadline: string }) => ({
      ok: true as const,
      data: { status: "extended" as const, setupDeadlineAt: `2026-11-${String(1 + input.days).padStart(2, "0")} 00:00 UTC`, auditRecorded: true },
    }));
    const onDecide = vi.fn(async () => ({ ok: true as const, data: { outcome: "saved" as const, auditRecorded: true } }));
    const onSnooze = vi.fn(async () => ({ ok: true as const, data: { outcome: "saved" as const, auditRecorded: true } }));
    await act(async () => {
      root.render(h(SetupWindow, { ...base, onExtend, onDecide, onSnooze }));
    });
    await act(async () => {
      button("Extend the setup window").click();
    });
    await act(async () => {});
    expect(onExtend).toHaveBeenCalledWith({ days: 14, fromDeadline: DEADLINE.iso });
    expect(statuses()).toContain("Extended to 2026-11-15 00:00 UTC.");

    await act(async () => {
      button("Offered a call").click();
    });
    await act(async () => {});
    expect(onDecide).toHaveBeenCalledWith("extension_offered");
    expect(statuses()).toContain("Recorded: a call was offered.");

    await act(async () => {
      button("Snooze alerts").click();
    });
    await act(async () => {});
    expect(onSnooze).toHaveBeenCalledWith(7);
    expect(statuses()).toContain("Routine ops alerts snoozed for 7 days.");
  });

  test("Let it close asks once with the true sentence, then records let_close; a clinic not watched is said", async () => {
    const onDecide = vi.fn(async () => ({ ok: true as const, data: { outcome: "not_watched" as const } }));
    await act(async () => {
      root.render(h(SetupWindow, { ...base, onDecide }));
    });
    await act(async () => {
      button("Let it close").click();
    });
    expect(onDecide).not.toHaveBeenCalled();
    expect(container.textContent).toContain(LET_CLOSE_CONFIRM);
    expect(LET_CLOSE_CONFIRM).toBe(
      "The clinic's setup window will still close on its last day. The day-27 and day-30 warnings to ops stop; other alerts about this clinic continue.",
    );
    await act(async () => {
      button("Yes, let it close").click();
    });
    await act(async () => {});
    expect(onDecide).toHaveBeenCalledWith("let_close");
    expect(statuses()).toContain("This clinic is not watched, so nothing was recorded.");
  });
});
