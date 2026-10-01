import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import * as reviews from "@/lib/reviews";
import { attribution, type Review } from "@/lib/reviews";

/**
 * Reviews, guarded where they can go wrong.
 *
 * Until 30 September 2026 the homepage carried a wall of placeholder
 * testimonials and an invented "286 clinics, 4.9" rating. They were removed;
 * src/lib/reviews.ts says why and what a real review must not claim. Two
 * things are pinned here: that the placeholder content does not creep back,
 * and that the attribution line, which real reviews will use, says as little
 * as it can.
 */

const HOMEPAGE = fileURLToPath(new URL("../app/page.tsx", import.meta.url));

describe("no placeholder reviews ship", () => {
  test("the module carries no review content or aggregate rating", () => {
    for (const name of [
      "REVIEWS",
      "REVIEW_TOTAL",
      "REVIEWS_WRITTEN",
      "REVIEW_DISTRIBUTION",
      "averageRating",
    ]) {
      expect(name in reviews, `${name} is back in src/lib/reviews.ts`).toBe(false);
    }
  });

  test("the homepage renders no review wall", () => {
    const source = readFileSync(HOMEPAGE, "utf8");
    expect(source).not.toMatch(/<Reviews\b/);
    expect(source).not.toMatch(/\b(4\.9|286)\b/);
  });
});

describe("attribution says as little as it can get away with", () => {
  const base: Review = {
    id: "example",
    rating: 5,
    headline: "Headline",
    body: "Body",
    name: "Dana S.",
    state: "AZ",
  };

  test("the four shapes: title and town, town only, title only, state only", () => {
    expect(attribution({ ...base, jobTitle: "Owner", city: "Scottsdale" })).toBe(
      "Owner, Scottsdale AZ",
    );
    expect(attribution({ ...base, city: "Columbus", state: "OH" })).toBe("Columbus OH");
    expect(attribution({ ...base, jobTitle: "Owner", state: "CO" })).toBe("Owner, CO");
    expect(attribution({ ...base, state: "CA" })).toBe("CA");
  });

  test("the line is a job title and a place, and nothing else", () => {
    for (const review of [
      { ...base, jobTitle: "Practice Manager", city: "Denver", state: "CO" },
      { ...base, state: "IL" },
    ]) {
      expect(attribution(review)).toMatch(/^(?:[A-Za-z ]+, )?(?:[A-Za-z. ]+ )?[A-Z]{2}$/);
    }
  });
});
