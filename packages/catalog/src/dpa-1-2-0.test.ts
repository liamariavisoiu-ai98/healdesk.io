import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { AGREEMENT_COPY } from "./agreement-copy";
import { agreementTemplateReleased } from "./agreement-match";
import { signableDpaTemplate } from "./agreement-signing";
import { BOOKING_SYSTEMS, type BookingSystemId } from "./booking-systems";
import { CALENDAR_ACCOUNTS } from "./calendar-terms";
import {
  applicableDpaClauses,
  CURRENT_DPA_VERSION,
  currentDpaTemplate,
  DPA_1_1_0_RELEASED,
  DPA_1_2_0_RELEASED,
  DPA_TEMPLATE_1_1_0_DRAFT,
  DPA_TEMPLATE_1_2_0_DRAFT,
  DPA_TEMPLATES,
  dpaTemplatesFor,
  getDpaTemplate,
  hashDpaText,
  prepareDpa,
  type DpaTemplate,
  type DpaVariables,
} from "./dpa";
import { dpaRelease120ReviewDocument } from "./dpa-review";
import { regimeFor, specialties, type SpecialtyId } from "./specialties";
import { subprocessorNoticeClauseBody, subprocessorNoticeClauseBody15Days } from "./subprocessor-notice";
import { wrap } from "./wrap";

/**
 * DPA 1.2.0: the owner's release of 30 October 2026 ("release BAA 1.7.0 and
 * DPA 1.1.0"; ten calendar days to report, fifteen days' notice of a new
 * subcontractor), landed on 1 November 2026 ("Go C13"). Its branch called it
 * dpa/1.1.0, a number main had already released for the payment-link text,
 * so it sits on top of that one (dpa.ts; docs/counsel/agreement-changes.md
 * §22). What it says, that it says nothing else new against dpa/1.1.0, that
 * its words are the owner's release word for word, and that with the switch
 * on checkout offers it and 1.1.0 and 1.0.0 stay released behind it.
 */

const SAMPLE: DpaVariables = {
  clinicLegalName: "Glow Med Spa LLC",
  signatoryName: "Alex Chen",
  signatoryTitle: "Owner",
  signatoryEmail: "alex@glowmedspa.test",
  effectiveDate: "2026-10-06",
  specialty: "med-spa",
  bookingSystem: "mindbody",
  calendarAccount: "personal",
};

const VET = { clinicLegalName: "Golden Paws Veterinary LLC", specialty: "veterinary" } as const;

/** dpa.test.ts's variants, frozen for 1.2.0. */
const VARIANTS: Record<string, Partial<DpaVariables>> = {
  sample: {},
  notcovered_live_covered: { bookingSystem: "none", calendarAccount: "workspace_baa" },
  notcovered_live_uncovered: {
    specialty: "hair-restoration",
    bookingSystem: "calendly",
    calendarAccount: "workspace_no_baa",
  },
  notcovered_live_personal: {
    specialty: "massage-chiro",
    bookingSystem: "google_calendar",
    calendarAccount: "personal",
  },
  notcovered_notused_other: { bookingSystem: "other", calendarAccount: "workspace_no_baa" },
  vet_live_covered: { ...VET, bookingSystem: "none", calendarAccount: "workspace_baa" },
  vet_live_personal: { ...VET, bookingSystem: "gohighlevel", calendarAccount: "personal" },
  vet_notused_mindbody: { ...VET, bookingSystem: "mindbody", calendarAccount: "personal" },
};

/**
 * variant → sha256 of 1.2.0's assembled text, generated 1 November 2026 when
 * it landed. Released, so they never move: a change is a new version.
 */
const GOLDEN_1_2_0: Record<string, string> = {
  sample: "9e34238a0e47f8a67404b57ee8fa1ba40d6d7fecdc210149fc59d3018a54e49d",
  notcovered_live_covered: "9c4b4b50d2c190d69620dae96ef499580cf60dce3ec1318218b83ecb116816db",
  notcovered_live_uncovered: "72bf93ee30c99675c56413a12c3793f662158ca6ceb5a6af182ef2a19fe4b589",
  notcovered_live_personal: "68e7b2c40cab2282325c215792a77d017a28daa85c2b0bf55666582fe08e2f09",
  notcovered_notused_other: "f75bc1e2088e879d8b9688ff71bf0ff43b5fab951ac2558ed8a2a257de840807",
  vet_live_covered: "4e68b78c10ac0823dac6aa86e7ddb6266703a2ea3532acb62dccfedba9ae16a2",
  vet_live_personal: "c8811a399b0953c32eff289fa9181864f3865f7619372f31f5390e76b5bf6ccb",
  vet_notused_mindbody: "987cb8165dbf7948c938709a7e701d1b32b589f9377281b32acfdf4557745ff7",
};

/**
 * The SHA-256 of the sample the owner released on 30 October 2026, as its
 * branch's review copy recorded it (docs/dpa-v1.1.0.txt on
 * claude/friendly-edison-bwvr76, LEGAL-4: "SHA-256 286867bb…"), under the
 * version line "Version 1.1.0". 1.2.0's sample with that version line put
 * back hashes to it: the words are the owner's release, word for word.
 */
