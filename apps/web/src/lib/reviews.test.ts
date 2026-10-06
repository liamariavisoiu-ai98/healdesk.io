import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import * as reviews from "@/lib/reviews";
import {
  PUBLISHED,
  REVIEW_SCALE,
  attribution,
  summarize,
  type Review,
} from "@/lib/reviews";
import { SAMPLE, SAMPLE_REVIEWS } from "@/lib/reviews.sample";
import { EXAMPLE_NOTICE } from "@/components/Reviews";

/**
 * Reviews, guarded where they can go wrong.
 *
 * Until 30 September 2026 the homepage carried a wall of placeholder
 * testimonials and an invented "286 clinics, 4.9" rating. The wall's design
 * came back on 3 October 2026 with its content split off: the homepage shows
 * PUBLISHED, or while that is empty the placeholder set in reviews.sample.ts
 * labelled as examples. src/lib/reviews.ts says why. Pinned here: that the gate holds, that
 * no placeholder leaks into PUBLISHED, that the header's numbers are counted
 * rather than typed, and that the attribution line says as little as it can.
 */

const HOMEPAGE = fileURLToPath(new URL("../app/page.tsx", import.meta.url));
const WALL = fileURLToPath(new URL("../components/Reviews.tsx", import.meta.url));
const SRC = fileURLToPath(new URL("..", import.meta.url));
const PORTRAITS = fileURLToPath(
  new URL("../../public/reviews", import.meta.url),
);

/** Cards per page, by breakpoint. Mirrors PER_PAGE in Reviews.tsx. */
const PER_PAGE = [1, 3, 5];

/**
 * The back face is a fixed box with no scrollbar, measured against the card.
 * Change either one and check the other in a browser, not by eye.
 */
const MAX_BODY = 340;

describe("placeholder reviews only ever show as examples", () => {
  test("the homepage shows the sample set only labelled as examples", () => {
    const source = readFileSync(HOMEPAGE, "utf8");
    expect(source).toContain("const SHOWING_EXAMPLES = PUBLISHED.length === 0;");
    expect(source).toContain(
      "const REVIEWS = SHOWING_EXAMPLES ? SAMPLE : summarize(PUBLISHED);",
    );
    expect(source).toContain("<Reviews summary={REVIEWS} examples={SHOWING_EXAMPLES} />");
    expect(source).not.toMatch(/\b(4\.9|286)\b/);
  });

  test("the wall prints the examples notice above the rating", () => {
    const source = readFileSync(WALL, "utf8");
    expect(EXAMPLE_NOTICE).toMatch(/^Example reviews:/);
    const notice = source.indexOf("{EXAMPLE_NOTICE}");
    expect(notice, "Reviews.tsx no longer renders the notice").toBeGreaterThan(-1);
    expect(source.slice(notice - 400, notice)).toContain("{examples && (");
    expect(notice).toBeLessThan(source.indexOf("<RatingHeader summary={summary} />"));
  });

  test("nothing else imports the sample set", () => {
    const importers = (readdirSync(SRC, { recursive: true }) as string[])
      .filter((file) => /\.tsx?$/.test(file))
      .filter((file) => !/\.test\.tsx?$/.test(file))
      .filter((file) =>
        readFileSync(`${SRC}/${file}`, "utf8").includes("@/lib/reviews.sample"),
      );
    expect(importers).toEqual(["app/page.tsx"]);
  });

  test("no placeholder review is in PUBLISHED", () => {
    const sample = new Set(
      SAMPLE_REVIEWS.flatMap((r) => [r.id, r.headline, r.body]),
    );
    for (const review of PUBLISHED) {
      for (const value of [review.id, review.headline, review.body]) {
        expect(sample.has(value), `${review.id} is a placeholder`).toBe(false);
      }
    }
  });

  test("the module carries no hand-typed aggregate", () => {
    for (const name of [
      "REVIEWS",
      "REVIEW_TOTAL",
      "REVIEWS_WRITTEN",
      "REVIEW_DISTRIBUTION",
    ]) {
      expect(name in reviews, `${name} is back in src/lib/reviews.ts`).toBe(
        false,
      );
    }
  });

  test("published portraits are the reviewer's own, never a sample face", () => {
    const faces = new Set(SAMPLE_REVIEWS.map((r) => r.photo).filter(Boolean));
    for (const review of PUBLISHED) {
      expect(faces.has(review.photo), review.id).toBe(false);
    }
  });
});

