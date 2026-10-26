// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AgreementReview } from "@/lib/admin/ops-client";

import { AgreementChecks, ASK_WORDS, ASKED_WORDS, type Ask } from "./AgreementChecks";

/**
 * Queues › Agreement checks (lane P6f): every answer, Yes, No or Not sure,
 * needs the code from the operator's authenticator, because a Yes or Not
 * sure pauses AYA at every location of the practice. The buttons stay off
 * until six digits are typed, the action receives the code with the answer,
 * and the section's server action goes through the fresh-code wrapper
 * (lib/admin/agreement-answer.ts), never the old unguarded client.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REVIEW: AgreementReview = {
  id: "9a8b7c6d-1111-4222-8333-444455556666",
  clinicId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  clinicSlug: "radiance-med-spa",
  clinicName: "Radiance Med Spa",
  status: "open",
  signal: "site_accepts_insurance",
  createdAt: { on: "2026-10-19", at: "19 Oct 2026, 10:00 UTC" },
  decidedAt: null,
  decidedByLabel: null,
};

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

function buttons(): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")] as HTMLButtonElement[];
}

const NO_ASK: Ask = async () => {
  throw new Error("nothing is proposed in this test");
};

/** The answers' buttons: everything but the proposal, which needs no code. */
const answerButtons = () => buttons().filter((b) => b.textContent !== "Ask the practice");

describe("Agreement checks", () => {
  test("the answers wait for six digits, then send the answer with the code", async () => {
    const decide = vi.fn(async () => ({
      ok: true as const,
      data: { status: "code_refused" as const, message: "That code was not right." },
    }));
    await act(async () => root.render(h(AgreementChecks, { reviews: [REVIEW], decide, ask: NO_ASK })));
    expect(container.textContent).toContain("Approval passcode (or authenticator code)");
    expect(answerButtons().every((b) => b.disabled)).toBe(true);
    const input = container.querySelector("input[name=code]") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(input, "123456");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const yes = buttons().find((b) => b.textContent?.startsWith("Yes"))!;
    expect(yes.disabled).toBe(false);
    await act(async () => yes.click());
    expect(decide).toHaveBeenCalledWith(REVIEW.clinicId, REVIEW.id, "yes", "123456");
    expect(container.textContent).toContain("That code was not right.");
  });

  test("Ask the practice needs no code, proposes the question with the row's ids and says it waits under Approvals; a refusal is apps/app's sentence", async () => {
    const ask = vi.fn<Ask>(async () => ({ ok: true, data: { status: "proposed", approvalId: REVIEW.id } }));
    const decide = vi.fn(async () => ({ ok: true as const, data: { status: "code_refused" as const, message: "x" } }));
    await act(async () => root.render(h(AgreementChecks, { reviews: [REVIEW], decide, ask })));
    expect(container.textContent).toContain(ASK_WORDS);
    expect(ASK_WORDS).toContain("Nothing is sent until you approve it in Approvals.");
    const button = buttons().find((b) => b.textContent === "Ask the practice")!;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    await act(async () => {});
    expect(ask).toHaveBeenCalledWith(REVIEW.clinicId, REVIEW.id);
    expect(decide).not.toHaveBeenCalled();
    expect([...container.querySelectorAll('[role="status"]')].map((n) => n.textContent)).toContain(ASKED_WORDS);

    // Decided: no question to propose, no button.
    await act(async () => root.render(h(AgreementChecks, { reviews: [{ ...REVIEW, id: "1", status: "passed", decidedAt: { on: "2026-10-20", at: "20 Oct 2026, 10:00 UTC" }, decidedByLabel: "ops@healdesk.test" }], decide, ask })));
    expect(buttons().find((b) => b.textContent === "Ask the practice")).toBeUndefined();

    // A refusal, in apps/app's words (resign-ops.ts opProposeAgreementQuestion).
    const refusing = vi.fn<Ask>(async () => ({ ok: true, data: { status: "refused", message: "A re-sign is already open for this practice, so there is nothing to ask." } }));
    await act(async () => root.render(h(AgreementChecks, { reviews: [REVIEW], decide, ask: refusing })));
    await act(async () => buttons().find((b) => b.textContent === "Ask the practice")!.click());
    await act(async () => {});
    expect(container.textContent).toContain("A re-sign is already open for this practice, so there is nothing to ask.");
  });

  test("the section's actions: the answer through the fresh-code wrapper, the question through the proposal alone, and the old client gone", () => {
    const source = readFileSync(join(__dirname, "AgreementChecksSection.tsx"), "utf8");
    expect(source).toContain("recordAgreementAnswerWithCode(clinicId, reviewId, answer, code)");
    expect(source).toContain("proposeAgreementQuestion(clinicId, reviewId)");
    expect(source).not.toMatch(/\bdecideAgreementReview\b/);
    const client = readFileSync(join(__dirname, "..", "..", "..", "lib", "admin", "ops-client.ts"), "utf8");
    expect(client).not.toMatch(/export function decideAgreementReview\b/);
  });
});
