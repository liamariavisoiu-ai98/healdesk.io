import { describe, expect, test } from "vitest";

import { composeKnowledge, NICHES, nichesFor, PRACTICES } from "./index";

/**
 * The tree's structural invariants.
 *
 * Content quality cannot be unit-tested — that is what reading it is for. What
 * CAN be tested is the set of mistakes that would silently degrade the agent:
 * a practice pointing at a niche that does not exist, a layer failing to reach
 * the prompt, or the boundaries dropping out of the composition.
 */

describe("the tree is wired up", () => {
  test("every practice points only at niches that exist", () => {
    // A dangling id means the visitor is offered a branch that loads no
    // knowledge — the bot silently answers as a generalist while the UI claims
    // expertise.
    for (const practice of Object.values(PRACTICES)) {
      for (const niche of practice.niches) {
        expect(NICHES[niche], `${practice.id} → ${niche}`).toBeDefined();
      }
    }
  });

  test("every niche is reachable from at least one practice", () => {
    const reachable = new Set(
      Object.values(PRACTICES).flatMap((p) => p.niches),
    );
    for (const id of Object.keys(NICHES)) {
      expect(reachable.has(id), `${id} is orphaned`).toBe(true);
    }
  });

  test("nichesFor narrows to that practice, and never offers nonsense", () => {
    const dental = nichesFor("dental").map((n) => n.id);
    expect(dental).toContain("ortho-cosmetic");
    // Offering IV therapy to a dental practice is exactly the small wrongness
    // that costs credibility.
    expect(dental).not.toContain("wellness-iv");
  });
});

describe("composition", () => {
  test("persona and boundaries survive every combination", () => {
    // The deflection rule lives in one place precisely so it cannot be dropped
    // by a branch. If any layer combination loses it, the demo can give
    // medical advice.
    for (const practice of Object.keys(PRACTICES)) {
      for (const niche of nichesFor(practice)) {
        const prompt = composeKnowledge({ practice, niche: niche.id });
        expect(prompt).toMatch(/No clinical advice/);
        expect(prompt).toMatch(/Two or three sentences/);
      }
    }
  });

  test("each layer actually reaches the prompt", () => {
    const prompt = composeKnowledge({
      specialtyContext: "Botox $12-16/unit",
      practice: "med-spa",
      niche: "injectables",
    });

    expect(prompt).toContain("Botox $12-16/unit"); // specialty
    expect(prompt).toContain("Who calls:"); // practice
    expect(prompt).toContain("Vocabulary"); // niche
    expect(prompt).toMatch(/glabella/); // genuinely niche-level detail
  });

  test("an unknown branch degrades to the layer above rather than erroring", () => {
    // A generalist answer is always safe; a wrong-niche answer is not. So a
    // bad hint must never cost the visitor their conversation.
    const prompt = composeKnowledge({ practice: "nope", niche: "also-nope" });
    expect(prompt).toMatch(/No clinical advice/);
    expect(prompt).not.toContain("Who calls:");
  });

  test("the tone rules ban the words that give a sales bot away", () => {
    const prompt = composeKnowledge({ practice: "med-spa" });
    for (const banned of ["amazing", "great question", "seamless", "leverage"]) {
      expect(prompt).toContain(banned);
    }
  });
});

describe("the content holds its own rules", () => {
  test("every niche names its scope trap concretely", () => {
    // The trap must be specific enough that the model recognises the real
    // question when it arrives, rather than matching an abstraction. Most
    // niches do that by quoting the question; fertility does it by enumerating
    // forbidden topics, because there the rule genuinely is "nothing at all"
    // rather than a list of asks. Accept either shape, reject a generic
    // restatement of the global rule.
    for (const niche of Object.values(NICHES)) {
      expect(niche.neverSay.length, niche.id).toBeGreaterThan(40);

      const quotesAQuestion = /[?"']/.test(niche.neverSay);
      const enumeratesTopics = niche.neverSay.split(",").length >= 3;
      expect(quotesAQuestion || enumeratesTopics, niche.id).toBe(true);
    }
  });

  test("every niche says why its callers defect", () => {
    // This is the field the whole product's value argument rests on. A niche
    // without it will pitch "never miss a call" generically, which is the
    // weakest available claim.
    for (const niche of Object.values(NICHES)) {
      expect(niche.defection.length, niche.id).toBeGreaterThan(60);
    }
  });

  test("every practice states how it gets paid", () => {
    // Payer mix predicts covered-entity status, which decides which BAA branch
    // the clinic signs and whether the TCPA healthcare exemption is available.
    for (const practice of Object.values(PRACTICES)) {
      expect(practice.payerMix.length, practice.id).toBeGreaterThan(30);
    }
  });
});
