// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { UNAUDITED } from "@/components/admin/ui";
import type { LifecycleRow } from "@/lib/admin/ops-client";

import {
  daysLeft,
  defaultExtendDays,
  IGNORE_CONFIRM,
  IGNORED_DONE,
  LET_CLOSE_CONFIRM,
  PROPOSALS_WORDS,
  PROPOSED_WORDS,
  reminderProposedWords,
  SetupWatchStub,
  SetupWindow,
  WATCHED_DONE,
  type ProposeNotice,
  type PullReminder,
} from "./SetupWindow";

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

const base = { row, deadline: DEADLINE, canExtend: true, now: NOW, onExtend: NEVER, onDecide: NEVER, onSnooze: NEVER, onSetIgnored: NEVER, onProposeNotice: NEVER, onPullReminder: NEVER };

const PROPOSALS = ["Propose more time", "Propose: we are finishing it", "Offer a five-minute call", "Propose the next reminder"] as const;

/** A clinic on the lifecycle watch's ignore list, as apps/app projects it: nothing owed, its own recommendation sentence. */
const notWatched: LifecycleRow = {
  ...row,
  ignored: true,
  decisionOwed: false,
  recommendation: { action: "wait", days: null, reason: "Not watched (internal): no setup reminders or alerts." },
};

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
    for (const label of ["Extend the setup window", "Offered a call", "Let it close", "Snooze alerts", "Do not watch this account"]) expect(page).toContain(label);
    // No "Watch" row: a watched clinic's state is the card itself, and an ignored one's is apps/app's sentence.
    expect(page).not.toContain("Watch watched");
    expect(page).not.toContain("Not watched (internal)");
    expect(page).not.toContain("Watch this account again");
  });

  test("a clinic not watched: apps/app's sentence says so once, no decision or snooze row, Extend kept, the way back offered (lane P5b)", () => {
    const html = renderToStaticMarkup(h(SetupWindow, { ...base, row: notWatched }));
    const page = text(html);
    expect(page).toContain("Not watched (internal): no setup reminders or alerts.");
    expect(page.match(/Not watched \(internal\)/g)).toHaveLength(1);
    expect(page).not.toContain("Routine ops alerts");
    for (const label of ["Offered a call", "Let it close", "Snooze alerts", "Do not watch this account"]) expect(page).not.toContain(label);
    expect(page).toContain("Extend the setup window");
    expect(page).toContain("Watch this account again");
    expect(html).toContain('id="setup-window"');
  });

  test("the ignore sentences claim only what the ignore list does: ops alerts and Home's rows stop; the clinic's reminders and the closing day do not", () => {
    for (const sentence of [IGNORE_CONFIRM, IGNORED_DONE]) {
      expect(sentence).not.toMatch(/no setup reminders/i);
      expect(sentence).toMatch(/reminder emails/);
    }
    expect(IGNORE_CONFIRM).toContain("For healdesk's own test accounts.");
    expect(IGNORE_CONFIRM).toContain("still gets its setup reminder emails every five days");
    expect(IGNORE_CONFIRM).toContain("still closes at the end of its setup window unless the window is extended");
    expect(IGNORE_CONFIRM).toContain("calendar, voice and billing alerts still arrive");
    expect(IGNORED_DONE).toContain("Its reminder emails and its closing day are unchanged.");
    expect(WATCHED_DONE).toContain("Home's decision and go-live rows resume");
  });

  test("the stub card for a clinic the watch has not seen: one line and the ignore control, at the same anchor; an ignored one says so and offers the way back", () => {
    const html = renderToStaticMarkup(h(SetupWatchStub, { ignored: false, onSetIgnored: NEVER }));
    const page = text(html);
    expect(html).toContain('id="setup-window"');
    expect(page).toContain("Setup window");
    expect(page).toContain("Not on the setup watch yet.");
    expect(page).toContain("Do not watch this account");
    expect(page).not.toContain("Window ends");
    expect(page).not.toContain("Watch this account again");
    const ignored = text(renderToStaticMarkup(h(SetupWatchStub, { ignored: true, onSetIgnored: NEVER })));
    expect(ignored).toContain("Not watched (internal): one of healdesk's own test accounts, and not on the setup watch yet.");
    expect(ignored).toContain("Watch this account again");
    expect(ignored).not.toContain("Do not watch this account");
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

  test("the four proposals: each in the stages apps/app accepts it, none for an account not watched, with the one sentence saying they only propose", () => {
    const html = renderToStaticMarkup(h(SetupWindow, base));
    const inSetup = text(html);
    expect(inSetup).toContain(PROPOSALS_WORDS);
    expect(PROPOSALS_WORDS).toBe("Each of these only proposes an email (the reminder's wording is fixed) for your yes under Queues › Approvals; nothing is sent from here.");
    for (const label of ["Propose more time", "Offer a five-minute call", "Propose the next reminder"]) expect(inSetup).toContain(label);
    // The sentence stands beside the buttons it describes: every proposal follows it, none comes before it.
    const sentenceAt = inSetup.indexOf(PROPOSALS_WORDS);
    expect(sentenceAt).toBeGreaterThan(-1);
    for (const label of ["Propose more time", "Offer a five-minute call", "Propose the next reminder"]) expect(inSetup.indexOf(label) > sentenceAt, label).toBe(true);
    expect(inSetup.indexOf("Extend the setup window")).toBeLessThan(sentenceAt);
    expect(inSetup).not.toContain("Send the next reminder now");
    // Not waiting on us: no note that we are finishing it.
    expect(inSetup).not.toContain("Propose: we are finishing it");
    expect(inSetup).toContain("What the email names");
    expect(inSetup).toContain("the phone line");
    expect(inSetup).toContain("Meta chat (Instagram, Messenger and WhatsApp)");
    expect(inSetup).not.toContain("website_chat");

    const waiting = text(renderToStaticMarkup(h(SetupWindow, { ...base, row: { ...row, stage: "waiting_on_us" } })));
    for (const label of PROPOSALS) expect(waiting).toContain(label);

    // Partly live: a channel is live, so no more time and no reminder (apps/app refuses both); the call offer stays.
    const partlyLive = text(renderToStaticMarkup(h(SetupWindow, { ...base, row: { ...row, stage: "partly_live" } })));
    expect(partlyLive).toContain("Offer a five-minute call");
    for (const label of ["Propose more time", "Propose: we are finishing it", "Propose the next reminder"]) expect(partlyLive).not.toContain(label);

    for (const stage of ["live", "closed"] as const) {
      const page = text(renderToStaticMarkup(h(SetupWindow, { ...base, row: { ...row, stage } })));
      for (const label of PROPOSALS) expect(page, stage).not.toContain(label);
      expect(page, stage).not.toContain(PROPOSALS_WORDS);
    }
    // No deadline, or the plan started: more time cannot be proposed; the others stand.
    expect(text(renderToStaticMarkup(h(SetupWindow, { ...base, deadline: null })))).not.toContain("Propose more time");
    expect(text(renderToStaticMarkup(h(SetupWindow, { ...base, canExtend: false })))).not.toContain("Propose more time");
    // An account on the ignore list: apps/app refuses every proposal, so none is drawn.
    const ignored = text(renderToStaticMarkup(h(SetupWindow, { ...base, row: notWatched })));
    for (const label of PROPOSALS) expect(ignored).not.toContain(label);
    expect(ignored).not.toContain(PROPOSALS_WORDS);
  });

  test("the reminder's outcome names which of the six and its own day", () => {
    expect(reminderProposedWords({ status: "proposed", approvalId: CLINIC, reminderNumber: 3, normallyDueOn: "2026-11-10" })).toBe(
      "Proposed: reminder 3 of 6, normally due 10 Nov 2026, waiting for your yes under Queues › Approvals.",
    );
    expect(reminderProposedWords({ status: "proposed", approvalId: CLINIC })).toBe(PROPOSED_WORDS);
    expect(reminderProposedWords({ status: "refused", message: "x" })).toBeNull();
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
      data: {
        status: "extended" as const,
        setupDeadlineAt: `2026-11-${String(1 + input.days).padStart(2, "0")} 00:00 UTC`,
        auditRecorded: true,
        lifecycle: "recorded" as const,
      },
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

  test("a decision or snooze saved without its audit entry says so", async () => {
    const onDecide = vi.fn(async () => ({ ok: true as const, data: { outcome: "saved" as const, auditRecorded: false } }));
    const onSnooze = vi.fn(async () => ({ ok: true as const, data: { outcome: "saved" as const, auditRecorded: false } }));
    await act(async () => {
      root.render(h(SetupWindow, { ...base, onDecide, onSnooze }));
    });
    await act(async () => {
      button("Offered a call").click();
    });
    await act(async () => {});
    expect(statuses()).toContain(`Recorded: a call was offered. ${UNAUDITED}`);
    await act(async () => {
      button("Snooze alerts").click();
    });
    await act(async () => {});
    expect(statuses()).toContain(`Routine ops alerts snoozed for 7 days. ${UNAUDITED}`);
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

  test("Do not watch this account asks once with the one sentence, then sends true; Watch again sends false; an unaudited save says so", async () => {
    const saved = (ignored: boolean, auditRecorded = true) => ({
      ok: true as const,
      data: { outcome: "saved" as const, ignored, note: null, setAt: "2026-10-24T09:00:00.000Z", auditRecorded },
    });
    const onSetIgnored = vi.fn(async (ignored: boolean) => saved(ignored));
    await act(async () => {
      root.render(h(SetupWindow, { ...base, onSetIgnored }));
    });
    await act(async () => {
      button("Do not watch this account").click();
    });
    expect(onSetIgnored).not.toHaveBeenCalled();
    expect(container.textContent).toContain(IGNORE_CONFIRM);
    await act(async () => {
      button("Yes, do not watch this account").click();
    });
    await act(async () => {});
    expect(onSetIgnored).toHaveBeenCalledWith(true);
    expect(statuses()).toContain(IGNORED_DONE);

    const back = vi.fn(async (ignored: boolean) => saved(ignored, false));
    await act(async () => {
      root.render(h(SetupWindow, { ...base, row: notWatched, onSetIgnored: back }));
    });
    await act(async () => {
      button("Watch this account again").click();
    });
    await act(async () => {});
    expect(back).toHaveBeenCalledWith(false);
    expect(statuses()).toContain(`${WATCHED_DONE} ${UNAUDITED}`);

    // The stub card's control sends the same argument.
    const stub = vi.fn(async (ignored: boolean) => saved(ignored));
    await act(async () => {
      root.render(h(SetupWatchStub, { ignored: false, onSetIgnored: stub }));
    });
    await act(async () => {
      button("Do not watch this account").click();
    });
    await act(async () => {
      button("Yes, do not watch this account").click();
    });
    await act(async () => {});
    expect(stub).toHaveBeenCalledWith(true);
    expect(statuses()).toContain(IGNORED_DONE);
  });

  test("the four proposals each call their action with the kind, the days typed or the phrase chosen, and say they wait under Approvals; a refusal says apps/app's sentence", async () => {
    const propose = vi.fn<ProposeNotice>(async () => ({ ok: true, data: { status: "proposed", approvalId: CLINIC } }));
    const pull = vi.fn<PullReminder>(async () => ({ ok: true, data: { status: "proposed", approvalId: CLINIC, reminderNumber: 3, normallyDueOn: "2026-11-10" } }));
    await act(async () => {
      root.render(h(SetupWindow, { ...base, row: { ...row, stage: "waiting_on_us" }, onProposeNotice: propose, onPullReminder: pull }));
    });
    const days = container.querySelector<HTMLInputElement>('input[aria-label="Days to extend by"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(days, "21");
      days.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      button("Propose more time").click();
    });
    await act(async () => {});
    expect(propose).toHaveBeenCalledWith({ kind: "setup_extended", days: 21 });
    expect(statuses()).toContain(PROPOSED_WORDS);

    const phrase = container.querySelector<HTMLSelectElement>('select[aria-label="What the email names"]')!;
    const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    await act(async () => {
      selectSetter?.call(phrase, "calendar");
      phrase.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      button("Propose: we are finishing it").click();
    });
    await act(async () => {});
    expect(propose).toHaveBeenLastCalledWith({ kind: "setup_waiting_on_us", phrase: "calendar" });
    await act(async () => {
      button("Offer a five-minute call").click();
    });
    await act(async () => {});
    expect(propose).toHaveBeenLastCalledWith({ kind: "setup_help_offer", phrase: "calendar" });

    await act(async () => {
      button("Propose the next reminder").click();
    });
    await act(async () => {});
    expect(pull).toHaveBeenCalledTimes(1);
    expect(statuses()).toContain("Proposed: reminder 3 of 6, normally due 10 Nov 2026, waiting for your yes under Queues › Approvals.");

    // A refusal is apps/app's own sentence (notice-ops.ts PLAN_WORDS), shown as it came, and it names this button.
    const night = "It is night at the clinic: a reminder now would wait until morning. Press Propose the next reminder in the clinic's daytime.";
    const refusing = vi.fn<PullReminder>(async () => ({ ok: true, data: { status: "refused", message: night } }));
    await act(async () => {
      root.render(h(SetupWindow, { ...base, onPullReminder: refusing }));
    });
    await act(async () => {
      button("Propose the next reminder").click();
    });
    await act(async () => {});
    expect(statuses()).toContain(night);
    // Nothing was sent by any of them: the actions are the page's proposals, and the card says so once.
    expect(container.textContent).toContain(PROPOSALS_WORDS);
  });

  test("apps/app's two sentences that name this button name it as it reads here, never the old 'Send reminder now'", () => {
    const APP = join(__dirname, "..", "..", "..", "..", "..", "..", "..", "app", "src");
    const noticeOps = readFileSync(join(APP, "lib", "ops", "notice-ops.ts"), "utf8");
    const executors = readFileSync(join(APP, "lib", "approvals", "contact-executors.ts"), "utf8");
    expect(noticeOps).toContain("Press Propose the next reminder in the clinic's daytime.");
    expect(executors).toContain("Press Propose the next reminder again to see which is.");
    for (const source of [noticeOps, executors]) expect(source).not.toMatch(/Press Send reminder now/);
    expect(readFileSync(join(__dirname, "SetupWindow.tsx"), "utf8")).toContain('label="Propose the next reminder"');
  });
});
