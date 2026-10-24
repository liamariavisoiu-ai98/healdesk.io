// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { OpsResult, VoiceAgentStatusView } from "@/lib/admin/ops-client";

import { checkWords, CLEAR_FLAG_CONFIRM, clearWords, retryAllowed, retryWords, VoiceAgentCard } from "./VoiceAgentCard";

/**
 * The Setup tab's "Voice agent" card (Phase 5, lane P5b): the set-up in
 * words, never the number; each control drawn only where the state allows
 * it, with the line saying why where it is not; each button calling the
 * right action and saying the outcome in one line; the drift clear asking
 * for a fresh code and refusing to run without one.
 */

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const NEVER = async (): Promise<never> => {
  throw new Error("an action ran during a static render");
};
const actions = { retry: NEVER, check: NEVER, clearFlag: NEVER };

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&rsquo;|’/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const ready: VoiceAgentStatusView = {
  clinicId: CLINIC,
  clinicSlug: "radiance",
  engine: "custom",
  status: "ready",
  retellAgentId: "agent_abc123",
  hasNumber: true,
  attempts: 1,
  lastError: null,
  lastSyncedAt: "2026-10-24T09:00:00.000Z",
  numberOrderedAt: "2026-10-23T09:00:00.000Z",
  driftRepairs: 0,
  driftFlaggedAt: null,
  releasedAt: null,
  updatedAt: "2026-10-24T09:00:00.000Z",
};
// A fixture that carries a phone number and an address in the one free-text field: neither may reach the page.
const failed: VoiceAgentStatusView = {
  ...ready,
  status: "failed",
  hasNumber: false,
  attempts: 3,
  lastError: "Retell bound +1 (415) 555-0142 for ops@clinic.example and answered 502",
  driftRepairs: 2,
};
const flagged: VoiceAgentStatusView = { ...ready, driftFlaggedAt: "2026-10-24T03:00:00.000Z", driftRepairs: 1 };

const read = (agents: VoiceAgentStatusView[]): OpsResult<VoiceAgentStatusView[]> => ({ ok: true, data: agents });

describe("the card's words", () => {
  test("a ready agent: status, a number held (never the number), the engine, no problem, attempts, not flagged; no Retry and why; Check against Retell; no Clear", () => {
    const html = renderToStaticMarkup(h(VoiceAgentCard, { read: read([ready]), actions }));
    const page = text(html);
    expect(html).toContain('id="voice"');
    expect(page).toContain("Voice agent");
    expect(page).toContain("Status Ready");
    expect(page).toContain("Phone number one is held");
    expect(page).toContain("Engine healdesk's own (the custom LLM endpoint)");
    expect(page).toContain("Last problem none recorded");
    expect(page).toContain("Attempts 1");
    expect(page).toContain("Drift Not flagged.");
    expect(page).not.toContain("Retry");
    expect(page).toContain("Nothing to retry: the agent is ready.");
    expect(page).toContain("Check against Retell");
    expect(page).not.toContain("Clear flag and recheck");
    expect(page).not.toContain("agent_abc123");
    expect(page).not.toContain("radiance");
  });

  test("a failed agent offers Retry, prints the last problem with the number and the address scrubbed, and counts the repairs", () => {
    const page = text(renderToStaticMarkup(h(VoiceAgentCard, { read: read([failed]), actions })));
    expect(page).toContain("Status Set-up failed");
    expect(page).toContain("Phone number none held yet");
    expect(page).toContain("Last problem Retell bound [number] for [address] and answered 502");
    expect(page).not.toContain("415");
    expect(page).not.toContain("0142");
    expect(page).not.toContain("clinic.example");
    expect(page).toContain("Attempts 3");
    expect(page).toContain("Drift Not flagged; repaired 2 times by the nightly check.");
    expect(page).toContain("Retry");
    expect(page).not.toContain("Nothing to retry");
  });

  test("a flagged agent says since when and offers Clear flag and recheck behind a code field", () => {
    const html = renderToStaticMarkup(h(VoiceAgentCard, { read: read([flagged]), actions }));
    const page = text(html);
    expect(page).toContain("Drift Flagged on 2026-10-24: Retell no longer matched our settings and the nightly check skips it until the flag is cleared (repaired 1 time before).");
    expect(page).toContain("Code from your authenticator");
    expect(page).toContain("Clear flag and recheck");
    // Disabled until six digits are typed.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Clear flag and recheck<\/button>/);
  });

  test("no row: the one sentence and Retry, no Check; a read that failed says so and offers nothing", () => {
    const none = text(renderToStaticMarkup(h(VoiceAgentCard, { read: read([]), actions })));
    expect(none).toContain("No voice set-up has been scheduled for this clinic.");
    expect(none).toContain("Retry");
    expect(none).not.toContain("Check against Retell");
    const failedRead = text(renderToStaticMarkup(h(VoiceAgentCard, { read: { ok: false, code: "failed", message: "The voice agents could not be read." }, actions })));
    expect(failedRead).toContain("Could not read the voice agent: The voice agents could not be read.");
    expect(failedRead).not.toContain("Retry");
    expect(failedRead).not.toContain("Check against Retell");
  });

  test("Retry is allowed only where a run can do something", () => {
    expect(retryAllowed(null)).toEqual({ allowed: true, why: null });
    for (const status of ["pending", "failed"] as const) expect(retryAllowed({ ...ready, status }).allowed, status).toBe(true);
    for (const status of ["ready", "provisioning", "deprovisioning", "released"] as const) {
      const r = retryAllowed({ ...ready, status });
      expect(r.allowed, status).toBe(false);
      expect(r.why, status).toMatch(/^Nothing to retry/);
    }
  });
});

