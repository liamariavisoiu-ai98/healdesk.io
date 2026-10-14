// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { PatientPageClock } from "@/app/c/[slug]/keep-open";

/**
 * The patient page left open (plan Part D2, F8), in a DOM. The server
 * refuses a lapsed step-up whatever the browser does
 * (tests/patient-page.test.ts); this is what the browser already holds:
 *
 * - nothing of the page shows until the server says the step-up the page was
 *   rendered under is live;
 * - a render shown once is never shown again (Back and Forward replay it from
 *   the router's cache): the page is loaded again from the server;
 * - the deadline is the server's, absolute, whatever the browser's clock;
 * - a minute before it a live region warns, with "Keep open";
 * - at it the record leaves the DOM and the page is replaced by the step-up
 *   page, unless the server says the step-up was kept alive.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  keep: vi.fn(),
  leave: vi.fn(),
  reload: vi.fn(),
}));
vi.mock("@/app/c/[slug]/keep-open", () => ({
  patientPageStatus: mocks.status,
  keepPatientPageOpen: mocks.keep,
}));
vi.mock("@/app/c/[slug]/patient-navigation", () => ({
  leavePatientPage: mocks.leave,
  reloadPatientPage: mocks.reload,
}));

const { ANSWER_MARGIN_MS, PatientPageGuard, WARN_BEFORE_MS } =
  await import("@/app/c/[slug]/PatientPageGuard");

const MINUTE = 60_000;
const IDLE = 15 * MINUTE;
const RECORD = "Synthetic Patient, +1 555 0100, wants Tuesday at 3pm";
const STEP_UP = "5d0c6a52-6f4e-4f53-9d55-0a3c1b7e9f01";
/** The server's clock runs three hours from the browser's: only differences may count. */
const SKEW = 3 * 60 * MINUTE;
const TO_STEP_UP = `/c/glow/step-up?next=${encodeURIComponent("/c/glow/bookings")}`;

let container: HTMLElement;
let root: Root;
let renders = 0;

/** The server's answer: live, with `leftMs` to go on its own clock. */
function live(leftMs: number, capped = false): PatientPageClock {
  const serverNow = Date.now() + SKEW;
  return {
    ok: true,
    stepUpId: STEP_UP,
    expiresAt: new Date(serverNow + leftMs).toISOString(),
    now: new Date(serverNow).toISOString(),
    capped,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
  });
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.status.mockImplementation(async () => live(IDLE));
  window.history.replaceState(null, "", "/c/glow/bookings?q=Synthetic");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

/** A render from the server: a new id each time unless a replay passes the old one. */
async function render(renderId = `render-${++renders}`): Promise<string> {
  await act(async () => {
    root.render(
      h(PatientPageGuard, {
        slug: "glow",
        stepUpId: STEP_UP,
        renderId,
        children: h("p", { id: "record" }, RECORD),
      }),
    );
  });
  return renderId;
}

