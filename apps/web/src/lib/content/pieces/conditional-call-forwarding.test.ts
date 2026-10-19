import {
  CARRIERS,
  CARRIER_SERVICE_NUMBERS,
  COVERAGE_MODES,
  forwardingInstructions,
} from "@healdesk/catalog";
import { describe, expect, it } from "vitest";

import { plain } from "@/lib/content/inline";
import type { Block } from "@/lib/content/types";

import { piece } from "./conditional-call-forwarding";

/**
 * The guide and the catalog's forwarding table (packages/catalog/src/
 * forwarding.ts) cite the same carrier pages and must say the same thing:
 * when a carrier changes a code, both change. Until 19 October 2026 they did
 * not, and the catalog was the one that was wrong. This holds one direction
 * of it: every code the product tells a clinic to dial, and every carrier
 * number it tells a clinic to call, is one the guide documents from the
 * carrier's own page. The guide says more than the catalog dials (codes for
 * another purpose, Google's codes for AT&T mobile lines), so the other
 * direction is the audit's, not a test's.
 */

function blockText(block: Block): string[] {
  switch (block.kind) {
    case "p":
    case "note":
    case "h3":
    case "quote":
      return [block.text];
    case "list":
      return [...block.items];
    case "table":
      return [block.caption, ...block.head, ...block.rows.flat()];
  }
}

const GUIDE = piece.sections
  .flatMap((section) => section.blocks.flatMap(blockText))
  .map(plain)
  .join("\n");

const AYA = "+15125550142";
const NATIONAL = AYA.slice(2);

/**
 * The code in a dial string, without AYA's number or what follows it: "*42"
 * from "*425125550142", "*72" from AT&T Phone's "*725125550142#". A code
 * that takes no number ("*73#", "##004#") is itself; a step that dials AYA's
 * number as it is (ask the carrier, a phone's own settings) has no code.
 */
function codeParts(dial: string): string[] {
  if (dial === "" || dial === AYA) return [];
  const at = dial.indexOf(NATIONAL);
  if (at === -1) return [dial];
  // T-Mobile writes the number with 1 in front (**21*1+number#); *71 keeps its 1.
  const before = dial.slice(0, at).replace(/\*1$/, "*");
  return [before].filter(Boolean);
}

describe("the call-forwarding guide and the catalog", () => {
  it("documents every code the catalog dials, for every carrier and coverage mode", () => {
    for (const carrier of CARRIERS.map((c) => c.id)) {
      for (const routing of COVERAGE_MODES) {
        const f = forwardingInstructions({
          carrier,
          phoneSystemType: "landline",
          routing,
          destinationE164: AYA,
        });
        for (const step of [...f.steps, ...f.undo]) {
          for (const code of codeParts(step.dial)) {
            expect(GUIDE, `${carrier} ${routing}: ${code} (${step.label})`).toContain(code);
          }
        }
      }
    }
  });

  it("prints every carrier service number the catalog tells a clinic to call", () => {
    const digits = GUIDE.replace(/\D/g, "");
    for (const number of CARRIER_SERVICE_NUMBERS) {
      expect(digits, number).toContain(number.replace(/^\+1/, ""));
    }
  });
});
