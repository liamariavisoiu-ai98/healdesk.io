import { describe, expect, test } from "vitest";

import { knowledgeSections, knowledgeTiles } from "@/lib/portal/knowledge-glance";

/**
 * The top of Knowledge (portal redesign, fifth slice, owner, 1 November
 * 2026): treatments and their prices, quick answers and hours, at a glance.
 */

const WEEKDAYS = {
  sun: [],
  mon: [["09:00", "17:00"]],
  tue: [["09:00", "17:00"]],
  wed: [["09:00", "17:00"]],
  thu: [["09:00", "17:00"]],
  fri: [["09:00", "17:00"]],
  sat: [],
};

describe("knowledgeTiles", () => {
  test("a practice with everything priced, two answers and weekday hours", () => {
    expect(
      knowledgeTiles({ services: [{ price: 299 }, { price: 199 }], quickAnswers: 2, hours: WEEKDAYS }),
    ).toEqual([
      { key: "prices", label: "Treatments", value: "2", hint: "Every one has a price.", needsYou: false },
      {
        key: "quick-answers",
        label: "Quick answers",
        value: "2",
        hint: "Things AYA answers in your words.",
        needsYou: false,
      },
      { key: "hours", label: "Hours", value: "5 days a week", hint: "Closed days are set below too.", needsYou: false },
    ]);
  });

  test("unpriced treatments are named as becoming a consultation offer, and nudge", () => {
    const [prices] = knowledgeTiles({
      services: [{ price: 299 }, { price: null }, { price: null }],
      quickAnswers: 0,
      hours: WEEKDAYS,
    });
    expect(prices).toMatchObject({
      value: "3",
      hint: "2 have no price, so AYA offers a consultation instead.",
      needsYou: true,
    });
    expect(
      knowledgeTiles({ services: [{ price: null }], quickAnswers: 0, hours: WEEKDAYS })[0]!.hint,
    ).toBe("1 has no price, so AYA offers a consultation instead.");
  });

  test("a new practice: nothing yet, each says what to add", () => {
    const tiles = knowledgeTiles({ services: [], quickAnswers: 0, hours: null });
    expect(tiles.map((t) => [t.value, t.needsYou])).toEqual([
      ["None yet", true],
      ["0", false],
      ["Not set", true],
    ]);
    expect(tiles[0]!.hint).toBe("Add your treatments and prices so AYA can quote them.");
    expect(tiles[2]!.hint).toBe("Add your hours so AYA knows when you're open.");
  });

  test("hours with every day closed read as not set", () => {
    const closed = Object.fromEntries(Object.keys(WEEKDAYS).map((d) => [d, []]));
    expect(knowledgeTiles({ services: [], quickAnswers: 0, hours: closed })[2]!.value).toBe("Not set");
  });

  test("each tile's key is the id of the section it links to", () => {
    const ids = knowledgeSections(false).map((s) => s.id);
    for (const tile of knowledgeTiles({ services: [], quickAnswers: 0, hours: null })) {
      expect(ids).toContain(tile.key);
    }
  });
});

describe("knowledgeSections", () => {
  test("the page's sections in order; website changes first, only when there are some", () => {
    expect(knowledgeSections(false).map((s) => s.id)).toEqual([
      "file",
      "practice",
      "policies",
      "prices",
      "promotions",
      "quick-answers",
      "never-say",
      "hours",
    ]);
    expect(knowledgeSections(true)[0]).toEqual({ id: "website", label: "Website changes" });
  });
});
