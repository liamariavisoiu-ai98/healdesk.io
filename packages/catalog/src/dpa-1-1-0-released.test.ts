import { describe, expect, test, vi } from "vitest";

/**
 * A throwaway preview of DPA 1.1.0's release: "./dpa" is mocked so that its
 * switch reads true (DPA_TEMPLATES = dpaTemplatesFor(true)), and the modules
 * that offer, sign and accept the DPA are imported against it. The real
 * switch, DPA_1_1_0_RELEASED in dpa.ts, stays false: this file never touches
 * it, and dpa-1-1-0.test.ts asserts it is false.
 *
 * What the release will do, read from the code that will do it: checkout's
 * copy names 1.1.0, signing takes 1.1.0 and asks a tab still on 1.0.0 to
 * reload, both stay released (a 1.0.0 signer keeps a released agreement),
 * and the agreement kind a practice signs does not change.
 */
vi.mock("./dpa", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dpa")>();
  const templates = actual.dpaTemplatesFor(true);
  return {
    ...actual,
    DPA_1_1_0_RELEASED: true,
    DPA_TEMPLATES: templates,
    CURRENT_DPA_VERSION: templates[0]!.version,
    currentDpaTemplate: () => templates[0]!,
    getDpaTemplate: (version: string) => templates.find((t) => t.version === version),
  };
});

const { AGREEMENT_COPY } = await import("./agreement-copy");
const { agreementKindFor, isDpaReleased } = await import("./agreement-kind");
const { agreementTemplateReleased } = await import("./agreement-match");
const { signableDpaTemplate } = await import("./agreement-signing");
const dpa = await import("./dpa");

describe("DPA 1.1.0 released (mocked switch only)", () => {
  test("1.1.0 is current", () => {
    expect(dpa.DPA_1_1_0_RELEASED).toBe(true);
    expect(dpa.CURRENT_DPA_VERSION).toBe("dpa/1.1.0");
    expect(dpa.currentDpaTemplate().approvedByCounsel).toBe(true);
    expect(dpa.DPA_TEMPLATES.map((t) => t.version)).toEqual(["dpa/1.1.0", "dpa/1.0.0"]);
  });

  test("checkout's copy names 1.1.0, and signing takes it and refuses a tab left on 1.0.0", () => {
    expect(AGREEMENT_COPY.dpa.currentVersion).toBe("dpa/1.1.0");
    expect(signableDpaTemplate("dpa/1.1.0").version).toBe("dpa/1.1.0");
    expect(() => signableDpaTemplate("dpa/1.0.0")).toThrow(/reload/);
  });

  test("both versions stay released, and the paper a practice signs is still the DPA", () => {
    expect(agreementTemplateReleased("dpa/1.1.0")).toBe(true);
    expect(agreementTemplateReleased("dpa/1.0.0")).toBe(true);
    expect(isDpaReleased()).toBe(true);
    expect(agreementKindFor({ specialty: "veterinary", covered: null })).toEqual({
      ok: true,
      kind: "dpa",
      isCoveredEntity: false,
    });
  });
});
