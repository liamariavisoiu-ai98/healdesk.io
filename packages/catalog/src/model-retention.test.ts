import { describe, expect, test } from "vitest";

import {
  isPatientModelId,
  MODEL_FLAGGED_RETENTION_YEARS,
  MODEL_RETENTION_AGREEMENT,
  MODEL_RETENTION_EXCEPTIONS,
  MODEL_RETENTION_PUBLIC,
  MODEL_RETENTION_SOURCES,
  MODEL_RETENTION_VERIFIED_ON,
  MODEL_STANDARD_RETENTION_DAYS,
  PATIENT_MODEL_IDS,
} from "./model-retention";

/**
 * The model provider's retention, held to Anthropic's documentation for the
 * models the product calls (docs/counsel/agreement-changes.md §17). Every
 * surface that states the retention reads these sentences, so a word wrong
 * here is wrong everywhere: the checks are on the sentences themselves.
 */

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const SENTENCES = {
  public: MODEL_RETENTION_PUBLIC,
  agreement: MODEL_RETENTION_AGREEMENT,
  exceptions: MODEL_RETENTION_EXCEPTIONS,
};

/** The sentences of a text, split at a full stop or a colon. */
const clauses = (text: string) => text.split(/(?<=[.:;])\s+/);

describe("the patient models", () => {
  test("are none of Anthropic's Covered Models, whose 30 days are a minimum, not a ceiling", () => {
    // Claude Fable 5 and 5.1 and Claude Mythos 5 and 5.1 must keep content
    // for at least 30 days. "No more than 30 days" is false for them, so a
    // Covered Model joins this list only with a new wording, new terms and a
    // new BAA version.
    expect(PATIENT_MODEL_IDS.length).toBeGreaterThan(0);
    for (const id of PATIENT_MODEL_IDS) expect(id, id).not.toMatch(/fable|mythos/i);
  });

  test("are what the guard accepts, and nothing else", () => {
    for (const id of PATIENT_MODEL_IDS) expect(isPatientModelId(id), id).toBe(true);
    for (const id of ["claude-fable-5", "claude-fable-5-1", "claude-mythos-5-1", "", " claude-opus-5-5", null, 5]) {
      expect(isPatientModelId(id), String(id)).toBe(false);
    }
  });
});

describe("the sources", () => {
  test("are Anthropic's own pages, checked within the last twelve months", () => {
    // Against the real clock, as the editorial library's sources are: a check
    // a year old fails the build until someone rereads the pages.
    for (const url of MODEL_RETENTION_SOURCES) {
      expect(url).toMatch(/^https:\/\/(platform|privacy|support)\.claude\.com\//);
    }
    expect(MODEL_RETENTION_VERIFIED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const age = Date.now() - Date.parse(MODEL_RETENTION_VERIFIED_ON);
    expect(age, "checked in the future").toBeGreaterThan(-YEAR_MS / 365);
    expect(age, "not rechecked in twelve months: reread MODEL_RETENTION_SOURCES").toBeLessThan(YEAR_MS);
  });
});

describe.each(Object.entries(SENTENCES))("the %s sentences", (_name, text) => {
  test("give the two years to flagged content alone", () => {
    expect(MODEL_FLAGGED_RETENTION_YEARS).toBe(2);
    const withYears = clauses(text).filter((c) => /two years/.test(c));
    expect(withYears).toHaveLength(1);
    for (const clause of withYears) expect(clause).toMatch(/flag/);
    // The law-required exception carries no cap: Anthropic states none.
    expect(text).not.toMatch(/law requires[^.]*two years/);
    expect(text).toContain("content the law requires it to keep, which it may keep for as long as the law requires");
  });

  test("claim nothing Anthropic says only of its Covered Models, and no purpose it does not state", () => {
    expect(text).not.toMatch(/cannot run with|run with none|covered models? require|cannot shorten/i);
    expect(text).not.toMatch(/abuse detection|security/i);
  });
});

describe.each([
  ["public", MODEL_RETENTION_PUBLIC],
  ["agreement", MODEL_RETENTION_AGREEMENT],
] as const)("the %s sentences", (name, text) => {
  test("state the 30 days as a ceiling, with no training", () => {
    expect(MODEL_STANDARD_RETENTION_DAYS).toBe(30);
    expect(text).toContain("for no more than the 30 days of its standard retention, and then deletes it");
    expect(text).toContain(MODEL_RETENTION_EXCEPTIONS);
    expect(text).toMatch(/does not use that content to train its models without/);
    expect(text).not.toMatch(/never trains/);
  });

  test(name === "public" ? "name no vendor" : "name Anthropic, as the agreements do", () => {
    if (name === "public") {
      expect(text).not.toMatch(/Anthropic|Claude/);
      expect(text).toContain("without our permission, which we do not give");
    } else {
      // The 30 days are Anthropic's standard retention, not a term of a
      // business associate agreement nobody at healdesk has read, and the
      // agreement says why the window exists (the spec's duty) without
      // claiming what Anthropic says only of its Covered Models.
      expect(text).toMatch(/^Anthropic keeps conversation content/);
      expect(text).not.toMatch(/Under that agreement/);
      expect(text).toContain(
        "Anthropic offers its service under a business associate agreement only with that standard retention, which healdesk does not control.",
      );
      expect(text).toContain("without healdesk's permission, which healdesk will not give");
    }
  });
});
