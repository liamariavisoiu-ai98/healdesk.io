import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

/**
 * /admin/rights as the operator sees it: the heading, the table and the form
 * when the host answers (the two reads settled together, the clinic list
 * marked synthetic where it is); one standby notice and neither when the AWS
 * host is in standby; and the form's absence, said in a sentence, when the
 * clinic list alone could not be read.
 */

const state = vi.hoisted(() => ({ rights: null as unknown, clinics: null as unknown }));
vi.mock("@/lib/admin/operator", () => ({ requireOperator: async () => "ops@healdesk.test" }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/admin/ops-client", () => ({
  fetchRights: async () => state.rights,
  fetchClinics: async () => state.clinics,
  recordRightsIntake: async () => {
    throw new Error("nothing is recorded during a render");
  },
  closeRightsIntake: async () => {
    throw new Error("nothing is closed during a render");
  },
}));

const { default: RightsPage, metadata } = await import("./page");

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const UNREACHABLE = { ok: false, code: "unreachable", message: "Could not reach the ops API, so nothing below could be read." };
const clinics = {
  ok: true,
  data: {
    connectionStateLimit: 0,
    clinics: [
      { id: CLINIC, name: "Radiance Med Spa", specialty: "medspa", timezone: "America/New_York", dataClassification: "production", attributionMode: "estimated", isCoveredEntity: true, baaSignedOn: null, blockers: [], connection: "unknown" },
      { id: "6d1ffee1-2222-4d3b-8b9c-2a3f4e5d6c7b", name: "Demo Clinic", specialty: "medspa", timezone: "UTC", dataClassification: "synthetic", attributionMode: "estimated", isCoveredEntity: null, baaSignedOn: null, blockers: [], connection: "unknown" },
    ],
  },
};

async function render(): Promise<string> {
  return renderToStaticMarkup((await RightsPage()) as ReactElement).replace(/<!-- -->/g, "");
}

describe("/admin/rights", () => {
  test("is titled Patient rights, says the clocks, and draws the table and the form from the two reads", async () => {
    state.rights = { ok: true, data: { rows: [], count: 0, truncated: false, unreadClinics: 0 } };
    state.clinics = clinics;
    expect(metadata.title).toBe("Patient rights");
    const html = await render();
    expect(html).toContain(">Patient rights<");
    expect(html).toContain("ten business days for an");
    expect(html).toContain("This page runs nothing. You run each command yourself.");
    expect(html).toContain("No open requests.");
    expect(html).toContain("Record a request");
    expect(html).toContain("Radiance Med Spa");
    expect(html).toContain("Demo Clinic (synthetic)");
    expect(html).not.toContain("The AWS host is in standby.");
  });

  test("in standby is one notice, with neither the table nor the form", async () => {
    state.rights = UNREACHABLE;
    state.clinics = UNREACHABLE;
    const html = await render();
    expect(html.match(/The AWS host is in standby\./g)).toHaveLength(1);
    expect(html).toContain("The patient-rights requests lives");
    expect(html).not.toContain("Record a request");
    expect(html).not.toContain("This page runs nothing.");
  });

  test("with the requests read and the clinic list not, the table stands and the form says why it is missing", async () => {
    state.rights = { ok: true, data: { rows: [], count: 0, truncated: false, unreadClinics: 0 } };
    state.clinics = { ok: false, code: "failed", message: "The ops API failed while answering, so nothing below could be read." };
    const html = await render();
    expect(html).toContain("No open requests.");
    expect(html).toContain("The clinic list could not be read, so no request can be recorded here until it can.");
    expect(html).not.toContain("<form");
  });
});