async function wait(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const showing = () => container.innerHTML.includes("Synthetic Patient");
const liveRegion = () => container.querySelector<HTMLElement>('[aria-live="assertive"]')!;
const button = (name: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === name) ?? null;
/** When the page's own count reaches the deadline the server gave. */
const closesAt = (leftMs: number) => leftMs - ANSWER_MARGIN_MS;

describe("a patient page in the browser", () => {
  test("shows nothing of the record until the server says the step-up is live", async () => {
    const answer = deferred<PatientPageClock>();
    mocks.status.mockReturnValueOnce(answer.promise);
    await render();
    expect(showing()).toBe(false);
    expect(container.textContent).toContain("Opening");
    expect(mocks.status).toHaveBeenCalledWith("glow", STEP_UP);

    await act(async () => answer.resolve(live(IDLE)));
    expect(showing()).toBe(true);
    expect(liveRegion().textContent).toBe("");
  });

  test("a no from the server never shows it, and replaces the page with the step-up page", async () => {
    mocks.status.mockResolvedValueOnce({ ok: false });
    await render();
    expect(showing()).toBe(false);
    // By path only: a search term never rides along in `next`.
    expect(mocks.leave).toHaveBeenCalledWith(TO_STEP_UP);

    // A page rendered under another step-up is a no too.
    act(() => root.unmount());
    root = createRoot(container);
    mocks.leave.mockReset();
    mocks.status.mockResolvedValueOnce({ ...live(IDLE), stepUpId: "another-step-up" });
    await render();
    expect(showing()).toBe(false);
    expect(mocks.leave).toHaveBeenCalledWith(TO_STEP_UP);
  });

  test("Back to a page already shown replays nothing: it is loaded again from the server", async () => {
    // The reviewer's case: shown, closed, then the same payload mounted again.
    const renderId = await render();
    expect(showing()).toBe(true);
    mocks.status.mockResolvedValue({ ok: false });
    await wait(closesAt(IDLE) + 1_000);
    expect(showing()).toBe(false);
    expect(mocks.leave).toHaveBeenCalledWith(TO_STEP_UP);

    act(() => root.unmount());
    root = createRoot(container);
    mocks.status.mockClear();
    await render(renderId);
    await wait(5 * MINUTE);
    expect(showing()).toBe(false);
    expect(mocks.reload).toHaveBeenCalledTimes(1);
    expect(mocks.status).not.toHaveBeenCalled();
  });

  test("Back within the window replays nothing either", async () => {
    mocks.status.mockImplementation(async () => live(IDLE));
    const renderId = await render();
    expect(showing()).toBe(true);
    act(() => root.unmount());
    root = createRoot(container);
    await render(renderId);
    expect(showing()).toBe(false);
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });

  test("a document restored from the browser's back-forward cache is loaded again", async () => {
    await render();
    expect(showing()).toBe(true);
    await act(async () => {
      window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    });
    expect(showing()).toBe(false);
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });

  test("counts down from the server's deadline, whatever the browser's clock says, and warns a minute before", async () => {
    await render();
    await wait(closesAt(IDLE) - WARN_BEFORE_MS - 1_500);
    expect(liveRegion().textContent).toBe("");
    expect(button("Keep open")).toBeNull();

    await wait(2_000);
    expect(liveRegion().getAttribute("aria-atomic")).toBe("true");
    expect(liveRegion().textContent).toContain("This page closes in a minute");
    expect(liveRegion().contains(button("Keep open"))).toBe(true);
    // A 44px target (min-h-11), well over the 24px floor.
    expect(button("Keep open")!.className).toMatch(/\bmin-h-11\b/);
    expect(showing()).toBe(true);
  });

  test("Keep open asks the server about this page's step-up, and counts from its new deadline", async () => {
    await render();
    await wait(closesAt(IDLE) - WARN_BEFORE_MS + 1_000);
    mocks.keep.mockResolvedValueOnce(live(IDLE));
    await act(async () => button("Keep open")!.click());
    expect(mocks.keep).toHaveBeenCalledWith("glow", STEP_UP);
    expect(liveRegion().textContent).toBe("");

    await wait(10 * MINUTE);
    expect(showing()).toBe(true);
    expect(liveRegion().textContent).toBe("");
  });

  test("a fresh render from the server moves the deadline (it touched the step-up)", async () => {
    await render();
    await wait(10 * MINUTE);
    // The page is rendered again (a refresh, a search): the server touched the
    // step-up, and the new render's answer has a whole idle window.
    await render();
    await wait(10 * MINUTE);
    expect(showing()).toBe(true);
    expect(mocks.leave).not.toHaveBeenCalled();
  });

  test("at the deadline the record goes at once, and comes back only if the server kept it alive", async () => {
    await render();
    const answer = deferred<PatientPageClock>();
    mocks.status.mockReturnValueOnce(answer.promise);
    await wait(closesAt(IDLE) + 500);
    expect(showing()).toBe(false);

    // Another tab kept the step-up alive: ten more minutes.
    await act(async () => answer.resolve(live(10 * MINUTE)));
    expect(showing()).toBe(true);

    mocks.status.mockResolvedValueOnce({ ok: false });
    await wait(closesAt(10 * MINUTE) + 1_000);
    expect(showing()).toBe(false);
    expect(container.querySelector("#record")).toBeNull();
    expect(liveRegion().textContent).toContain("This page has closed");
    expect(mocks.leave).toHaveBeenCalledWith(TO_STEP_UP);

    // Closed stays closed.
    await wait(30 * MINUTE);
    expect(showing()).toBe(false);
  });

  test("a Keep open the server refuses (lapsed, signed out, device removed) leaves at once", async () => {
    await render();
    await wait(closesAt(IDLE) - WARN_BEFORE_MS + 1_000);
    mocks.keep.mockResolvedValueOnce({ ok: false });
    await act(async () => button("Keep open")!.click());
    expect(showing()).toBe(false);
    expect(mocks.leave).toHaveBeenCalledWith(TO_STEP_UP);
  });

  test("a Keep open that does not reach the server says so, and the deadline still holds", async () => {
    await render();
    await wait(closesAt(IDLE) - WARN_BEFORE_MS + 1_000);
    mocks.keep.mockRejectedValueOnce(new Error("offline"));
    await act(async () => button("Keep open")!.click());
    expect(liveRegion().textContent).toContain("That didn't reach us");
    expect(button("Keep open")).not.toBeNull();
    mocks.status.mockRejectedValueOnce(new Error("offline"));
    await wait(WARN_BEFORE_MS);
    expect(showing()).toBe(false);
    expect(mocks.leave).toHaveBeenCalled();
  });

  test("near the 8-hour limit there is nothing to keep open, and the warning says why", async () => {
    mocks.status.mockResolvedValueOnce(live(3 * MINUTE, true));
    await render();
    await wait(closesAt(3 * MINUTE) - WARN_BEFORE_MS + 1_000);
    expect(liveRegion().textContent).toContain("8 hours at most");
    expect(button("Keep open")).toBeNull();
  });

  test("a laptop woken past the deadline hides the page as soon as the tab shows", async () => {
    await render();
    // The machine slept: the clock moved on, and no timer ran.
    vi.setSystemTime(Date.now() + 20 * MINUTE);
    mocks.status.mockResolvedValue({ ok: false });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(showing()).toBe(false);
    expect(mocks.leave).toHaveBeenCalledWith(TO_STEP_UP);
  });

  test("a tab shown again asks the server, and leaves if the step-up ended elsewhere", async () => {
    await render();
    expect(showing()).toBe(true);
    mocks.status.mockResolvedValueOnce({ ok: false });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(showing()).toBe(false);
    expect(mocks.leave).toHaveBeenCalledWith(TO_STEP_UP);
  });

  test("a first look that cannot reach the server shows nothing, and can be tried again", async () => {
    mocks.status.mockRejectedValueOnce(new Error("offline"));
    await render();
    expect(showing()).toBe(false);
    expect(container.textContent).toContain("couldn’t check");
    await act(async () => button("Try again")!.click());
    expect(showing()).toBe(true);
  });
});
