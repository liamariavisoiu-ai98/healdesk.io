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
  DPA_NO_SMS_1_0,
  DPA_NO_SMS_1_1,
  DPA_TEMPLATE_1_1_0_DRAFT,
  DPA_TEMPLATES,
  dpaTemplatesFor,
  getDpaTemplate,
  prepareDpa,
  type DpaTemplate,
  type DpaVariables,
} from "./dpa";
import { dpaDraft110ReviewDocument, dpaReviewDocument } from "./dpa-review";
import { regimeFor, specialties, type SpecialtyId } from "./specialties";

/**
 * DPA 1.1.0, drafted 30 October 2026 and released by the owner that day
 * (DPA_1_1_0_RELEASED true in dpa.ts): 1.0.0 with the Safeguards clause's
 * telephone exception carrying the one optional payment-link text after a
 * call, in BAA 1.6.0's words (docs/counsel/agreement-changes.md §21). What it
 * says, that it says nothing else new, and that with the switch on checkout
 * offers it and 1.0.0 stays released behind it.
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

/** dpa.test.ts's variants, frozen for 1.1.0. */
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
 * variant → sha256 of 1.1.0's assembled text, generated 30 October 2026 for
 * the draft. A draft's hashes may be regenerated while nobody can sign it;
 * from the release on they never move. dpa/1.0.0's hashes are dpa.test.ts's
 * and did not move with this draft.
 */
const GOLDEN_1_1_0: Record<string, string> = {
  sample: "a5f1eeff14fb2133ac76de1ad517124ce013e3ae74eb190d6f0601112cf79c6c",
  notcovered_live_covered: "c7a7f2a7378a6bfbe2971d90a5b75c068a092d7f68955bb0a7c46a8ec145edcc",
  notcovered_live_uncovered: "ccb98c1068e362b216bfd0aeda843d9e0fc0d98b6c8d0568d43a2f63ff2aa9a3",
  notcovered_live_personal: "0c5f6ad2b5b06c53b7f7041f74833e6c7c08b44650d118c500fa06baa4eb39cd",
  notcovered_notused_other: "32be46a27254399958ca4823c60c640c3ff94c5dacb015872c6a6cf1c1941ac1",
  vet_live_covered: "7b3a8315de4c6528b9f088aac09a2704f67a2eba5407ca7ce17c07d813c168b4",
  vet_live_personal: "1f183a0b76fc2fb9d6632859814aa658a78c7139749028ee02b5f05eed33442b",
  vet_notused_mindbody: "9b16fffc38bd28831d14ce77be86d9bf3b08ae3b5045122dfc1513b86adef784",
};

const V100 = () => getDpaTemplate("dpa/1.0.0")!;
const V110 = DPA_TEMPLATE_1_1_0_DRAFT;
const unwrap = (text: string) => text.replace(/\s+/g, " ").trim();

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

