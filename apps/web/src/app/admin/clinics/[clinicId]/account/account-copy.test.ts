import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { ClinicSignInView, OpsResult } from "@/lib/admin/ops-client";

import { AccountPanel } from "./AccountPanel";

/**
 * What /admin says about a clinic's address and agreement (plan Part K, D5,
 * L): a change under way names when it takes effect and offers the stop; a
 * change is entered only with the call back and a fresh code; a veterinary
 * practice is offered no covered-entity answer; and each clinic card carries
 * its agreement, its channels and its build, by state only. Rendered to
 * static markup and read as text, as the other admin copy rules are.
 */

function text(node: React.ReactElement): string {
  return renderToStaticMarkup(node)
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&rsquo;/g, "’")
    .replace(/\s+/g, " ")
    .trim();
}

const NOT_IN_A_RENDER = async (): Promise<never> => {
  throw new Error("an action ran during a static render");
};
const ACTIONS = {
  changeEmail: NOT_IN_A_RENDER,
  stopChange: NOT_IN_A_RENDER,
  setCovered: NOT_IN_A_RENDER,
};

const CLINIC = "0c1d2e3f-0000-4000-8000-000000000000";

function view(overrides: Partial<ClinicSignInView> = {}): OpsResult<ClinicSignInView> {
  return {
    ok: true,
    data: {
      clinicId: CLINIC,
      clinicName: "Radiance Med Spa",
      address: "info@radiance.test",
      changes: [],
      coveredEntity: {
        specialty: "med-spa",
        regime: "hipaa-if-covered",
        agreementKind: "baa",
        isCoveredEntity: null,
      },
      ...overrides,
    },
  };
}

describe("the account page", () => {
  test("with no change under way: the address, and a change that asks for the call back and a fresh code", () => {
    const page = text(h(AccountPanel, { view: view(), actions: ACTIONS }));
    expect(page).toContain("info@radiance.test");
    expect(page).toContain(
      "Its sign-in, the Stripe customer’s email and the agreement’s notice address",
    );
    expect(page).toContain("I called the practice back on its published number");
    expect(page).toContain("Code from your authenticator");
    expect(page).not.toContain("Stop this change");
  });

  test("a change under way names the end of its objection window and offers the stop, not a second change", () => {
    const page = text(
      h(AccountPanel, {
        view: view({
          changes: [
            {
              id: "9b2e1c4d-1111-4c2a-9a8b-1f2e3d4c5b6a",
              status: "pending",
              source: "operator",
              oldEmail: "info@radiance.test",
              newEmail: "front@radiance.test",
              requestedBy: "ops@healdesk.test",
              createdAt: "2026-10-14T14:32:00.000Z",
              confirmedAt: "2026-10-14T14:32:00.000Z",
              effectiveAt: "2026-10-17T14:32:00.000Z",
              resolvedAt: null,
              stoppedBy: null,
              resolution: null,
            },
          ],
        }),
        actions: ACTIONS,
      }),
    );
    expect(page).toContain("takes effect at 2026-10-17 14:32 UTC, the end of the objection window");
    expect(page).toContain("Stop this change");
    expect(page).not.toContain("Enter the change");
  });

  test("a veterinary practice is offered no covered-entity answer; a DPA practice is told what Yes does", () => {
    const vet = text(
      h(AccountPanel, {
        view: view({
          coveredEntity: {
            specialty: "veterinary",
            regime: "non-hipaa",
            agreementKind: "dpa",
            isCoveredEntity: false,
          },
        }),
        actions: ACTIONS,
      }),
    );
    expect(vet).toContain("A veterinary practice is outside HIPAA");
    expect(vet).not.toContain("Record the answer");

    const dpa = text(
      h(AccountPanel, {
        view: view({
          coveredEntity: {
            specialty: "med-spa",
            regime: "hipaa-if-covered",
            agreementKind: "dpa",
            isCoveredEntity: false,
          },
        }),
        actions: ACTIONS,
      }),
    );
    expect(dpa).toContain("the database refuses its client data from that moment");
    expect(dpa).toContain("Record the answer");
    expect(dpa).not.toMatch(/HIPAA compliant/i);
  });
});
