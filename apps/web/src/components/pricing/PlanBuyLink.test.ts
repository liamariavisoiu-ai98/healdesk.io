// @vitest-environment happy-dom
import { getPlan } from "@healdesk/catalog";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { BuyModalProvider } from "@/components/BuyModal";

import { PlanBuyLink } from "./PricingSheet";

/**
 * The pricing calculator's "Get AYA" opens the purchase in place, with the
 * package already chosen (plan A1). Until 19 October 2026 it was a plain
 * link to /get-started: the page was left, and the purchase opened on a page
 * of its own. It stays that link for a page without the provider and for a
 * click that asks for a new tab.
 *
 * Run in a DOM, because the click, the dialog and the flow's mount are what
 * is being tested.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIRST = "voice-metachat-500-300";
const SECOND = "webchat-300";

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  // The flow asks which mode it is in and for the website's offer; nothing leaves the test.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/checkout/mode")) {
        return new Response(JSON.stringify({ mode: "public" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 204 });
    }),
  );
  sessionStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const CLASS = "card-button";

function links(): HTMLAnchorElement[] {
  return [...container.querySelectorAll<HTMLAnchorElement>(`a.${CLASS}`)];
}

/** A click as a browser sends it; whether the default (navigating) was stopped. */
async function click(link: HTMLAnchorElement, init: MouseEventInit = {}): Promise<boolean> {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  await act(async () => {
    link.dispatchEvent(event);
  });
  // The mode answer, then the flow's mount.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return event.defaultPrevented;
}

/** What the package step says is chosen: PlanSummary's live region. */
function chosen(): string {
  const dialog = container.querySelector("dialog")!;
  const regions = [...dialog.querySelectorAll('[role="status"]')];
  return regions.map((r) => r.textContent ?? "").join(" ");
}

function cards() {
  return [
    h(PlanBuyLink, { key: FIRST, planId: FIRST, interval: "month", className: CLASS }),
    h(PlanBuyLink, { key: SECOND, planId: SECOND, interval: "year", className: CLASS }),
  ];
}

describe("the pricing card's Get AYA", () => {
  test("opens the purchase over the page with its package chosen, and a second card's package replaces it", async () => {
    await act(async () => root.render(h(BuyModalProvider, null, ...cards())));
    const [first, second] = links();
    expect(first!.getAttribute("href")).toBe(`/get-started?plan=${FIRST}&interval=month`);

    expect(await click(first!)).toBe(true);
    const dialog = container.querySelector("dialog")!;
    expect(dialog.open).toBe(true);
    expect(chosen()).toContain(getPlan(FIRST)!.name);

    // Closed, a different package on the calculator, the button again: the new package.
    await act(async () => dialog.close());
    expect(await click(second!)).toBe(true);
    expect(dialog.open).toBe(true);
    expect(chosen()).toContain(getPlan(SECOND)!.name);
    expect(chosen()).not.toContain(getPlan(FIRST)!.name);
    expect(chosen()).toContain("billed annually");
  });

  test("a click for a new tab, or a page without the provider, keeps the link to /get-started", async () => {
    await act(async () => root.render(h(BuyModalProvider, null, ...cards())));
    expect(await click(links()[0]!, { metaKey: true })).toBe(false);
    expect(container.querySelector("dialog")!.open).toBe(false);

    await act(async () => root.render(h("div", null, ...cards())));
    expect(await click(links()[0]!)).toBe(false);
  });
});