describe("the outcome lines", () => {
  test("a retry: ready, already set up, not allowed yet and why, failed", () => {
    expect(retryWords({ ok: true, data: { outcome: "ready", agentId: "agent_abc123", adopted: false } })).toEqual({
      ok: true,
      data: { status: "done", message: "Ready: the agent is set up, and a number is held." },
    });
    expect(retryWords({ ok: true, data: { outcome: "already", status: "ready" } })).toMatchObject({ data: { status: "done", message: "Already ready: nothing was run." } });
    const notYet = retryWords({ ok: true, data: { outcome: "not_eligible", reason: "the first invoice is not paid" } });
    expect(notYet).toEqual({ ok: true, data: { status: "refused", message: "Not allowed yet: the first invoice is not paid." } });
    expect(retryWords({ ok: true, data: { outcome: "switched_off" } })).toMatchObject({ data: { status: "refused", message: expect.stringContaining("switch") } });
    expect(retryWords({ ok: true, data: { outcome: "no_key" } })).toMatchObject({ data: { status: "refused", message: expect.stringContaining("Retell key") } });
    expect(retryWords({ ok: true, data: { outcome: "deferred", reason: "daily_cap" } })).toMatchObject({ data: { status: "refused", message: expect.stringContaining("daily cap") } });
    expect(retryWords({ ok: true, data: { outcome: "failed", code: "rejected", reason: "Retell answered 502" } })).toEqual({
      ok: true,
      data: { status: "refused", message: "Failed (rejected): Retell answered 502." },
    });
    expect(retryWords({ ok: true, data: { outcome: "retry", reason: "Retell did not answer" } })).toMatchObject({ data: { status: "refused" } });
    expect(retryWords({ ok: false, code: "failed", message: "x" })).toEqual({ ok: false, code: "failed", message: "x" });
  });

  test("a check: matches, differs in plain words, not read", () => {
    const report = { clinicId: CLINIC, status: "ready" as const, engine: "custom" as const, ok: true, checked: true, agentExists: true, numberExists: true, problems: [], note: null };
    expect(checkWords({ ok: true, data: { agents: [], report } })).toMatchObject({ data: { status: "done", message: "Matches Retell: the agent and the number are as we set them." } });
    expect(checkWords({ ok: true, data: { agents: [], report: { ...report, ok: false, problems: ["fallback", "number_agent"] } } })).toMatchObject({
      data: { status: "refused", message: "Differs from Retell: the number's fallback is not the clinic's direct line; the number does not route to this agent alone." },
    });
    expect(checkWords({ ok: true, data: { agents: [], report: { ...report, checked: false, note: "no Retell key" } } })).toMatchObject({ data: { message: "Retell was not read: no Retell key." } });
    expect(checkWords({ ok: true, data: { agents: [], report: null } })).toMatchObject({ data: { status: "refused", message: "Retell was not read back." } });
  });

  test("a clear: cleared with what the check found, still drifted with the problem, code refused", () => {
    expect(clearWords({ ok: true, data: { outcome: "cleared", check: "clean", problems: [] } })).toMatchObject({ data: { status: "done", message: "Flag cleared. The check ran: Retell matches our settings." } });
    expect(clearWords({ ok: true, data: { outcome: "cleared", check: "repaired", problems: ["voice"] } })).toMatchObject({ data: { message: expect.stringContaining("repaired Retell: the agent's voice is not the one configured") } });
    expect(clearWords({ ok: true, data: { outcome: "still_drifted", problems: ["agent_missing"] } })).toMatchObject({
      data: { status: "refused", message: "Still drifted: the agent is missing at Retell. The flag stays." },
    });
    expect(clearWords({ ok: true, data: { outcome: "code_refused", message: "That code is not right." } })).toMatchObject({ data: { status: "refused", message: "That code is not right." } });
    expect(clearWords({ ok: true, data: { outcome: "not_flagged" } })).toMatchObject({ data: { status: "done" } });
  });
});