describe("the header's numbers are counted from the cards", () => {
  test("no reviews is zero of everything", () => {
    const empty = summarize([]);
    expect(empty).toMatchObject({ total: 0, written: 0, average: 0 });
    expect(Object.values(empty.distribution)).toEqual([0, 0, 0, 0, 0]);
  });

  test("published reviews carry no archive: every rating is a card", () => {
    const summary = summarize(PUBLISHED);
    expect(summary.total).toBe(PUBLISHED.length);
    expect(summary.written).toBe(PUBLISHED.length);
  });

  test("the average follows the distribution", () => {
    const at = (rating: Review["rating"], id: string): Review => ({
      id,
      rating,
      headline: "Headline",
      body: "Body",
      name: "Dana S.",
      state: "AZ",
    });
    const summary = summarize([at(5, "a"), at(4, "b"), at(4, "c")]);
    expect(summary.distribution).toEqual({ 5: 1, 4: 2, 3: 0, 2: 0, 1: 0 });
    expect(summary.average).toBe(4.3);
  });

  test("the scale runs all five rungs, best first", () => {
    expect([...REVIEW_SCALE]).toEqual([5, 4, 3, 2, 1]);
  });

  test("the sample wall still reads the way it was designed", () => {
    expect(SAMPLE.average).toBe(4.9);
    expect(SAMPLE.total).toBe(286);
    for (const perPage of PER_PAGE) {
      expect(SAMPLE.reviews.length % perPage, `short page at ${perPage}`).toBe(
        0,
      );
    }
  });
});

describe("every card fits and has its portrait", () => {
  const all = [...SAMPLE_REVIEWS, ...PUBLISHED];
  const files = readdirSync(PORTRAITS);

  test("ids are unique, since they key the list and name the portraits", () => {
    const ids = all.map((review) => review.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("no quote outgrows the back of the card", () => {
    for (const review of all) {
      expect(
        review.body.length,
        `${review.id} would be clipped`,
      ).toBeLessThanOrEqual(MAX_BODY);
    }
  });

  test("every headline fits the front of the card", () => {
    for (const review of all) {
      expect(review.headline.length, review.id).toBeLessThanOrEqual(40);
    }
  });

  test("every review with a photo has one on disk", () => {
    for (const review of all.filter((r) => r.photo)) {
      expect(files, `"${review.id}" points at a missing portrait`).toContain(
        `${review.photo}.jpg`,
      );
    }
  });

  test("no em dashes", () => {
    for (const review of all) {
      expect(`${review.headline} ${review.body}`, review.id).not.toMatch(/—/);
    }
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
    expect(
      attribution({ ...base, jobTitle: "Owner", city: "Scottsdale" }),
    ).toBe("Owner, Scottsdale AZ");
    expect(attribution({ ...base, city: "Columbus", state: "OH" })).toBe(
      "Columbus OH",
    );
    expect(attribution({ ...base, jobTitle: "Owner", state: "CO" })).toBe(
      "Owner, CO",
    );
    expect(attribution({ ...base, state: "CA" })).toBe("CA");
  });

  test("the line is a job title and a place, and nothing else", () => {
    for (const review of [
      { ...base, jobTitle: "Practice Manager", city: "Denver", state: "CO" },
      { ...base, state: "IL" },
    ]) {
      expect(attribution(review)).toMatch(
        /^(?:[A-Za-z ]+, )?(?:[A-Za-z. ]+ )?[A-Z]{2}$/,
      );
    }
  });
});
