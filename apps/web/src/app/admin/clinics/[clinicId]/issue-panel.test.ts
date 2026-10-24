// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The clinic panel's issue panel (E7 step 3; wave 2, lane A3): it reads
 * `#<event>-<alert id>` after mount and draws "Fix with Claude" for it; an
 * event with a card of its own is scrolled to that card, after the prompt
 * has committed (the panel sits above the cards and pushes them down); a
 * change of the hash, or a client navigation inside the layout, re-reads
 * it so both the prompt and the scroll follow; any other fragment, or
 * none, draws nothing. A DOM is needed because the fragment is read in an
 * effect, which static markup never runs.
 */

const router = vi.hoisted(() => ({ pathname: "/admin/clinics/3fa85f64-5717-4562-b3fc-2c963f66afa6/setup" }));
vi.mock("next/navigation", () => ({ usePathname: () => router.pathname }));

const { IssuePanel } = await import("./IssuePanel");

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const ALERT = "5b4a3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function mount(hash: string): Promise<string> {
  window.location.hash = hash;
  await act(async () => {
    root.render(h(IssuePanel, { clinicId: CLINIC }));
  });
  // happy-dom fires `hashchange` on a later task than the assignment; under load
  // (a busy machine, a shared CI runner) it can land after the assertions that
  // follow. Let those events, and the effects they set off, settle first.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  return container.innerHTML;
}

/** The cards an alert's link may land on, as the tabs draw them; each records whether the panel was on the page when it was scrolled to. */
function cards(): Record<string, { scrolled: number; panelFirst: boolean | null }> {
  const seen: Record<string, { scrolled: number; panelFirst: boolean | null }> = {};
  for (const id of ["availability", "setup-window"]) {
    const card = document.createElement("section");
    card.id = id;
    seen[id] = { scrolled: 0, panelFirst: null };
    card.scrollIntoView = () => {
      seen[id]!.scrolled += 1;
      seen[id]!.panelFirst = container.textContent?.includes("Fix with Claude") ?? false;
    };
    document.body.appendChild(card);
  }
  return seen;
}

beforeEach(() => {
  router.pathname = `/admin/clinics/${CLINIC}/setup`;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  for (const id of ["availability", "setup-window"]) document.getElementById(id)?.remove();
  window.location.hash = "";
});

describe("the issue panel", () => {
  test("an alert in the address draws Fix with Claude for it", async () => {
    const html = await mount(`#transcript_undelivered-${ALERT}`);
    expect(html).toContain("Fix with Claude");
    expect(html).toContain(`Ops issue: transcript_undelivered (from the closed OPS_EVENTS list). Alert id ${ALERT}. Clinic id ${CLINIC}.`);
    expect(html).toContain("docs/on-call.md#transcripts");
    expect(html).toContain('href="claude-cli://open?repo=');
  });

  test("an event with a card of its own is scrolled to that card after the panel is on the page; one without is not", async () => {
    // happy-dom fires hashchange more than once per change of hash, so the
    // counts are "at least once for the right card, never for the wrong one".
    const seen = cards();
    await mount(`#lifecycle_decision_due-${ALERT}`);
    expect(seen["setup-window"]?.scrolled).toBeGreaterThanOrEqual(1);
    expect(seen["setup-window"]?.panelFirst).toBe(true);
    expect(seen["availability"]?.scrolled).toBe(0);
    await mount(`#clinic_availability_changed-${ALERT}`);
    expect(seen["availability"]?.scrolled).toBeGreaterThanOrEqual(1);
    expect(seen["availability"]?.panelFirst).toBe(true);
    const before = { availability: seen["availability"]!.scrolled, window: seen["setup-window"]!.scrolled };
    await mount(`#transcript_undelivered-${ALERT}`);
    expect(seen["availability"]?.scrolled).toBe(before.availability);
    expect(seen["setup-window"]?.scrolled).toBe(before.window);
  });

  test("a change of the hash, and a client navigation inside the layout, re-read the issue", async () => {
    const seen = cards();
    await mount(`#transcript_undelivered-${ALERT}`);
    expect(container.innerHTML).toContain("transcript_undelivered");
    // The hash changes without a remount: the prompt and the scroll follow.
    await act(async () => {
      window.location.hash = `#lifecycle_closing_soon-${ALERT}`;
      window.dispatchEvent(new Event("hashchange"));
    });
    expect(container.innerHTML).toContain("Ops issue: lifecycle_closing_soon");
    expect(container.innerHTML).not.toContain("Ops issue: transcript_undelivered");
    expect(seen["setup-window"]?.scrolled).toBeGreaterThanOrEqual(1);
    // A navigation to another tab of the same clinic (the layout stays mounted) with a new fragment.
    window.location.hash = `#clinic_availability_changed-${ALERT}`;
    router.pathname = `/admin/clinics/${CLINIC}/deliveries`;
    await act(async () => {
      root.render(h(IssuePanel, { clinicId: CLINIC }));
    });
    expect(container.innerHTML).toContain("Ops issue: clinic_availability_changed");
    expect(seen["availability"]?.scrolled).toBeGreaterThanOrEqual(1);
  });

  test("a fragment that is not an alert, or none, draws nothing", async () => {
    expect(await mount("#jobs")).toBe("");
    expect(await mount(`#made_up_event-${ALERT}`)).toBe("");
    expect(await mount(`#transcript_undelivered-not-a-uuid`)).toBe("");
    expect(await mount("")).toBe("");
  });
});
