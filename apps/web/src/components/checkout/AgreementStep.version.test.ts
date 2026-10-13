// @vitest-environment happy-dom
import { BAA_EXPLAINER, baaExplainerTerms, hashBaaText } from "@healdesk/catalog";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { type AgreementResult, AgreementStep } from "./AgreementStep";

/**
 * The agreement step renders the version it signs (release gate 11,
 * docs/counsel/agreement-changes.md §12.14).
 *
 * Everything the buyer reads is one version's: the "Version …" line, the
 * bullets of "Why you're signing this" and the document itself; and the
 * signature request names that same version and the hash of that same
 * document. Since its release on 13 October 2026 that is 1.4.0, the funnel's
 * own entry (1.3.0 from 12 October until then), which must show 1.3.0's
 * bullets, which 1.4.0 keeps, above 1.4.0's text: never "use it only" and
 * "materially breach" above a clause that says more. 1.2.2,
 * which a screen loaded before the release may still show (the server signs
 * it only inside an overlap, and 1.3.0's release gave it none), is handed to
 * the step as that screen held it
 * (`baaAgreementCopy` for 1.2.2's template), with BAA_EXPLAINER's bullets
 * word for word.
 *
 * Run in a DOM, as the "Sign again" test is, because the signature is an
 * effect and a fetch, which static markup never runs.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The version the step is handed instead of the current one, or null for the funnel's own entry. */
const shown = vi.hoisted(() => ({ version: null as string | null }));

vi.mock("./agreement-kinds", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agreement-kinds")>();
  const { getBaaTemplate } = await import("@healdesk/catalog");
  return {
    ...actual,
    agreementCopyFor: (kind: "baa" | "dpa") =>
      kind === "baa" && shown.version
        ? actual.baaAgreementCopy(getBaaTemplate(shown.version)!)
        : actual.agreementCopyFor(kind),
  };
});

let container: HTMLElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  shown.version = null;
  // No observer: the step lets a reader through once the document is drawn,
  // which is all this test needs of read-to-end.
  vi.stubGlobal("IntersectionObserver", undefined);
  fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { templateVersion: string };
    const result: AgreementResult = {
      agreementId: "6f1b0c9e-8f2a-4d31-9c77-1a2b3c4d5e6f",
      version: body.templateVersion,
      hash: "a".repeat(64),
      text: "(the server's copy)",
      acceptedAt: "2026-10-07T10:00:00.000Z",
      approvedByCounsel: true,
      copy: { status: "sent" },
    };
    return Response.json(result, { status: 201 });
  });
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** The step as the flow hosts it: a med spa that bills insurance, so the BAA whatever the release. */
async function renderStep(onSigned: (result: AgreementResult) => void): Promise<void> {
  await act(async () =>
    root.render(
      h(AgreementStep, {
        step: 3,
        totalSteps: 4,
        onBack: () => undefined,
        clinicName: "Glow Med Spa LLC",
        specialty: "med-spa",
        bookingSystem: "google_calendar",
        calendarAccount: "workspace_baa",
        covered: "yes",
        onCovered: () => undefined,
        contactName: "Laura Owner",
        contactTitle: "Owner",
        contactEmail: "info@glowmedspa.com",
        onContact: () => undefined,
        signed: null,
        onSigned,
        onContinue: () => undefined,
        onResign: () => undefined,
      }),
    ),
  );
}

/** Tick the assent box, press the button, and return the request the step sent. */
async function sign(): Promise<Record<string, unknown>> {
  const tick = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await act(async () => tick.click());
  const button = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Sign and continue"),
  )!;
  expect(button.disabled).toBe(false);
  await act(async () => {
    button.click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
  const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
  expect(url).toBe("/api/agreement");
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

/** The document on screen, exactly as the browser hashed it. */
function documentText(): string {
  const pre = container.querySelector("[data-agreement-end]")?.parentElement?.querySelector("pre");
  expect(pre).toBeTruthy();
  return pre!.textContent ?? "";
}

describe("the agreement step renders the version it signs (gate 11)", () => {
  test("1.2.2, as a screen loaded before the release held it: BAA_EXPLAINER's bullets word for word, above 1.2.2, signing 1.2.2", async () => {
    shown.version = "1.2.2";
    const onSigned = vi.fn();
    await renderStep(onSigned);

    const page = container.textContent ?? "";
    expect(page).toContain("Version 1.2.2");
    for (const term of BAA_EXPLAINER.terms) expect(page).toContain(term.plain);
    expect(page).toContain("use it only");
    const text = documentText();
    expect(text).toContain("Version 1.2.2 — executed electronically");

    const request = await sign();
    expect(request.templateVersion).toBe("1.2.2");
    // The hash of what was on the screen, which the server compares with its own render.
    expect(request.displayedHash).toBe(hashBaaText(text));
    await vi.waitFor(() => expect(onSigned).toHaveBeenCalled());
  });

  test("1.4.0, the current version: 1.3.0's bullets above its own text, and the request names 1.4.0", async () => {
    // The funnel's own entry, not one handed to the step.
    const onSigned = vi.fn();
    await renderStep(onSigned);

    const page = container.textContent ?? "";
    expect(page).toContain("Version 1.4.0");
    // 1.4.0 shows 1.3.0's bullets: its Term clause is 1.3.0's own.
    for (const term of baaExplainerTerms("1.4.0")) expect(page).toContain(term.plain);
    expect(page).toContain("limit its use and disclosure");
    expect(page).toContain("if you determine that we have violated a material term of it");
    expect(page).not.toContain("use it only");
    expect(page).not.toContain("if we materially breach it");
    const text = documentText();
    expect(text).toContain("Version 1.4.0 — executed electronically");
    expect(text).not.toContain("Version 1.3.0");
    // The transcript is emailed, not kept (owner, 13 October 2026).
    expect(text.replace(/\s+/g, " ")).toContain("healdesk does not keep transcripts.");

    const request = await sign();
    expect(request.templateVersion).toBe("1.4.0");
    // Both answers 1.4.0's calendar clause (1.3.0's) is chosen by, as the step was given them.
    expect(request).toMatchObject({
      bookingSystem: "google_calendar",
      calendarAccount: "workspace_baa",
    });
    expect(request.displayedHash).toBe(hashBaaText(text));
    await vi.waitFor(() => expect(onSigned).toHaveBeenCalled());
  });
});
