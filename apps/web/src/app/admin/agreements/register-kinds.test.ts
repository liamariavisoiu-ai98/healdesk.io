import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { OpsAgreement } from "@/lib/admin/ops-client";

import {
  agreementLabel,
  AgreementsRegister,
  fallbackFilename,
  type RegisterActions,
} from "./AgreementsRegister";

/**
 * The register names each row's agreement by its kind (plan Part L, Copy:
 * "BAA wording never beside a DPA"). Until 19 October 2026 it called every row
 * a business associate agreement, printed a data protection agreement's
 * version as "vdpa/1.0.0", and saved a DPA's PDF as healdesk-baa.pdf when the
 * route sent no filename.
 */

const NOT_IN_A_RENDER = async (): Promise<never> => {
  throw new Error("an action ran during a static render");
};
const ACTIONS: RegisterActions = {
  resendCopy: NOT_IN_A_RENDER,
  markTerminated: NOT_IN_A_RENDER,
  mintDownload: NOT_IN_A_RENDER,
};

function row(version: string, id: string): OpsAgreement {
  return {
    id,
    clinicName: version.startsWith("dpa/") ? "Paws Veterinary LLC" : "Glow Med Spa LLC",
    version,
    signatory: "Alex Chen, Owner",
    signatoryEmail: "info@example.test",
    signedAt: "2026-10-14 14:32 UTC",
    signedOn: "2026-10-14",
    copySentOn: "2026-10-14",
    retention: { state: "live" },
    status: "in_effect",
    documentHash: "a".repeat(64),
  };
}

function words(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("the agreement register names each agreement by its kind", () => {
  test("labels and fallback filenames", () => {
    expect(agreementLabel("1.5.1")).toBe("BAA v1.5.1");
    expect(agreementLabel("dpa/1.0.0")).toBe("DPA v1.0.0");
    expect(fallbackFilename("1.5.1")).toBe("healdesk-baa.pdf");
    expect(fallbackFilename("dpa/1.0.0")).toBe("healdesk-dpa.pdf");
  });

  test("a BAA row and a DPA row, each labelled as itself, under a heading that is neither's alone", () => {
    const html = renderToStaticMarkup(
      h(AgreementsRegister, {
        register: {
          rows: [
            row("1.5.1", "6f1b0c9e-8f2a-4d31-9c77-1a2b3c4d5e6f"),
            row("dpa/1.0.0", "7a2c1d0f-9e3b-4e42-8d88-2b3c4d5e6f70"),
          ],
          total: 2,
          truncated: false,
          today: "2026-10-19",
        },
        filters: {},
        actions: ACTIONS,
      }),
    );
    const said = words(html);
    expect(said).toContain("BAA v1.5.1");
    expect(said).toContain("DPA v1.0.0");
    expect(said).not.toContain("vdpa/");
    expect(said).not.toMatch(/business associate/i);
    expect(said).toContain("Signed agreements");
    // The filter's suggestion keeps the stored version, which the search matches, and says what it is.
    expect(html).toMatch(/<option value="dpa\/1.0.0" label="DPA v1.0.0"/);
  });
});

test("the page's own introduction names both kinds", () => {
  const page = readFileSync(join(__dirname, "page.tsx"), "utf8").replace(/\s+/g, " ");
  expect(page).not.toContain("Every BAA anyone has signed");
  expect(page).toContain(
    "Every agreement anyone has signed, paid for or not: a business associate agreement, or the data protection agreement a practice HIPAA does not cover signs instead.",
  );
});
