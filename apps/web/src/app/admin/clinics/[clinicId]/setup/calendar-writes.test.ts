// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { OpsResult, StuckCalendarWrites, StuckCalendarWriteView } from "@/lib/admin/ops-client";

import { SWEEP_OFF_WORDS } from "@/components/admin/queue-words";
import { CalendarWrites, emptyWords, retryWords, writeLine } from "./CalendarWrites";

/**
 * The Setup tab's "Calendar writes" section (Phase 5, lane P5b): this
 * clinic's stuck writes from the cross-clinic read, each in words (state,
 * reason, tries, next try while the sweep owns it, the slot in days),
 * "Retry" calling the operation with the appointment's id and saying what it
 * answered in the right tone, "No stuck writes." only when the whole list
 * was read, and the honesty lines for a read cut off at 100 or clinics not
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
const settled: StuckCalendarWriteView = { ...retrying, appointmentId: APPT_2, reason: "deleted_in_calendar", attempts: 2, nextAttemptAt: null, retryable: false };
const refused: StuckCalendarWriteView = { ...retrying, appointmentId: APPT_2, status: "failed", reason: "event_id_taken", attempts: 1, nextAttemptAt: null, retryable: false, slotInDays: 1 };
const pastFive: StuckCalendarWriteView = { ...refused, attempts: 7 };
const elsewhere: StuckCalendarWriteView = { ...retrying, clinicId: OTHER, clinicName: "Other Clinic", appointmentId: APPT_2 };

const ok = (writes: StuckCalendarWriteView[], over: Partial<StuckCalendarWrites> = {}): OpsResult<StuckCalendarWrites> => ({
  ok: true,
  data: { writes, count: writes.length, truncated: false, unreadClinics: 0, sweepOn: true, ...over },
});

describe("the section's words", () => {
  test("with the sweep switched off: said once above the list, and no row waits for a next try or is due now", () => {
    // apps/app sends retryable false then; a row that still said true is not believed either.
    const html = renderToStaticMarkup(
      h(CalendarWrites, { clinicId: CLINIC, writes: ok([retrying, gaveUp], { sweepOn: false }), now: NOW, onRetry: NEVER }),
    );
    const page = text(html);
    expect(page.split(SWEEP_OFF_WORDS)).toHaveLength(2);
    expect(page).toContain("will not be retried by themselves while the calendar-watch switch on the Jobs page is off");
    expect(page).not.toContain("Waiting for its next try");
    expect(page).not.toContain("due now");
    expect(page).not.toContain("in about");
    expect(writeLine({ ...retrying, retryable: false, nextAttemptAt: null }, NOW, false)).toBe(
      "Will not be retried by itself: Google did not answer in time. Tries 2 of 5. Slot in 4 days.",
    );
    // On, the notice is absent.
    const on = text(renderToStaticMarkup(h(CalendarWrites, { clinicId: CLINIC, writes: ok([retrying]), now: NOW, onRetry: NEVER })));
    expect(on).not.toContain(SWEEP_OFF_WORDS);
  });

  test("each stuck write of this clinic in one line, with its id; another clinic's are not drawn", () => {
    const html = renderToStaticMarkup(h(CalendarWrites, { clinicId: CLINIC, writes: ok([retrying, elsewhere]), now: NOW, onRetry: NEVER }));
    const page = text(html);
    expect(html).toContain('id="calendar-writes"');
    expect(page).toContain("Calendar writes");
    expect(page).toContain("Waiting for its next try, in about 30 minutes: Google did not answer in time. Tries 2 of 5. Slot in 4 days.");
    expect(html).toContain(APPT);
    expect(html).not.toContain(APPT_2);
    expect(page).not.toContain("Other Clinic");
    expect(page).toContain("Retry");
    expect(page).not.toContain("No stuck writes.");
    // Never a time: the fixture's next-try instant is not printed as one.
    expect(page).not.toContain("09:30");
  });

  test("gave up (five spent), will not be retried by itself (settled with tries to spare), failed, past five, due now, within 24 hours", () => {
    expect(writeLine(gaveUp, NOW)).toBe("Gave up after 5 tries: Google did not answer in time. Tries 5 of 5. Slot within 24 hours.");
    expect(writeLine(settled, NOW)).toBe("Will not be retried by itself: the clinic deleted the event in its own calendar. Tries 2 of 5. Slot in 4 days.");
    expect(writeLine(refused, NOW)).toBe(
      "Failed, not retried by itself: our event id is already taken: the event is in the calendar at another time. Tries 1 of 5. Slot in 1 day.",
    );
    // An operator's retries go past the sweep's five: no "of 5" then.
    expect(writeLine(pastFive, NOW)).toContain("Tries 7. Slot");
    expect(writeLine(pastFive, NOW)).not.toContain("of 5");
    expect(writeLine({ ...retrying, nextAttemptAt: null }, NOW)).toContain("Waiting for its next try, due now:");
    expect(writeLine({ ...retrying, nextAttemptAt: "2026-10-24T08:00:00.000Z" }, NOW)).toContain("due now");
    expect(writeLine({ ...retrying, nextAttemptAt: "2026-10-24T15:00:00.000Z" }, NOW)).toContain("in about 6 hours");
    expect(writeLine({ ...retrying, reason: "other" }, NOW)).toContain("no reason of ours was recorded: the attempt was cut off before one was written, or Google answered with a word of its own");
  });

  test("empty says 'No stuck writes.' only when the whole list was read; cut off or unread clinics are said instead, in red", () => {
    const whole = renderToStaticMarkup(h(CalendarWrites, { clinicId: CLINIC, writes: ok([elsewhere]), now: NOW, onRetry: NEVER }));
    expect(text(whole)).toContain("No stuck writes.");
    expect(whole).not.toContain("text-red-deep");

    const cut = renderToStaticMarkup(h(CalendarWrites, { clinicId: CLINIC, writes: ok([elsewhere], { count: 140, truncated: true }), now: NOW, onRetry: NEVER }));
    expect(text(cut)).toContain("None of the first 1 are this clinic's; the list was cut off at that, of 140 found, so this clinic may still have some.");
    expect(text(cut)).not.toContain("No stuck writes.");
    expect(cut).toMatch(/<p role="status" class="text-red-deep[^"]*">None of the first/);
    expect(emptyWords({ writes: new Array(100).fill(elsewhere), count: 140, truncated: true, unreadClinics: 0, sweepOn: true })).toBe(
      "None of the first 100 are this clinic's; the list was cut off at that, of 140 found, so this clinic may still have some.",
    );

    const unread = text(renderToStaticMarkup(h(CalendarWrites, { clinicId: CLINIC, writes: ok([], { unreadClinics: 2 }), now: NOW, onRetry: NEVER })));
    expect(unread).toContain("None read are this clinic's, but 2 clinic(s) could not be read; this one may be among them.");
    expect(unread).not.toContain("No stuck writes.");

    const failed = text(
      renderToStaticMarkup(h(CalendarWrites, { clinicId: CLINIC, writes: { ok: false, code: "failed", message: "The stuck writes could not be read." }, now: NOW, onRetry: NEVER })),
    );
    expect(failed).toContain("Could not read the stuck calendar writes: The stuck writes could not be read.");
    expect(failed).not.toContain("No stuck writes.");
  });

  test("with rows, a cut-off or unread read is still said beneath them", () => {
    const page = text(renderToStaticMarkup(h(CalendarWrites, { clinicId: CLINIC, writes: ok([retrying], { count: 140, truncated: true, unreadClinics: 1 }), now: NOW, onRetry: NEVER })));
    expect(page).toContain("Only the first 1 stuck writes across every clinic were read, of 140: this clinic may have more than shown.");
    expect(page).toContain("1 clinic(s) could not be read; this one may be among them.");
  });
});

describe("the retry's words", () => {
  const retried = (outcome: "written" | "failed" | "unknown" | "not-connected") => ({ ok: true as const, data: { status: "retried" as const, outcome } });

  test("written is done; failed and not-connected are refusals, never green; unknown says whether the sweep reads it back", () => {
    expect(retryWords(retried("written"), 2)).toEqual({ ok: true, data: { status: "written", message: "Written to the calendar." } });
    expect(retryWords(retried("failed"), 2)).toMatchObject({ data: { status: "refused", message: "Failed again. Reload to read the new reason on the row." } });
    expect(retryWords(retried("not-connected"), 2)).toMatchObject({ data: { status: "refused" } });
    expect(retryWords(retried("unknown"), 2)).toEqual({ ok: true, data: { status: "unknown", message: "No answer settled it: the sweep reads it back on its next turn." } });
    // The fourth try that ends unknown is the fifth attempt: the sweep stops there.
    expect(retryWords(retried("unknown"), 4)).toMatchObject({
      data: { status: "refused", message: "No answer settled it, and after 5 tries the sweep will not try again by itself. Check the clinic's calendar, or press Retry once the cause is fixed." },
    });
    expect(retryWords(retried("unknown"), 7)).toMatchObject({ data: { status: "refused", message: expect.stringContaining("after 8 tries") } });
    expect(retryWords({ ok: true, data: { status: "refused", message: "That appointment is marked cancelled." } }, 1)).toMatchObject({ data: { status: "refused", message: "That appointment is marked cancelled." } });
    expect(retryWords({ ok: false, code: "failed", message: "x" }, 1)).toEqual({ ok: false, code: "failed", message: "x" });
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

  test("calls the operation with the appointment's id and says what it answered; a failed retry and a refusal are drawn as failures", async () => {
    const onRetry = vi.fn(async (id: string) =>
      id === APPT
        ? { ok: true as const, data: { status: "retried" as const, outcome: "failed" as const } }
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
    const said = [...container.querySelectorAll<HTMLElement>('[role="status"]')];
    const failedLine = said.find((n) => n.textContent === "Failed again. Reload to read the new reason on the row.");
    expect(failedLine?.className).toContain("text-red-deep");
    expect(said.map((n) => n.textContent)).toContain("That appointment is marked cancelled, so nothing is written to the calendar for it.");
  });
});
