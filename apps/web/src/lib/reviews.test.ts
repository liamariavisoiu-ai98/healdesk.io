import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  REVIEWS,
  attribution,
  REVIEWS_WRITTEN,
  REVIEW_DISTRIBUTION,
  REVIEW_SCALE,
  REVIEW_TOTAL,
  averageRating,
} from "@/lib/reviews";
import cities from "@/lib/us-cities.json";
import { stateName } from "@/lib/us-places";

/** The JSON import types itself as a struct of 52 named keys; this is a map. */
const CITIES = cities as Record<string, string[]>;

/**
 * The reviews slider, guarded where it can actually go wrong.
 *
 * Four separate things break here, and none of them break loudly:
 *
 *   1. The paging. The slider moves five cards at a time on a desktop, three on
 *      a tablet and one on a phone, and a review count that does not divide by
 *      all three leaves a half-empty final page at a breakpoint nobody checks.
 *      Card copy has a ceiling for a related reason: the back face is a fixed
 *      box with no scrollbar, so a long enough quote is clipped mid-sentence.
 *   2. The numbers. The headline average is derived from the distribution, and
 *      editing the distribution to make the bars look nicer quietly moves the
 *      4.9 the section was designed around.
 *   3. Attribution. No surnames, no specialty, no business names. All three
 *      came from the founder directly and all three are one careless paste away
 *      from coming back.
 *   4. The copy. No em dashes, and the reviews describe the service rather than
 *      the agent by name.
 *
 * ⚠️ None of this asserts the reviews are TRUE. They are placeholder content
 * and must be replaced before the section is public. See the note at the top of
 * src/lib/reviews.ts.
 */

/** Cards per page, by breakpoint. Mirrors PER_PAGE in Reviews.tsx. */
const PER_PAGE = [1, 3, 5];

/**
 * The back face is a fixed box with no scrollbar. See Review.body.
 *
 * This number is not a style preference, it is measured against the card. When
 * the type scale went up 20% the same 340 characters stopped fitting and four
 * cards clipped their last line, so the card grew and this stayed put. Change
 * either one and check the other in a browser, not by eye.
 */
const MAX_BODY = 340;

const PORTRAITS = fileURLToPath(new URL("../../public/reviews", import.meta.url));

/**
 * Anything that would tell a reader which kind of practice this is.
 *
 * The section is deliberately specialty-blind: a visitor who does not see their
 * own discipline in the list concludes the product is not for them, so every
 * review has to read as though it could have come from their own front desk.
 * That rule covers the quote as well as the job title, which is why the bodies
 * say "a consult" and "a procedure" where they once named one.
 */
const NICHE =
  /\b(med ?spa|aesthetic|dermatolog|plastic|cosmetic|surgeon|surgery|fertility|ivf|dental|dentist|orthodont|implant|weight loss|glp-?1|hair restoration|transplant|veterinar|vet|pet|massage|chiroprac|botox|filler|injectable)\w*/i;

