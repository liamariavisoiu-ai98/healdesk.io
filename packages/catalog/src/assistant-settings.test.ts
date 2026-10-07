import { describe, expect, test } from "vitest";

import {
  ASSISTANT_LANGUAGE_NAMES,
  ASSISTANT_LANGUAGES,
  ASSISTANT_TONE_OPTIONS,
  ASSISTANT_TONES,
  BOOKING_DETAILS,
  CHANNEL_NAMES,
  COVERAGE_MODE_OPTIONS,
  COVERAGE_MODES,
  DEFAULT_ASSISTANT_TONE,
  DEFAULT_COVERAGE_MODE,
  NEVER_SAY_DEFAULTS,
  NEVER_SAY_LIMITS,
  TRANSCRIPT_RETENTION_DAYS_OPTIONS,
} from "./assistant-settings";
import { findClinicalContent } from "./clinical-content";
import { CHANNELS } from "./plans";

/**
 * The switches' choices are the database's CHECK lists in apps/app, so they
 * must be plain identifiers, and the defaults must be the spec's.
 */

const IDENTIFIER = /^[a-z0-9_]+$/;

describe("the switches' choices", () => {
  test("every id is a plain identifier, so a CHECK can be built from it", () => {
    for (const id of [
      ...ASSISTANT_TONES,
      ...COVERAGE_MODES,
      ...BOOKING_DETAILS,
      ...ASSISTANT_LANGUAGES,
    ]) {
      expect(id, id).toMatch(IDENTIFIER);
    }
  });

  test("the defaults are the spec's: Warm, Overflow and after hours, English, 90 days", () => {
    expect(DEFAULT_ASSISTANT_TONE).toBe("warm");
    expect(DEFAULT_COVERAGE_MODE).toBe("overflow_after_hours");
    expect(ASSISTANT_LANGUAGES[0]).toBe("en");
    expect(TRANSCRIPT_RETENTION_DAYS_OPTIONS[0]).toBe(90);
    expect(Math.max(...TRANSCRIPT_RETENTION_DAYS_OPTIONS)).toBe(90);
  });

  test("every choice has its label and one line, in the spec's order", () => {
    expect(ASSISTANT_TONE_OPTIONS.map((o) => o.id)).toEqual([...ASSISTANT_TONES]);
    expect(COVERAGE_MODE_OPTIONS.map((o) => o.id)).toEqual([...COVERAGE_MODES]);
    for (const option of [...ASSISTANT_TONE_OPTIONS, ...COVERAGE_MODE_OPTIONS]) {
      expect(option.label.length, option.id).toBeGreaterThan(0);
      expect(option.line.length, option.id).toBeGreaterThan(0);
    }
    for (const language of ASSISTANT_LANGUAGES) {
      expect(ASSISTANT_LANGUAGE_NAMES[language]).toBeTruthy();
    }
    for (const channel of CHANNELS) expect(CHANNEL_NAMES[channel]).toBeTruthy();
  });

  test("the channel names are the ones patients use, with no jargon", () => {
    expect(CHANNEL_NAMES).toEqual({
      web: "Website chat",
      meta: "Instagram, Messenger & WhatsApp",
      voice: "Phone",
    });
  });
});

describe("the never-say defaults", () => {
  test("are clinical on purpose, which is why nothing screens the list", () => {
    const flagged = NEVER_SAY_DEFAULTS.filter(
      (phrase) => findClinicalContent({ phrase }).length > 0,
    );
    expect(flagged.length).toBeGreaterThan(0);
  });

  test("fit the list's own limits, with no duplicates", () => {
    expect(NEVER_SAY_DEFAULTS.length).toBeLessThanOrEqual(NEVER_SAY_LIMITS.entries);
    expect(new Set(NEVER_SAY_DEFAULTS.map((p) => p.toLowerCase())).size).toBe(
      NEVER_SAY_DEFAULTS.length,
    );
    for (const phrase of NEVER_SAY_DEFAULTS) {
      expect(phrase.length).toBeLessThanOrEqual(NEVER_SAY_LIMITS.chars);
      expect(phrase).toBe(phrase.trim());
    }
  });
});