describe("the three controls", () => {
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

  /** Types into a controlled input the way a person does: through the native setter, so React sees a change. */
  async function type(code: string): Promise<void> {
    const input = container.querySelector<HTMLInputElement>('input[name="code"]');
    if (!input) throw new Error("no code field");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(input, code);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  test("Retry and Check against Retell call their actions and say the outcome", async () => {
    const retry = vi.fn(async () => ({ ok: true as const, data: { outcome: "ready" as const, agentId: "agent_abc123", adopted: true } }));
    const check = vi.fn(async () => ({
      ok: true as const,
      data: { agents: [], report: { clinicId: CLINIC, status: "ready" as const, engine: "custom" as const, ok: false, checked: true, agentExists: true, numberExists: true, problems: ["fallback" as const], note: null } },
    }));
    await act(async () => {
      root.render(h(VoiceAgentCard, { read: read([failed]), actions: { retry, check, clearFlag: NEVER } }));
    });
    await act(async () => {
      button("Retry").click();
    });
    await act(async () => {});
    expect(retry).toHaveBeenCalledTimes(1);
    expect(statuses()).toContain("Ready: the agent is set up, adopting the agent the clinic already had, and a number is held.");
    await act(async () => {
      button("Check against Retell").click();
    });
    await act(async () => {});
    expect(check).toHaveBeenCalledTimes(1);
    expect(statuses()).toContain("Differs from Retell: the number's fallback is not the clinic's direct line.");
  });

  test("Clear flag and recheck runs nothing without six digits, asks once, then sends the code; a refused code is said", async () => {
    const clearFlag = vi.fn(async (code: string) =>
      code === "123456"
        ? { ok: true as const, data: { outcome: "cleared" as const, check: "clean" as const, problems: [] } }
        : { ok: true as const, data: { outcome: "code_refused" as const, message: "That code is not right. Nothing was changed." } },
    );
    await act(async () => {
      root.render(h(VoiceAgentCard, { read: read([flagged]), actions: { retry: NEVER, check: NEVER, clearFlag } }));
    });
    expect(button("Clear flag and recheck").disabled).toBe(true);
    await act(async () => {
      button("Clear flag and recheck").click();
    });
    expect(clearFlag).not.toHaveBeenCalled();

    await type("12345");
    expect(button("Clear flag and recheck").disabled).toBe(true);
    await type("123456");
    expect(button("Clear flag and recheck").disabled).toBe(false);
    await act(async () => {
      button("Clear flag and recheck").click();
    });
    expect(clearFlag).not.toHaveBeenCalled();
    expect(container.textContent).toContain(CLEAR_FLAG_CONFIRM);
    await act(async () => {
      button("Yes, clear flag and recheck").click();
    });
    await act(async () => {});
    expect(clearFlag).toHaveBeenCalledWith("123456");
    expect(statuses()).toContain("Flag cleared. The check ran: Retell matches our settings.");

    await type("654321");
    await act(async () => {
      button("Clear flag and recheck").click();
    });
    await act(async () => {
      button("Yes, clear flag and recheck").click();
    });
    await act(async () => {});
    expect(clearFlag).toHaveBeenLastCalledWith("654321");
    expect(statuses()).toContain("That code is not right. Nothing was changed.");
  });
});
