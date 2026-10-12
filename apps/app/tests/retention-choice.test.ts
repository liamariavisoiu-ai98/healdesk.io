import { describe, expect, test } from "vitest";

import { retentionShortenedLine } from "@/lib/portal/settings";
import { recordsOptions } from "@/lib/portal/settings-view";
import { retentionChoice } from "@/lib/portal/retention-choice";

/**
 * The Records card asks before shortening, and decides whether a pick
 * shortens when it is picked, against what is saved then (the branch
 * review's R9). Computed at render instead, a clinic that loaded the page at
 * 30 days, lengthened to 90 and picked 30 again saw 30 selected with no
 * dialog, and nothing saved.
 */
describe("the Records card's choice", () => {
  const options = recordsOptions();

  test("every choice that can shorten carries its sentence, whatever is saved when the page loads", () => {
    expect(options.map((option) => [option.id, option.confirm])).toEqual([
      ["90", null],
      ["30", retentionShortenedLine(30)],
      ["7", retentionShortenedLine(7)],
    ]);
  });

  test("loaded at 30, lengthened to 90, then 30 again: it asks before saving", () => {
    expect(retentionChoice("30", "90", options)).toEqual({ kind: "save" });
    expect(retentionChoice("90", "30", options)).toEqual({
      kind: "confirm",
      sentence: retentionShortenedLine(30),
    });
  });

  test("the saved value again does nothing; a longer one saves at once", () => {
    expect(retentionChoice("30", "30", options)).toEqual({ kind: "none" });
    expect(retentionChoice("7", "30", options)).toEqual({ kind: "save" });
    expect(retentionChoice("30", "7", options)).toEqual({
      kind: "confirm",
      sentence: retentionShortenedLine(7),
    });
  });

  test("a shorter choice with no sentence still asks rather than saving unseen", () => {
    expect(retentionChoice("90", "30", [{ id: "30", confirm: null }])).toMatchObject({
      kind: "confirm",
    });
  });
});