const RELEASED_AS_1_1_0_ON_ITS_BRANCH =
  "286867bb69538891ce27d08a71f476be039367dffd0c01e619374d775bdc49de";

const V110 = DPA_TEMPLATE_1_1_0_DRAFT;
const V120 = DPA_TEMPLATE_1_2_0_DRAFT;
const unwrap = (text: string) => text.replace(/\s+/g, " ").trim();
const SIXTY = "in no case later than 60 calendar days after discovery:";
const TEN = "in no case later than 10 calendar days after discovery:";

/** Every input the funnel can produce for a practice that signs the DPA. */
function everyAnswer(): DpaVariables[] {
  const ids = specialties.map((s) => s.id).filter((id) => regimeFor(id) !== "hipaa");
  const all: DpaVariables[] = [];
  for (const specialty of ids as SpecialtyId[]) {
    for (const bookingSystem of BOOKING_SYSTEMS.map((s) => s.id) as BookingSystemId[]) {
      for (const calendarAccount of CALENDAR_ACCOUNTS) {
        all.push({ ...SAMPLE, specialty, bookingSystem, calendarAccount });
      }
    }
  }
  return all;
}

describe("DPA 1.2.0: the text", () => {
  for (const [name, hash] of Object.entries(GOLDEN_1_2_0)) {
    test(`dpa/1.2.0 / ${name} renders the bytes released`, () => {
      expect(prepareDpa(V120, { ...SAMPLE, ...VARIANTS[name]! }).hash).toBe(hash);
    });
  }

  test("its words are the owner's release of 30 October 2026, word for word but for the version line", () => {
    const text = prepareDpa(V120, SAMPLE).text;
    const asReleased = text.replace(
      "\nVersion 1.2.0 — executed electronically\n",
      "\nVersion 1.1.0 — executed electronically\n",
    );
    expect(asReleased).not.toBe(text);
    expect(hashDpaText(asReleased)).toBe(RELEASED_AS_1_1_0_ON_ITS_BRANCH);
  });

  test("every 1.2.0 variant is a distinct document, and none is a 1.1.0 document", () => {
    const hashes = Object.values(GOLDEN_1_2_0);
    expect(new Set(hashes).size).toBe(hashes.length);
    for (const [name, overrides] of Object.entries(VARIANTS)) {
      expect(prepareDpa(V110, { ...SAMPLE, ...overrides }).hash, name).not.toBe(
        GOLDEN_1_2_0[name],
      );
    }
  });

  test("the incidents clause reports in no case later than 10 calendar days, 'without unreasonable delay' still first", () => {
    const now = unwrap(V120.clauses.find((c) => c.id === "incidents")!.body(SAMPLE).split("\n\n")[0]!);
    const was = unwrap(V110.clauses.find((c) => c.id === "incidents")!.body(SAMPLE).split("\n\n")[0]!);
    expect(was.endsWith(` ${SIXTY}`)).toBe(true);
    expect(now.endsWith(` ${TEN}`)).toBe(true);
    expect(now).toContain("without unreasonable delay");
    expect(now.slice(0, -TEN.length)).toBe(was.slice(0, -SIXTY.length));
  });

  test("the subcontractors clause gives at least 15 days' notice, with the same recipient, contents and objection right", () => {
    const now = V120.clauses.find((c) => c.id === "subcontractors")!.body(SAMPLE).split("\n\n");
    const was = V110.clauses.find((c) => c.id === "subcontractors")!.body(SAMPLE).split("\n\n");
    expect(was.at(-1)).toBe(wrap(subprocessorNoticeClauseBody()));
    expect(now.at(-1)).toBe(wrap(subprocessorNoticeClauseBody15Days()));
    expect(unwrap(now.at(-1)!)).toContain("at least 15 days' notice by email");
    expect(now.slice(0, -1)).toEqual(was.slice(0, -1));
    expect(
      unwrap(subprocessorNoticeClauseBody15Days()).replace("15 days'", "24 hours'"),
    ).toBe(unwrap(subprocessorNoticeClauseBody()));
  });

  test("the rest is 1.1.0, the payment-link text included, for every answer the funnel can give", () => {
    expect(V120.clauses).toHaveLength(V110.clauses.length);
    V120.clauses.forEach((clause, i) => {
      const was = V110.clauses[i]!;
      expect(clause.id).toBe(was.id);
      expect(clause.heading).toBe(was.heading);
      // Every clause but the two above is 1.1.0's own object, Safeguards included.
      if (clause.id !== "incidents" && clause.id !== "subcontractors") expect(clause).toBe(was);
    });
    expect(V120.validate).toBe(V110.validate);
    for (const v of everyAnswer()) {
      const now = prepareDpa(V120, v);
      const was = prepareDpa(V110, v);
      expect(now.clauseIds).toEqual(was.clauseIds);
      expect(applicableDpaClauses(V120, v).map((c) => c.id)).toEqual(was.clauseIds);
      // Put 1.1.0's version line and sentences back, compare with the wrap
      // undone: what is left is 1.1.0's text exactly.
      const back = unwrap(now.text)
        .replace("Version 1.2.0 — executed electronically", "Version 1.1.0 — executed electronically")
        .replace(TEN, SIXTY)
        .replace("at least 15 days' notice by email", "at least 24 hours' notice by email");
      expect(back).toBe(unwrap(was.text));
    }
  }, 60_000);

  test("the preamble differs from 1.1.0's only in its version line", () => {
    const now = V120.preamble(SAMPLE).split("\n");
    const was = V110.preamble(SAMPLE).split("\n");
    expect(now).toHaveLength(was.length);
    expect(now.filter((line, i) => line !== was[i])).toEqual([
      "Version 1.2.0 — executed electronically",
    ]);
    expect(prepareDpa(V120, SAMPLE).text).not.toMatch(/DRAFT|NOT FOR EXECUTION|\{\{/);
  });
});

describe("DPA 1.2.0: the switch, on (the owner's release, landed 1 November 2026)", () => {
  test("the switch is on, and DPA_TEMPLATES is dpa/1.2.0, then dpa/1.1.0 and dpa/1.0.0, all released", () => {
    expect(DPA_1_1_0_RELEASED).toBe(true);
    expect(DPA_1_2_0_RELEASED).toBe(true);
    expect(DPA_TEMPLATES).toEqual(dpaTemplatesFor(true, true));
    expect(DPA_TEMPLATES.map((t) => [t.version, t.approvedByCounsel])).toEqual([
      ["dpa/1.2.0", true],
      ["dpa/1.1.0", true],
      ["dpa/1.0.0", true],
    ]);
    expect(CURRENT_DPA_VERSION).toBe("dpa/1.2.0");
    expect(currentDpaTemplate().approvedByCounsel).toBe(true);
  });

  test("checkout offers and signs 1.2.0 alone; 1.1.0 and 1.0.0 stay released but ask the signer to reload", () => {
    // The draft object keeps its own flag false: only the switch releases it.
    expect(V120.approvedByCounsel).toBe(false);
    expect(getDpaTemplate("dpa/1.2.0")?.approvedByCounsel).toBe(true);
    expect(AGREEMENT_COPY.dpa.currentVersion).toBe("dpa/1.2.0");
    expect(agreementTemplateReleased("dpa/1.2.0")).toBe(true);
    expect(agreementTemplateReleased("dpa/1.1.0")).toBe(true);
    expect(agreementTemplateReleased("dpa/1.0.0")).toBe(true);
    expect(signableDpaTemplate("dpa/1.2.0").version).toBe("dpa/1.2.0");
    expect(() => signableDpaTemplate("dpa/1.1.0")).toThrow(/reload/);
    expect(() => signableDpaTemplate("dpa/1.0.0")).toThrow(/reload/);
  });

  test("off, 1.2.0 is not registered at all, as 1.1.0 was not before its release", () => {
    expect(dpaTemplatesFor(true, false).map((t) => t.version)).toEqual(["dpa/1.1.0", "dpa/1.0.0"]);
    expect(() => dpaTemplatesFor(false, true)).toThrow(/1\.1\.0/);
  });

  test("on, the words are the draft's: the release moved only its place and its flag", () => {
    const released = dpaTemplatesFor(true, true)[0]!;
    const { approvedByCounsel: _a, ...rest } = released as DpaTemplate;
    const { approvedByCounsel: _b, ...draft } = V120;
    expect(rest).toEqual(draft);
    expect(released.clauses).toBe(V120.clauses);
    expect(prepareDpa(released, SAMPLE).hash).toBe(GOLDEN_1_2_0.sample);
  });

  test("docs/dpa-v1.2.0.txt is exactly the review copy, prints the released sample, and says why it is 1.2.0", () => {
    const read = (name: string) =>
      readFileSync(fileURLToPath(new URL(`../../../docs/${name}`, import.meta.url)), "utf8");
    expect(
      read("dpa-v1.2.0.txt") === dpaRelease120ReviewDocument(),
      "docs/dpa-v1.2.0.txt is stale: run npm run dpa:review -w @healdesk/catalog",
    ).toBe(true);
    const doc = dpaRelease120ReviewDocument();
    const parts = doc.split(`\n${"-".repeat(78)}\n\n`);
    expect(parts[1]!.trimEnd()).toBe(prepareDpa(V120, SAMPLE).text);
    expect(doc).toContain(GOLDEN_1_2_0.sample);
    const head = unwrap(parts[0]!);
    expect(head).toMatch(/version dpa\/1\.2\.0, RELEASED/);
    expect(head).not.toMatch(/\bDRAFT\b|NOT RELEASED/);
    expect(head).toMatch(/landed as dpa\/1\.2\.0/);
    expect(head).toMatch(/counsel has not reviewed it/);
  });
});
