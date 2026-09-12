import { describe, expect, test } from "vitest";

import {
  isSpecialtyId,
  requiresBaa,
  SEGMENT_DEFINITIONS,
  SEGMENT_LABELS,
  SEGMENT_TO_SPECIALTY,
  SEGMENTS,
  specialtyForSegment,
} from "@healdesk/catalog";

import { SEGMENT_RULES } from "../src/enrich/segments.ts";

/**
 * The two vocabularies and the bridge between them.
 *
 * The Record types already make most of this a compile error. The runtime
 * checks are here for the build that skips tsc — a `tsx` run of the enrich CLI
 * does not typecheck — and because a test that names the invariant is easier
 * to read than a red squiggle in a file nobody has open.
 */

describe("segment → specialty bridge", () => {
  test("every segment is a key in the map", () => {
    for (const segment of SEGMENTS) {
      expect(segment in SEGMENT_TO_SPECIALTY, `${segment} has no specialty mapping`).toBe(true);
    }
    expect(Object.keys(SEGMENT_TO_SPECIALTY).sort()).toEqual([...SEGMENTS].sort());
  });

  test("every mapped value is a real specialty id or null", () => {
    for (const segment of SEGMENTS) {
      const specialty = specialtyForSegment(segment);
      if (specialty !== null) {
        expect(isSpecialtyId(specialty), `${segment} → ${specialty}`).toBe(true);
      }
    }
  });

  test("the rejects never deep-link anywhere", () => {
    expect(specialtyForSegment("not-a-target")).toBeNull();
    expect(specialtyForSegment("unknown")).toBeNull();
  });

  test("massage and chiropractic stay separate labels on one specialty", () => {
    expect(specialtyForSegment("chiropractic")).toBe("massage-chiro");
    expect(specialtyForSegment("massage-therapy")).toBe("massage-chiro");
  });
});

describe("the classifier is told what every label means", () => {
  test("every segment but unknown has a definition, a label and a prompt line", () => {
    for (const segment of SEGMENTS) {
      expect(SEGMENT_LABELS[segment], `${segment} has no label`).toBeTruthy();
      if (segment === "unknown") continue;
      expect(SEGMENT_DEFINITIONS[segment], `${segment} has no definition`).toBeTruthy();
      // The id must start a line: the model picks ids from the left column.
      expect(SEGMENT_RULES, `${segment} missing from the prompt`).toMatch(
        new RegExp(`^${segment} `, "m"),
      );
    }
  });

  test("unknown is never offered to the classifier", () => {
    expect(SEGMENT_RULES).not.toMatch(/^unknown /m);
  });
});

describe("regulatory regime", () => {
  test("a vet signs an addendum, a dentist signs a BAA", () => {
    expect(requiresBaa("veterinary")).toBe(false);
    expect(requiresBaa("dental")).toBe(true);
    // if-covered defaults to offering the BAA until onboarding says otherwise.
    expect(requiresBaa("massage-chiro")).toBe(true);
  });
});
