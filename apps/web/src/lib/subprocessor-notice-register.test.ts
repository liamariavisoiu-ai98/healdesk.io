import { PHI_SUBCONTRACTORS } from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import { PHI_SUBPROCESSORS } from "@/lib/subprocessors";

/**
 * The register here and the catalog's notice list name the same companies
 * (WP7). A subcontractor that handles patient information is added to this
 * internal register and to PHI_SUBCONTRACTORS (packages/catalog
 * operator-notices.ts) together: the register is what an operator answers a
 * practice's written request from, and the catalog is what /admin/notices
 * can announce (L29). One without the other is either a vendor the practices
 * were never told of, or a notice about a vendor the register doesn't know.
 */

/** "Anthropic (the product)" → "Anthropic": the register splits a vendor by the product it serves. */
function company(name: string): string {
  return name.replace(/\s*\(.*\)\s*$/, "").trim();
}

describe("the subcontractors a notice can name", () => {
  test("are exactly the register's companies that handle patient information", () => {
    const register = [...new Set(PHI_SUBPROCESSORS.map((s) => company(s.name)))].sort();
    const catalog = Object.values(PHI_SUBCONTRACTORS)
      .map((s) => s.name)
      .sort();
    expect(catalog).toEqual(register);
  });
});
