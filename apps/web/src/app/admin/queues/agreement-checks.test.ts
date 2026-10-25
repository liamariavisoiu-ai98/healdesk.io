// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AgreementReview } from "@/lib/admin/ops-client";

import { AgreementChecks } from "./AgreementChecks";

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

describe("Agreement checks", () => {
  test("the answers wait for six digits, then send the answer with the code", async () => {
    const decide = vi.fn(async () => ({
      ok: true as const,
      data: { status: "code_refused" as const, message: "That code was not right." },
    }));
    await act(async () => root.render(h(AgreementChecks, { reviews: [REVIEW], decide })));
    expect(container.textContent).toContain("Code from your authenticator");
    expect(buttons().every((b) => b.disabled)).toBe(true);
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

  test("the section's action goes through the fresh-code wrapper, and the old client is gone", () => {
    const source = readFileSync(join(__dirname, "AgreementChecksSection.tsx"), "utf8");
    expect(source).toContain("recordAgreementAnswerWithCode(clinicId, reviewId, answer, code)");
    expect(source).not.toMatch(/\bdecideAgreementReview\b/);
    const client = readFileSync(join(__dirname, "..", "..", "..", "lib", "admin", "ops-client.ts"), "utf8");
    expect(client).not.toMatch(/export function decideAgreementReview\b/);
  });
});
