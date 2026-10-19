// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { COVERAGE_MODE_OPTIONS, type CoverageModeId } from "@healdesk/catalog";

import { forwardingView, type ForwardingView } from "@/lib/setup/forwarding";

/**
 * The forwarding screen's client panels, in a DOM (wave 2, R5):
 *
 *   - the phone-system picker beside the carrier picker, saving each pick;
 *   - "Test it now": the window opens, the screen waits, and says what the
 *     call showed once it lands.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  savePhoneLine: vi.fn(),
  start: vi.fn(),
  status: vi.fn(),
}));
vi.mock("@/app/c/[slug]/forwarding-actions", () => ({
  savePhoneLineAction: mocks.savePhoneLine,
  startForwardingTestAction: mocks.start,
  forwardingTestStatusAction: mocks.status,
}));

const { ForwardingStepsPanel } = await import("@/app/c/[slug]/ForwardingStepsPanel");
const { ForwardingTestPanel } = await import("@/app/c/[slug]/ForwardingTestPanel");

const AYA = "+15125550142";

function views(
  carrier = "att",
  phoneSystemType = "landline",
): Record<CoverageModeId, ForwardingView> {
  return Object.fromEntries(
    COVERAGE_MODE_OPTIONS.map((o) => [
      o.id,
      forwardingView({ assistantNumberE164: AYA, carrier, phoneSystemType, coverageMode: o.id }),
    ]),
  ) as Record<CoverageModeId, ForwardingView>;
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.savePhoneLine.mockResolvedValue({ ok: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const words = () => (container.textContent ?? "").replace(/\s+/g, " ");

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("the phone-system picker", () => {
  test("a cloud phone system shows the admin rule and hides the carrier; each pick is saved", async () => {
    await act(async () => {
      root.render(h(ForwardingStepsPanel, { slug: "glow", view: views().overflow_after_hours }));
    });
    expect(words()).toContain("Who provides your main line");
    const system = container.querySelector<HTMLSelectElement>("select")!;
    await act(async () => {
      system.value = "voip";
      system.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(mocks.savePhoneLine).toHaveBeenLastCalledWith("glow", {
      phoneSystem: "voip",
      carrier: "att",
    });
    expect(words()).not.toContain("Who provides your main line");
    expect(words()).toContain("In your phone system's admin");
    expect(words()).not.toContain("*905125550142#");
    expect(words()).toContain("Saved");

    await act(async () => {
      system.value = "unknown";
      system.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    const carrier = container.querySelectorAll<HTMLSelectElement>("select")[1]!;
    await act(async () => {
      carrier.value = "tmobile";
      carrier.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(mocks.savePhoneLine).toHaveBeenLastCalledWith("glow", {
      phoneSystem: "unknown",
      carrier: "tmobile",
    });
    expect(words()).toContain("**67*15125550142#");
  });
});

describe("Test it now", () => {
  test("opens the window, waits, and says what the call showed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const until = new Date(Date.now() + 5 * 60_000).toISOString();
    mocks.start.mockResolvedValue({ ok: true, state: { kind: "open", until } });
    mocks.status.mockResolvedValue({ state: { kind: "open", until }, canTest: false });
    await act(async () => {
      root.render(
        h(ForwardingTestPanel, {
          slug: "glow",
          initial: { state: { kind: "waiting" }, canTest: true },
        }),
      );
    });
    expect(words()).toContain("Waiting for call forwarding");
    const button = container.querySelector("button")!;
    expect(button.textContent).toBe("Test it now");
    await act(async () => {
      button.click();
    });
    await flush();
    expect(mocks.start).toHaveBeenCalledWith("glow");
    expect(words()).toContain("Testing your call forwarding");
    expect(words()).toContain(
      "Call your main number now from a phone that isn't on the clinic's account",
    );
    expect(container.querySelector("button")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(4_000);
    });
    await flush();
    expect(mocks.status).toHaveBeenCalledWith("glow");
    expect(words()).toContain("Testing your call forwarding");

    mocks.status.mockResolvedValue({ state: { kind: "passed", via: "test" }, canTest: false });
    await act(async () => {
      vi.advanceTimersByTime(4_000);
    });
    await flush();
    expect(words()).toContain("Call forwarding works");
    expect(words()).toContain("reached AYA with the caller's number intact");
    const calls = mocks.status.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(mocks.status.mock.calls.length).toBe(calls);
  });

  test("a refusal is said, and the button stays", async () => {
    mocks.start.mockResolvedValue({
      ok: false,
      message: "Phone isn't ready for call forwarding yet, so there's nothing to test.",
    });
    await act(async () => {
      root.render(
        h(ForwardingTestPanel, {
          slug: "glow",
          initial: { state: { kind: "no_call" }, canTest: true },
        }),
      );
    });
    expect(words()).toContain("No call reached AYA in those five minutes.");
    await act(async () => {
      container.querySelector("button")!.click();
    });
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Phone isn't ready for call forwarding yet, so there's nothing to test.",
    );
    expect(container.querySelector("button")?.textContent).toBe("Test it now");
  });
});
