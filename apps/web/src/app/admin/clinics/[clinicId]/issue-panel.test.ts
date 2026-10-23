// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The clinic panel's issue panel (E7 step 3) reads `#<event>-<alert id>`
 * after mount and draws "Fix with Claude" for it; any other fragment, or
 * none, draws nothing. A DOM is needed because the fragment is read in an
 * effect, which static markup never runs.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/admin/clinics/3fa85f64-5717-4562-b3fc-2c963f66afa6/setup" }));

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
  return container.innerHTML;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
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

  test("a fragment that is not an alert, or none, draws nothing", async () => {
    expect(await mount("#jobs")).toBe("");
    expect(await mount(`#made_up_event-${ALERT}`)).toBe("");
    expect(await mount(`#transcript_undelivered-not-a-uuid`)).toBe("");
    expect(await mount("")).toBe("");
  });
});
