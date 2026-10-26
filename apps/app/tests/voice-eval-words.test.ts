import { describe, expect, test } from "vitest";

import { wordsPerTurn, type ResultRow } from "../scripts/voice-eval/report";

/**
 * 6a, measured on a live run (owner, 26 October 2026): the voice eval reports
 * the mean words per reply the model wrote itself, so a change to the notes
 * can be shown to shorten what a model actually says, not only what it is told.
 */
describe("the voice eval's words per turn", () => {
  const row = (model_words: number | undefined, model_turns: number | undefined) => ({ model_words, model_turns }) as unknown as ResultRow;

  test("the mean over the model's own replies, across rows; rows from before the count are left out", () => {
    expect(wordsPerTurn([row(30, 3), row(10, 2)])).toBe(8);
    expect(wordsPerTurn([row(30, 3), row(undefined, undefined)])).toBe(10);
    expect(wordsPerTurn([row(undefined, undefined)])).toBeNaN();
    expect(wordsPerTurn([])).toBeNaN();
  });
});