describe("DPA 1.1.0: the text", () => {
  for (const [name, hash] of Object.entries(GOLDEN_1_1_0)) {
    test(`dpa/1.1.0 / ${name} renders the bytes drafted`, () => {
      expect(prepareDpa(V110, { ...SAMPLE, ...VARIANTS[name]! }).hash).toBe(hash);
    });
  }

  test("every 1.1.0 variant is a distinct document, and none is a 1.0.0 document", () => {
    const hashes = Object.values(GOLDEN_1_1_0);
    expect(new Set(hashes).size).toBe(hashes.length);
    for (const [name, overrides] of Object.entries(VARIANTS)) {
      expect(prepareDpa(V100(), { ...SAMPLE, ...overrides }).hash, name).not.toBe(
        GOLDEN_1_1_0[name],
      );
    }
  });

  test("the telephone exception says exactly the new sentence, in the owner's general words", () => {
    expect(DPA_NO_SMS_1_1).toBe(
      "healdesk places no calls and sends no SMS, except that the assistant is engineered and " +
        "designed to offer a caller a single text message that carries fixed wording and " +
        "Practice's own payment link, where Practice has chosen that option. This exception, " +
        "that text included, does not extend to any other channel or content.",
    );
    const body = V110.clauses.find((c) => c.id === "safeguards")!.body(SAMPLE);
    const last = unwrap(body.split("\n\n").at(-1)!);
    expect(last.endsWith(` ${DPA_NO_SMS_1_1}`)).toBe(true);
    expect(last).toBe(
      "One narrow exception: a client who telephones has chosen the telephone, and a telephone " +
        "call is not end-to-end encrypted. healdesk may answer such a call, limited to the " +
        "minimum necessary and never including clinical detail, test results or payment " +
        `information. ${DPA_NO_SMS_1_1}`,
    );
    // Vague on purpose: nothing about how, by whom or when a text goes.
    expect(unwrap(body)).not.toMatch(
      /\b(sender|carrier|registration|registered|vendor|Twilio|phone number|within|minutes?|hours?|after the call)\b/i,
    );
    // Said once, and the old flat sentence is gone.
    expect(unwrap(body).split("single text message").length).toBe(2);
    expect(unwrap(body)).not.toContain(DPA_NO_SMS_1_0);
  });

  test("the rest is 1.0.0, for every answer the funnel can give: the same clauses, the same words", () => {
    expect(V110.clauses).toHaveLength(V100().clauses.length);
    V110.clauses.forEach((clause, i) => {
      const was = V100().clauses[i]!;
      expect(clause.id).toBe(was.id);
      expect(clause.heading).toBe(was.heading);
      // Every clause but Safeguards is 1.0.0's own object.
      if (clause.id !== "safeguards") expect(clause).toBe(was);
    });
    expect(V110.validate).toBe(V100().validate);
    for (const v of everyAnswer()) {
      const now = prepareDpa(V110, v);
      const was = prepareDpa(V100(), v);
      expect(now.clauseIds).toEqual(was.clauseIds);
      expect(applicableDpaClauses(V110, v).map((c) => c.id)).toEqual(was.clauseIds);
      // Put 1.0.0's version line and sentences back, compare with the wrap
      // undone: what is left is 1.0.0's text exactly.
      const back = unwrap(now.text)
        .replace("Version 1.1.0 — executed electronically", "Version 1.0.0 — executed electronically")
        .replace(DPA_NO_SMS_1_1, DPA_NO_SMS_1_0);
      expect(back).toBe(unwrap(was.text));
      // And outside the Safeguards clause the bytes are 1.0.0's, wrap included.
      const strip = (text: string) =>
        text
          .replace(/\n9\. SAFEGUARDS\n[\s\S]*?\n(?=10\. )/, "\n")
          .replace(/^Version 1\.[01]\.0 — executed electronically$/m, "");
      expect(strip(now.text)).toBe(strip(was.text));
    }
  }, 60_000);

  test("dpa/1.0.0 still says healdesk sends no SMS, and nothing of the text", () => {
    const body = unwrap(V100().clauses.find((c) => c.id === "safeguards")!.body(SAMPLE));
    expect(body.endsWith(` ${DPA_NO_SMS_1_0}`)).toBe(true);
    expect(body).toContain("healdesk places no calls and sends no SMS. This exception does not");
    expect(body).not.toMatch(/single text message|payment link/);
    const text = prepareDpa(V100(), SAMPLE).text;
    expect(text.startsWith("HEALDESK DATA PROTECTION AGREEMENT\nVersion 1.0.0 —")).toBe(true);
  });

  test("the draft's preamble differs from 1.0.0's only in its version line", () => {
    const now = V110.preamble(SAMPLE).split("\n");
    const was = V100().preamble(SAMPLE).split("\n");
    expect(now).toHaveLength(was.length);
    expect(now.filter((line, i) => line !== was[i])).toEqual([
      "Version 1.1.0 — executed electronically",
    ]);
    expect(prepareDpa(V110, SAMPLE).text).not.toMatch(/DRAFT|NOT FOR EXECUTION|\{\{/);
  });
});

describe("DPA 1.1.0: the switch, on (released by the owner on 30 October 2026)", () => {
  test("the switch is on; since C13 landed dpa/1.2.0 is current and 1.1.0 follows it, released", () => {
    expect(DPA_1_1_0_RELEASED).toBe(true);
    expect(DPA_TEMPLATES.map((t) => [t.version, t.approvedByCounsel])).toEqual([
      ["dpa/1.2.0", true],
      ["dpa/1.1.0", true],
      ["dpa/1.0.0", true],
    ]);
    expect(CURRENT_DPA_VERSION).toBe("dpa/1.2.0");
    expect(currentDpaTemplate().version).toBe("dpa/1.2.0");
  });

  test("1.1.0 stays released for whoever signed it, and is no longer offered: a tab on it is asked to reload", () => {
    // The draft object keeps its own flag false: only the switch releases it.
    expect(V110.approvedByCounsel).toBe(false);
    expect(getDpaTemplate("dpa/1.1.0")?.approvedByCounsel).toBe(true);
    expect(AGREEMENT_COPY.dpa.currentVersion).toBe("dpa/1.2.0");
    // 1.1.0 and 1.0.0 stay released: whoever signed either is still provisioned and goes live under it.
    expect(agreementTemplateReleased("dpa/1.1.0")).toBe(true);
    expect(agreementTemplateReleased("dpa/1.0.0")).toBe(true);
    expect(() => signableDpaTemplate("dpa/1.1.0")).toThrow(/reload/);
    expect(() => signableDpaTemplate("dpa/1.0.0")).toThrow(/reload/);
    expect(agreementTemplateReleased("dpa/1.3.0")).toBe(false);
    expect(() => signableDpaTemplate("dpa/1.3.0")).toThrow(/Unknown agreement version/);
  });

  test("as released on 30 October 2026 (dpa/1.2.0's switch off), checkout offered and signed 1.1.0 alone", () => {
    const then = dpaTemplatesFor(true, false);
    expect(then.map((t) => [t.version, t.approvedByCounsel])).toEqual([
      ["dpa/1.1.0", true],
      ["dpa/1.0.0", true],
    ]);
    expect(then[0]!.clauses).toBe(V110.clauses);
  });

  test("docs/dpa-v1.0.0.txt is still exactly the released file, and renders 1.0.0 whatever the switch", () => {
    const read = (name: string) =>
      readFileSync(fileURLToPath(new URL(`../../../docs/${name}`, import.meta.url)), "utf8");
    expect(read("dpa-v1.0.0.txt") === dpaReviewDocument()).toBe(true);
    expect(read("dpa-v1.0.0.txt")).not.toContain("single text message");
    expect(
      read("dpa-v1.1.0.txt") === dpaDraft110ReviewDocument(),
      "docs/dpa-v1.1.0.txt is stale: run npm run dpa:review -w @healdesk/catalog",
    ).toBe(true);
  });

  test("docs/dpa-v1.1.0.txt prints the released sample exactly, and says it is released for new signers only", () => {
    const doc = dpaDraft110ReviewDocument();
    const parts = doc.split(`\n${"-".repeat(78)}\n\n`);
    expect(parts[1]!.trimEnd()).toBe(prepareDpa(V110, SAMPLE).text);
    expect(doc).toContain(GOLDEN_1_1_0.sample);
    expect(unwrap(parts[0]!)).toMatch(/version dpa\/1\.1\.0, RELEASED/);
    expect(unwrap(parts[0]!)).not.toMatch(/\bDRAFT\b|NOT RELEASED/);
    expect(unwrap(parts[0]!)).toMatch(/A practice that signed dpa\/1\.0\.0 stays on dpa\/1\.0\.0/);
    expect(unwrap(parts[0]!)).toMatch(/counsel has not reviewed it/);
  });
});

describe("DPA 1.1.0: dpaTemplatesFor(true, false), its release as it happened", () => {
  test("on, 1.1.0 is current and released, and 1.0.0 follows it, the same object", () => {
    const on = dpaTemplatesFor(true, false);
    const off = dpaTemplatesFor(false, false);
    expect(on.map((t) => [t.version, t.approvedByCounsel])).toEqual([
      ["dpa/1.1.0", true],
      ["dpa/1.0.0", true],
    ]);
    expect(on[1]).toBe(off[0]);
    // The words are the draft's, so a signature taken under it re-renders to
    // the same hash once released.
    const { approvedByCounsel: _a, ...released } = on[0]! as DpaTemplate;
    const { approvedByCounsel: _b, ...draft } = V110;
    expect(released).toEqual(draft);
    expect(released.clauses).toBe(draft.clauses);
    expect(prepareDpa(on[0]!, SAMPLE).hash).toBe(GOLDEN_1_1_0.sample);
  });
});
