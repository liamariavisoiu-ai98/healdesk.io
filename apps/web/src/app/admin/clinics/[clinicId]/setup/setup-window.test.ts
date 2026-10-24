// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { LifecycleRow } from "@/lib/admin/ops-client";

import { LET_CLOSE_CONFIRM, SetupWindow } from "./SetupWindow";

/**
 * The Setup tab's "Setup window" card (wave 2, lane A3): the watch's row in
 * words, its recommendation shown as it came, and the four controls the
 * alerts quote: "Extend the setup window" (the recommended days as the
 * default, 1 to 30), "Offered a call", "Let it close" (asks once with the
 * quoted sentence) and "Snooze alerts" (3, 7 or 14 days), each calling the
 * right operation with the right argument.
 */

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
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
  deadlineAt: "2026-11-01T00:00:00.000Z",
  remainingDays: 8,
  decision: "none",
  decidedBy: null,
  decidedAt: null,
  snoozedUntil: null,
  snoozedBy: null,
  undeliveredCount: 1,
  decisionOwed: true,
  recommendation: { action: "extend", days: 14, reason: "The clinic made progress in the last week and two steps are left." },
};

describe("the card's words", () => {
  test("stage, days and steps left, last progress, decision, snooze and the watch's own recommendation", () => {
    const html = renderToStaticMarkup(h(SetupWindow, { row, onExtend: NEVER, onDecide: NEVER, onSnooze: NEVER }));
    const page = text(html);
    expect(html).toContain('id="setup-window"');
    expect(page).toContain("Setup window");
    expect(page).toContain("in setup since 2026-10-02 8 days left window ends 2026-11-01");
    expect(page).toContain("Steps left 2 · 1 channel waiting on the clinic");
    expect(page).toContain("Last progress 2026-10-15");
    expect(page).toContain("Decision so far none yet");
    expect(page).toContain("Ops alerts on");
    expect(page).toContain("Reminders 1 undelivered: see Deliveries › Reminders");
    expect(html).toContain(`href="/admin/clinics/${CLINIC}/deliveries#reminders"`);
    expect(page).toContain("Recommended: extend 14 days. The clinic made progress in the last week and two steps are left.");
    // The recommended days are the extension's default.
    expect(html).toMatch(/aria-label="Days to extend by"[^>]*value="14"/);
    for (const label of ["Extend the setup window", "Offered a call", "Let it close", "Snooze alerts"]) expect(page).toContain(label);
  });

  test("a decided, snoozed clinic says so, and one with no deadline cannot be extended", () => {
    const decided: LifecycleRow = { ...row, decision: "extension_offered", decidedAt: "2026-10-20T10:00:00.000Z", decidedBy: "ops@healdesk.test", snoozedUntil: "2026-10-30T00:00:00.000Z", snoozedBy: "ops@healdesk.test", undeliveredCount: 0, deadlineAt: null, remainingDays: null, recommendation: { action: "wait", days: null, reason: "A call was offered three days ago." } };
    const html = renderToStaticMarkup(h(SetupWindow, { row: decided, onExtend: NEVER, onDecide: NEVER, onSnooze: NEVER }));
    const page = text(html);
    expect(page).toContain("Decision so far a call was offered (2026-10-20, ops@healdesk.test)");
    expect(page).toContain("Ops alerts snoozed until 2026-10-30 by ops@healdesk.test");
    expect(page).toContain("Recommended: wait. A call was offered three days ago.");
    expect(page).not.toContain("days left");
    expect(page).not.toContain("Reminders");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Extend the setup window<\/button>/);
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

  test("Extend sends the days typed, defaulting to the recommendation; Offered a call and Snooze send their arguments", async () => {
    const onExtend = vi.fn(async (days: number) => ({ ok: true as const, data: { status: "extended" as const, setupDeadlineAt: `2026-11-${String(1 + days).padStart(2, "0")} 00:00 UTC`, auditRecorded: true } }));
    const onDecide = vi.fn(async () => ({ ok: true as const, data: { outcome: "saved" as const } }));
    const onSnooze = vi.fn(async () => ({ ok: true as const, data: { outcome: "saved" as const } }));
    await act(async () => {
      root.render(h(SetupWindow, { row, onExtend, onDecide, onSnooze }));
    });
    await act(async () => {
      button("Extend the setup window").click();
    });
    await act(async () => {});
    expect(onExtend).toHaveBeenCalledWith(14);
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
    expect(statuses()).toContain("Snoozed for 7 days.");
  });

  test("Let it close asks once with the quoted sentence, then records let_close; a clinic not watched is said", async () => {
    const onDecide = vi.fn(async () => ({ ok: true as const, data: { outcome: "not_watched" as const } }));
    await act(async () => {
      root.render(h(SetupWindow, { row, onExtend: NEVER, onDecide, onSnooze: NEVER }));
    });
    await act(async () => {
      button("Let it close").click();
    });
    expect(onDecide).not.toHaveBeenCalled();
    expect(container.textContent).toContain(LET_CLOSE_CONFIRM);
    expect(LET_CLOSE_CONFIRM).toBe("The clinic's setup window will close on its last day; ops alerts about it stop.");
    await act(async () => {
      button("Yes, let it close").click();
    });
    await act(async () => {});
    expect(onDecide).toHaveBeenCalledWith("let_close");
    expect(statuses()).toContain("This clinic is not watched, so nothing was recorded.");
  });
});
