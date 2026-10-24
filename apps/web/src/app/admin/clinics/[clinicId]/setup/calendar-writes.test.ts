// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { OpsResult, StuckCalendarWrites, StuckCalendarWriteView } from "@/lib/admin/ops-client";

import { CalendarWrites, writeLine } from "./CalendarWrites";

/**
 * The Setup tab's "Calendar writes" section (Phase 5, lane P5b): this
 * clinic's stuck writes from the cross-clinic read, each in words (state,
 * reason, tries of five, next try or never, the slot in days), "Retry"
 * calling the operation with the appointment's id, "No stuck writes." when
 * none, and the two honesty lines: a read cut off at 100 and clinics not
 * read. Never a time, a name or a service.
 */

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const OTHER = "7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a";
const APPT = "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a";
const APPT_2 = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const NOW = "2026-10-24T09:00:00.000Z";
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

const retrying: StuckCalendarWriteView = {
  clinicId: CLINIC,
  clinicName: "Radiance Med Spa",
  appointmentId: APPT,
  status: "unknown",
  reason: "timeout",
  attempts: 2,
  nextAttemptAt: "2026-10-24T09:30:00.000Z",
  slotInDays: 4,
  retryable: true,
};
const gaveUp: StuckCalendarWriteView = { ...retrying, appointmentId: APPT_2, attempts: 5, nextAttemptAt: null, retryable: false, slotInDays: 0 };
const refused: StuckCalendarWriteView = { ...retrying, appointmentId: APPT_2, status: "failed", reason: "event_id_taken", attempts: 1, nextAttemptAt: null, retryable: false, slotInDays: 1 };
const elsewhere: StuckCalendarWriteView = { ...retrying, clinicId: OTHER, clinicName: "Other Clinic", appointmentId: APPT_2 };

const ok = (writes: StuckCalendarWriteView[], over: Partial<StuckCalendarWrites> = {}): OpsResult<StuckCalendarWrites> => ({
  ok: true,
  data: { writes, count: writes.length, truncated: false, unreadClinics: 0, ...over },
});

describe("the section's words", () => {
  test("each stuck write of this clinic in one line, with its id; another clinic's are not drawn", () => {
    const html = renderToStaticMarkup(h(CalendarWrites, { clinicId: CLINIC, writes: ok([retrying, elsewhere]), now: NOW, onRetry: NEVER }));
    const page = text(html);
    expect(html).toContain('id="calendar-writes"');
    expect(page).toContain("Calendar writes");
    expect(page).toContain("Waiting for its next try: Google did not answer in time. Tries 2 of 5; in about 30 minutes. Slot in 4 days.");
    expect(html).toContain(APPT);
    expect(html).not.toContain(APPT_2);
    expect(page).not.toContain("Other Clinic");
    expect(page).toContain("Retry");
    expect(page).not.toContain("No stuck writes.");
    // Never a time: the fixture's next-try instant is not printed as one.
    expect(page).not.toContain("09:30");
  });

  test("gave up, failed, due now, within 24 hours", () => {
    expect(writeLine(gaveUp, NOW)).toBe("Gave up after 5 tries: Google did not answer in time. Tries 5 of 5; will not be tried again by itself. Slot within 24 hours.");
    expect(writeLine(refused, NOW)).toBe(
      "Failed: our event id is already taken: the event is in the calendar at another time. Tries 1 of 5; will not be tried again by itself. Slot in 1 day.",
    );
    expect(writeLine({ ...retrying, nextAttemptAt: null }, NOW)).toContain("Tries 2 of 5; due now.");
    expect(writeLine({ ...retrying, nextAttemptAt: "2026-10-24T08:00:00.000Z" }, NOW)).toContain("due now");
    expect(writeLine({ ...retrying, nextAttemptAt: "2026-10-24T15:00:00.000Z" }, NOW)).toContain("in about 6 hours");
  });

  test("empty says so in one line; cut off and unread clinics are said, never left quiet; a failed read says so", () => {
    expect(text(renderToStaticMarkup(h(CalendarWrites, { clinicId: CLINIC, writes: ok([elsewhere]), now: NOW, onRetry: NEVER })))).toContain("No stuck writes.");
    const cut = text(renderToStaticMarkup(h(CalendarWrites, { clinicId: CLINIC, writes: ok([elsewhere], { count: 140, truncated: true }), now: NOW, onRetry: NEVER })));
    expect(cut).toContain("Only the 1 newest stuck writes across every clinic were read, of 140: this clinic may have more than shown.");
    const unread = text(renderToStaticMarkup(h(CalendarWrites, { clinicId: CLINIC, writes: ok([], { unreadClinics: 2 }), now: NOW, onRetry: NEVER })));
    expect(unread).toContain("2 clinic(s) could not be read; this one may be among them.");
    const failed = text(
      renderToStaticMarkup(h(CalendarWrites, { clinicId: CLINIC, writes: { ok: false, code: "failed", message: "The stuck writes could not be read." }, now: NOW, onRetry: NEVER })),
    );
    expect(failed).toContain("Could not read the stuck calendar writes: The stuck writes could not be read.");
    expect(failed).not.toContain("No stuck writes.");
  });
});

describe("Retry", () => {
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

  test("calls the operation with the appointment's id and says what it answered; a refusal is said in red", async () => {
    const onRetry = vi.fn(async (id: string) =>
      id === APPT
        ? { ok: true as const, data: { status: "retried" as const, outcome: "written" as const } }
        : { ok: true as const, data: { status: "refused" as const, message: "That appointment is marked cancelled, so nothing is written to the calendar for it." } },
    );
    await act(async () => {
      root.render(h(CalendarWrites, { clinicId: CLINIC, writes: ok([retrying, gaveUp]), now: NOW, onRetry }));
    });
    const buttons = [...container.querySelectorAll("button")].filter((b) => b.textContent === "Retry");
    expect(buttons).toHaveLength(2);
    await act(async () => {
      buttons[0]!.click();
    });
    await act(async () => {});
    expect(onRetry).toHaveBeenCalledWith(APPT);
    await act(async () => {
      buttons[1]!.click();
    });
    await act(async () => {});
    expect(onRetry).toHaveBeenCalledWith(APPT_2);
    const said = [...container.querySelectorAll('[role="status"]')].map((n) => n.textContent ?? "");
    expect(said).toContain("Written to the calendar.");
    expect(said).toContain("That appointment is marked cancelled, so nothing is written to the calendar for it.");
  });
});
