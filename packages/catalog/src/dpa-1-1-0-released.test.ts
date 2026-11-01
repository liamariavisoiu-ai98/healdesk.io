import { describe, expect, test } from "vitest";

import { AGREEMENT_COPY } from "./agreement-copy";
import { agreementKindFor, isDpaReleased } from "./agreement-kind";
import { agreementTemplateReleased } from "./agreement-match";
import { signableDpaTemplate } from "./agreement-signing";
import * as dpa from "./dpa";

/**
 * DPA 1.1.0's release, read from the code that does it. Until the owner's
 * release on 30 October 2026 this file mocked "./dpa" so that its switch read
 * true; the real switch, DPA_1_1_0_RELEASED in dpa.ts, is now true, so the
 * mock is gone and every assertion runs against the real catalogue.
 *
 * What the release did: checkout's copy named 1.1.0, signing took 1.1.0
 * and asked a tab still on 1.0.0 to reload, both stay released (a 1.0.0
 * signer keeps a released agreement, and stays on it: nothing in the product
 * re-signs a newer DPA), and the agreement kind a practice signs did not
 * change. Since C13 landed, dpa/1.2.0 is current (dpa-1-2-0.test.ts):
 * 1.1.0 stays released behind it, and a tab still on 1.1.0 is asked to
 * reload as 1.0.0's is.
 */

describe("DPA 1.1.0 released", () => {
  test("1.1.0 is released, and since C13 landed dpa/1.2.0 is current ahead of it", () => {
    expect(dpa.DPA_1_1_0_RELEASED).toBe(true);
    expect(dpa.CURRENT_DPA_VERSION).toBe("dpa/1.2.0");
    expect(dpa.currentDpaTemplate().approvedByCounsel).toBe(true);
    expect(dpa.DPA_TEMPLATES.map((t) => t.version)).toEqual([
      "dpa/1.2.0",
      "dpa/1.1.0",
      "dpa/1.0.0",
    ]);
    // As released on 30 October 2026, with 1.2.0's switch off: 1.1.0 first.
    expect(dpa.dpaTemplatesFor(true, false).map((t) => t.version)).toEqual([
      "dpa/1.1.0",
      "dpa/1.0.0",
    ]);
  });

  test("checkout's copy names the current DPA, and signing refuses a tab left on 1.1.0 or 1.0.0", () => {
    expect(AGREEMENT_COPY.dpa.currentVersion).toBe("dpa/1.2.0");
    expect(signableDpaTemplate("dpa/1.2.0").version).toBe("dpa/1.2.0");
    expect(() => signableDpaTemplate("dpa/1.1.0")).toThrow(/reload/);
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
