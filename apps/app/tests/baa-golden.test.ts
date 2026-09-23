import {
  BAA_TEMPLATES,
  CURRENT_BAA_VERSION,
  getBaaTemplate,
  prepareBaa,
  type BaaVariables,
} from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

/**
 * The clause library is frozen per template version, and this is the freeze.
 *
 * Every acceptance row stores the SHA-256 of the exact text the clinic
 * signed. That hash is only evidence if the same template version still
 * renders the same bytes years later — and both published versions share one
 * clause array (`CLAUSES` in packages/catalog/src/baa.ts), so editing a clause
 * "for the next version" silently rewrites what every existing signer's
 * hash points at. The golden hashes below make that edit a failing test.
 *
 * The rule the failure enforces: a change to any clause body, heading,
 * order, predicate or the preamble is a NEW template version. Add it at
 * BAA_TEMPLATES[0] with approvedByCounsel decided honestly, add its hashes
 * here, and leave the old version's entries alone — they are the record.
 *
 * Regenerate a hash only when you have deliberately published a new version:
 *   npx tsx -e 'import("@healdesk/catalog").then(...)' — or simply run this
 *   test and copy the "received" value for the NEW version only.
 */

const BASE: BaaVariables = {
  clinicLegalName: "Golden Clinic LLC",
  specialty: "med-spa",
  signatoryName: "Alex Chen",
  signatoryTitle: "Owner",
  signatoryEmail: "alex@golden.test",
  isCoveredEntity: true,
  attributionMode: "estimated",
  connectedPlatform: null,
  outboundMessaging: false,
  effectiveDate: "2026-09-13",
};

const VARIANTS: Record<string, Partial<BaaVariables>> = {
  covered_estimated: {},
  notcovered_estimated: { isCoveredEntity: false },
  unknown_estimated: { isCoveredEntity: null },
  covered_outbound: { outboundMessaging: true },
  covered_verified_boulevard: { attributionMode: "verified", connectedPlatform: "Boulevard" },
};

/** version → variant → sha256 of the assembled text. Append-only. */
const GOLDEN: Record<string, Record<string, string>> = {
  "1.0.0": {
    covered_estimated: "5a41c9f462386a8ee10d56510e9a6cde6ac360bd5994bca62ddb136dc22596d1",
    notcovered_estimated: "a661fd17d3265e43e559a1cd757475c1ebe9219ce3cf5a7f9691225e74ed69ce",
    unknown_estimated: "3e760495855a168b75cc09982e9b99866d0d7caaaf7cf79d6b1fdf659bd2036a",
    covered_outbound: "2237de75745e9d321cb40dd94d78a953c2aefb8b0f11250b746921a1cb459de2",
    covered_verified_boulevard: "a5ed2a49f75fe51738faa1b034478744d4c4be507568b4ef0abe804d9628514f",
  },
  "1.1.0-draft": {
    covered_estimated: "31f5bf6011424f2983acd08b10e1ebe0adc9be8cb858ac76bcad572602ec10c3",
    notcovered_estimated: "10d21620a629dbc1bc498df9e796793a2a837980d480b6d8a1c50f4b6923b4c4",
    unknown_estimated: "1eb50b21d5202b1d1d5a704e7011aad9dd2b4b9784b231287cf82faf3922bd83",
    covered_outbound: "3fda4d40e8d1fd78bc6d9964f07eb88a255874cd7a21c9fc10e9d67ca46ebf39",
    covered_verified_boulevard: "2b0c42216f6237b73a09d350f16e779ec53eb9ed636d00f2d5ca3763511345bd",
  },
  "0.1.0-draft": {
    covered_estimated: "c3b3dd686657413921e674bed4a1bc3a38f14a5dfd1322c1f53657a2123c0e6b",
    notcovered_estimated: "36272d6588e9223a41b5ad4b390d4136172d4adb8569f87c29ba43b563b5bb97",
    unknown_estimated: "cb20dcffef44d969b48083db8e9a4cf32c440c59e43cda5908c4e1313d2bd8a5",
    covered_outbound: "6177d45f5b1c85951b5a2cca1851fd2945fe3078d651c664989b0d38f88ef588",
    covered_verified_boulevard: "fe7f6b48d5066d7723c0d397a0e414f48412985119ad393bba8e479afbd633a5",
  },
};

describe("BAA template freeze", () => {
  test("every published version has golden hashes, and nothing else does", () => {
    expect(Object.keys(GOLDEN).sort()).toEqual(BAA_TEMPLATES.map((t) => t.version).sort());
    expect(GOLDEN[CURRENT_BAA_VERSION]).toBeDefined();
  });

  for (const [version, variants] of Object.entries(GOLDEN)) {
    for (const [name, hash] of Object.entries(variants)) {
      test(`${version} / ${name} still renders the bytes that were signed`, () => {
        const template = getBaaTemplate(version);
        expect(template, `template ${version} was removed — signed hashes point at it`).toBeDefined();
        const prepared = prepareBaa(template!, { ...BASE, ...VARIANTS[name]! });
        expect(
          prepared.hash,
          `The ${version} agreement text changed. A clause edit is a NEW template version, never a rewrite of one people signed.`,
        ).toBe(hash);
      });
    }
  }

  test("the variants genuinely differ — the predicates are live, not decorative", () => {
    const hashes = new Set(Object.values(GOLDEN[CURRENT_BAA_VERSION]!));
    expect(hashes.size).toBe(Object.keys(VARIANTS).length);
  });
});
