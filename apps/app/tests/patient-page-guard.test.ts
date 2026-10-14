// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * "Keep open" and clearing on idle (plan Part D2, F8), in a DOM: a minute
 * before the passkey step-up lapses the page warns in a live region and
 * offers "Keep open", which asks the server; when it lapses, what the page
 * showed leaves the DOM and the one-tap passkey prompt takes its place. The
 * server refuses a lapsed step-up whatever the browser does
 * (tests/patient-page.test.ts); this is the screen left open on a desk.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ keepOpen: vi.fn() }));
vi.mock("@/app/c/[slug]/keep-open", () => ({ keepPatientPageOpen: mocks.keepOpen }));
vi.mock("@/app/c/[slug]/step-up/actions", () => ({
  beginStepUp: vi.fn(),
  finishStepUp: vi.fn(),
}));

const { ARRIVAL_MARGIN_MS, PatientPageGuard, WARN_BEFORE_MS } =
  await import("@/app/c/[slug]/PatientPageGuard");

const MINUTE = 60_000;
const IDLE = 15 * MINUTE;
const RECORD = "Synthetic Patient, +1 555 0100, wants Tuesday at 3pm";

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
  });
  mocks.keepOpen.mockReset();
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

async function open(expiresInMs: number): Promise<void> {
  await act(async () => {
    root.render(
      h(PatientPageGuard, {
        slug: "glow",
        expiresInMs,
        children: h("p", { id: "record" }, RECORD),
      }),
    );
  });
}

async function wait(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

function live(): HTMLElement {
  return container.querySelector('[aria-live="assertive"]')!;
}

function keepOpenButton(): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll("button")].find((b) => b.textContent === "Keep open") ?? null
  );
}

/** When the page's own clock closes it: the server's figure, less the arrival margin. */
const closesAt = (expiresInMs: number) => expiresInMs - ARRIVAL_MARGIN_MS;

describe("a patient page left open", () => {
  test("shows its record while the step-up is live, and warns a minute before it lapses", async () => {
    await open(IDLE);
    expect(container.textContent).toContain(RECORD);
    expect(live().textContent).toBe("");

    await wait(closesAt(IDLE) - WARN_BEFORE_MS - 1_500);
    expect(live().textContent).toBe("");
    expect(keepOpenButton()).toBeNull();

    await wait(2_000);
    expect(live().getAttribute("aria-atomic")).toBe("true");
    expect(live().textContent).toContain("This page closes in a minute");
    expect(live().contains(keepOpenButton())).toBe(true);
    // A 44px target (min-h-11), well over the 24px floor.
    expect(keepOpenButton()!.className).toMatch(/\bmin-h-11\b/);
    expect(container.textContent).toContain(RECORD);
  });

  test("Keep open asks the server, and counts again from what it says", async () => {
    await open(IDLE);
    await wait(closesAt(IDLE) - WARN_BEFORE_MS + 1_000);
    mocks.keepOpen.mockResolvedValueOnce({ ok: true, expiresInMs: IDLE });

    await act(async () => keepOpenButton()!.click());
    expect(mocks.keepOpen).toHaveBeenCalledWith("glow");
    expect(live().textContent).toBe("");

    // Well past the first deadline, and not yet at the new one.
    await wait(10 * MINUTE);
    expect(container.textContent).toContain(RECORD);
    expect(live().textContent).toBe("");
  });

  test("when it lapses, the record leaves the DOM and the passkey prompt takes its place", async () => {
    await open(IDLE);
    await wait(closesAt(IDLE) + 1_000);

    expect(container.querySelector("#record")).toBeNull();
    expect(container.innerHTML).not.toContain("Synthetic Patient");
    expect(container.innerHTML).not.toContain("555 0100");
    expect(live().textContent).toContain("This page has closed");
    expect(container.textContent).toContain("Confirm it’s you");
    expect(container.textContent).toContain("Use your phone instead");
    // Back to this page after the passkey, by its path only: no search term in `next`.
    const add = [...container.querySelectorAll("a")].find((a) =>
      a.getAttribute("href")?.startsWith("/c/glow/protect"),
    );
    expect(add?.getAttribute("href")).toBe(
      `/c/glow/protect?next=${encodeURIComponent("/c/glow/bookings")}`,
    );

    // Closed stays closed: only a passkey and a fresh page open it again.
    await wait(30 * MINUTE);
    expect(container.innerHTML).not.toContain("Synthetic Patient");
  });

  test("a Keep open the server refuses (lapsed, signed out, device removed) closes the page", async () => {
    await open(IDLE);
    await wait(closesAt(IDLE) - WARN_BEFORE_MS + 1_000);
    mocks.keepOpen.mockResolvedValueOnce({ ok: false });
    await act(async () => keepOpenButton()!.click());
    expect(container.innerHTML).not.toContain("Synthetic Patient");
    expect(live().textContent).toContain("This page has closed");
  });

  test("a Keep open that does not reach the server says so and keeps the warning", async () => {
    await open(IDLE);
    await wait(closesAt(IDLE) - WARN_BEFORE_MS + 1_000);
    mocks.keepOpen.mockRejectedValueOnce(new Error("offline"));
    await act(async () => keepOpenButton()!.click());
    expect(live().textContent).toContain("That didn't reach us");
    expect(keepOpenButton()).not.toBeNull();
    await wait(WARN_BEFORE_MS);
    expect(container.innerHTML).not.toContain("Synthetic Patient");
  });

  test("near the 8-hour limit there is nothing to keep open: the warning says why", async () => {
    // Three minutes left, less than a whole idle window: the 8-hour limit applies.
    await open(3 * MINUTE);
    await wait(closesAt(3 * MINUTE) - WARN_BEFORE_MS + 1_000);
    expect(live().textContent).toContain("8 hours at most");
    expect(keepOpenButton()).toBeNull();
    await wait(WARN_BEFORE_MS);
    expect(container.innerHTML).not.toContain("Synthetic Patient");
  });

  test("a laptop woken after the deadline closes the page as soon as the tab shows", async () => {
    await open(IDLE);
    // The machine slept: the clock moved on, and no timer ran.
    vi.setSystemTime(Date.now() + 20 * MINUTE);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(container.innerHTML).not.toContain("Synthetic Patient");
  });
});
