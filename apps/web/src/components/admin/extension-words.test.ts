import { describe, expect, test } from "vitest";

import { EXTENSION_NOT_RECORDED_WORDS, extendedWords } from "./extension-words";

/**
 * The line an operator reads after extending a setup window (Billing tab and
 * the Setup window card): the new deadline, plus one plain line when the
 * decision could not be recorded on the setup watch.
 */
describe("extendedWords", () => {
  const extended = (lifecycle: "recorded" | "not_watched" | "not_recorded") =>
    ({ status: "extended", setupDeadlineAt: "2026-11-12 23:59 UTC", auditRecorded: true, lifecycle }) as const;

  test("recorded or not watched: the deadline alone", () => {
    expect(extendedWords(extended("recorded"))).toBe("Extended to 2026-11-12 23:59 UTC.");
    expect(extendedWords(extended("not_watched"))).toBe("Extended to 2026-11-12 23:59 UTC.");
  });

  test("not recorded: the deadline, then that Home may still list a decision owed", () => {
    expect(extendedWords(extended("not_recorded"))).toBe(
      "Extended to 2026-11-12 23:59 UTC. The extension is saved, but the decision could not be recorded on the setup watch; Home may still list a decision owed.",
    );
    expect(EXTENSION_NOT_RECORDED_WORDS).toContain("Home may still list a decision owed");
  });

  test("a refusal is not drawn as done", () => {
    expect(extendedWords({ status: "refused", message: "No." })).toBeNull();
  });
});