describe("the slider pages evenly", () => {
  test("every breakpoint divides the reviews into whole pages", () => {
    // A remainder is a final page with two cards on it and three card-widths
    // of empty track beside them, which reads as the section having run out
    // rather than as a deliberate stop.
    for (const perPage of PER_PAGE) {
      expect(
        REVIEWS.length % perPage,
        `${REVIEWS.length} reviews leaves a short page at ${perPage} per page`,
      ).toBe(0);
    }
  });

  test("ids are unique, since they key the list and name the portraits", () => {
    const ids = REVIEWS.map((review) => review.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("no quote outgrows the back of the card", () => {
    for (const review of REVIEWS) {
      expect(review.body.length, `${review.id} would be clipped`).toBeLessThanOrEqual(
        MAX_BODY,
      );
    }
  });

  test("every headline stands on its own", () => {
    // The quote is behind a hover, so the headline is the whole pitch to a
    // scanner. The floor is low because one card is deliberately terse: see
    // the note on "tampa" in src/lib/reviews.ts. The ceiling is the 210px card.
    for (const review of REVIEWS) {
      expect(review.headline.length, review.id).toBeGreaterThanOrEqual(12);
      expect(review.headline.length, review.id).toBeLessThanOrEqual(40);
    }
  });
});

describe("the headline numbers agree with the bars under them", () => {
  test("the derived average is the 4.9 the section was designed around", () => {
    expect(averageRating()).toBe(4.9);
  });

  test("the total is the distribution and nothing else", () => {
    const summed = Object.values(REVIEW_DISTRIBUTION).reduce((a, b) => a + b, 0);
    expect(REVIEW_TOTAL).toBe(summed);
  });

  test("the scale runs all five rungs, best first", () => {
    // The three nobody has used are drawn as empty tracks rather than left
    // out: a chart that jumps from four to nothing makes a reader wonder what
    // was removed, where a visible zero answers it before it is asked.
    expect([...REVIEW_SCALE]).toEqual([5, 4, 3, 2, 1]);
    expect(Object.keys(REVIEW_DISTRIBUTION).map(Number).sort()).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  test("fewer people wrote than rated, and we show fewer still", () => {
    expect(REVIEWS_WRITTEN).toBeLessThanOrEqual(REVIEW_TOTAL);
    // The section prints "showing N of REVIEWS_WRITTEN", which reads as a lie
    // the moment N is the larger number.
    expect(REVIEWS.length).toBeLessThanOrEqual(REVIEWS_WRITTEN);
  });

  test("every rating on a card is one the distribution accounts for", () => {
    for (const review of REVIEWS) {
      expect(REVIEW_DISTRIBUTION[review.rating]).toBeGreaterThan(0);
    }
  });

  test("not every review is five stars", () => {
    // A section of nothing but five stars is the strongest signal a reader has
    // that the reviews were written in-house. Keep at least one honest one.
    expect(REVIEWS.some((review) => review.rating < 5)).toBe(true);
  });
});

describe("the portraits on disk and the reviews in the file match up", () => {
  const files = readdirSync(PORTRAITS);

  test("every review with a photo has one", () => {
    for (const review of REVIEWS.filter((r) => r.photo)) {
      expect(files, `"${review.id}" points at a portrait that is not there`).toContain(
        `${review.photo}.jpg`,
      );
    }
  });

  test("no portrait is left behind by a review that was removed", () => {
    const referenced = new Set(
      REVIEWS.filter((r) => r.photo).map((r) => `${r.photo}.jpg`),
    );
    for (const file of files) {
      expect(referenced, `${file} belongs to no review`).toContain(file);
    }
  });

  test("some reviews carry no portrait at all", () => {
    // A section where every card has a face reads as art direction rather than
    // as people, and on a real review platform most people never upload one.
    expect(REVIEWS.some((review) => !review.photo)).toBe(true);
  });
});

describe("attribution says as little as it can get away with", () => {
  test("a first name and a surname initial, never a surname", () => {
    for (const review of REVIEWS) {
      expect(review.name, review.id).toMatch(/^(Dr\. )?[A-Z][a-z]+ [A-Z]\.$/);
    }
  });

  test("the attribution line is a job title and a place, and nothing else", () => {
    // Four shapes, and all four are legal: "Owner, Scottsdale AZ",
    // "Columbus OH", "Owner, CO", "CA".
    for (const review of REVIEWS) {
      expect(attribution(review), review.id).toMatch(
        /^(?:[A-Za-z ]+, )?(?:[A-Za-z. ]+ )?[A-Z]{2}$/,
      );
    }
  });

  test("every state code is one we can spell out", () => {
    for (const review of REVIEWS) {
      expect(review.state, review.id).toMatch(/^[A-Z]{2}$/);
      // stateName falls back to the code, so an unknown one shows as "XX".
      expect(stateName(review.state), review.id).not.toBe(review.state);
    }
  });

  test("some cards omit the job title and some omit the town", () => {
    // Both omissions are deliberate: see the notes on jobTitle and city. A run
    // where every card carries all three reads as a form, not as people.
    expect(REVIEWS.some((review) => !review.jobTitle)).toBe(true);
    expect(REVIEWS.some((review) => !review.city)).toBe(true);
    expect(REVIEWS.some((review) => review.jobTitle && review.city)).toBe(true);
  });

  test("a town, where given, is a real place in that state", () => {
    // The review form picks from the Census list, so a hand-written card that
    // does not appear in it is a typo or an invented town.
    for (const review of REVIEWS) {
      if (!review.city) continue;
      expect(CITIES[review.state] ?? [], `${review.id}: ${review.city}`).toContain(
        review.city,
      );
    }
  });

  test("no specialty anywhere on a card", () => {
    // Headline, quote, role and name together: the whole of what a reader sees,
    // front and back.
    for (const review of REVIEWS) {
      for (const [field, value] of Object.entries({
        headline: review.headline,
        body: review.body,
        role: attribution(review),
        name: review.name,
      })) {
        const hit = NICHE.exec(value);
        expect(hit?.[0], `${review.id}.${field} names a specialty`).toBeUndefined();
      }
    }
  });

  test("the id carries no specialty either, because it reaches the browser", () => {
    // The id is the portrait's filename, so it ends up in an <img src>.
    for (const review of REVIEWS) {
      expect(NICHE.exec(review.id)?.[0], review.id).toBeUndefined();
    }
  });
});

describe("the copy keeps the rules it was written under", () => {
  const copy = REVIEWS.flatMap((review) => [
    { id: review.id, field: "headline", text: review.headline },
    { id: review.id, field: "body", text: review.body },
    { id: review.id, field: "role", text: attribution(review) },
  ]);

  test("no em dashes", () => {
    for (const entry of copy) {
      expect(entry.text, `${entry.id}.${entry.field}`).not.toMatch(/—/);
    }
  });

  test("reviews talk about the service, not the agent by name", () => {
    for (const entry of copy) {
      expect(entry.text, `${entry.id}.${entry.field}`).not.toMatch(/\bAVA\b/);
    }
  });

  test("the lengths actually vary", () => {
    const lengths = REVIEWS.map((review) => review.body.length);
    // A shortest-to-longest span this wide is what stops the section reading as
    // one person writing fifteen times.
    expect(Math.max(...lengths) / Math.min(...lengths)).toBeGreaterThan(3);
  });
});
