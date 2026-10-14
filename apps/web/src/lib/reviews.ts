export type Review = {
  /**
   * Stable key, and the filename of the portrait when there is one.
   *
   * Named for the city, not the specialty. The id reaches the browser in the
   * portrait's `src`, so a niche encoded here is a niche on the page.
   */
  id: string;
  /** The star rating the reviewer gave, 1 to 5. */
  rating: 1 | 2 | 3 | 4 | 5;
  /** A short headline, in the reviewer's own words. */
  headline: string;
  /** The quote itself. */
  body: string;
  /** First name and a surname initial. Never a full surname. */
  name: string;
  /**
   * Job title, if they gave one. No specialty and no business name.
   *
   * Optional because the form leaves it optional.
   */
  jobTitle?: string;
  /**
   * Home town, if they gave one.
   *
   * Also optional, and the omission is more than cosmetic: a clinic in a town
   * of four thousand is identifiable from its town and its discipline alone,
   * and some reviewers will not want that. Those cards fall back to the state.
   */
  city?: string;
  /** Two-letter state code. The one part of the location that is always there. */
  state: string;
  /**
   * The reviewer's own portrait, if they uploaded one, without the extension.
   * Never a stock or generated face.
   */
  photo?: string;
};

/**
 * The line under the name, assembled from the three optional-ish parts.
 *
 *   Owner, Scottsdale AZ    job title, town and state
 *   Columbus OH             no job title
 *   Owner, CO               no town
 *   CA                      neither
 *
 * The state is always the two-letter code, including when it stands alone.
 * Spelling it out on the town-less cards was tried and dropped: it made those
 * cards read as a different kind of thing to the ones beside them, when the
 * only difference is that somebody chose not to name their town.
 */
export function attribution(review: Review): string {
  const place = review.city ? `${review.city} ${review.state}` : review.state;
  return review.jobTitle ? `${review.jobTitle}, ${place}` : place;
}

/**
 * Reviews a real customer wrote, that someone here has read and approved.
 * Newest last. Adding one is the whole of publishing it.
 */
export const PUBLISHED: readonly Review[] = [];

/** The rungs the panel draws a bar for, best first. */
export const REVIEW_SCALE = [5, 4, 3, 2, 1] as const;

export type Stars = (typeof REVIEW_SCALE)[number];

/** Everything the review wall prints, derived from one list of reviews. */
export type ReviewSummary = {
  /** The cards, in the order the slider shows them. */
  reviews: readonly Review[];
  /** Ratings per rung, for the bars. */
  distribution: Readonly<Record<Stars, number>>;
  /** Ratings left, written or not. */
  total: number;
  /** Ratings that came with words attached. */
  written: number;
  /** Mean rating across every rating left, to one decimal place. */
  average: number;
};

/**
 * Ratings left without a card on the wall, by rung, plus how many of those
 * came with words. Real reviews have none: every one we publish is a card.
 * Only reviews.sample.ts passes one.
 */
type Archive = {
  ratings: Readonly<Record<Stars, number>>;
  written: number;
};

const EMPTY: Archive = {
  ratings: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 },
  written: 0,
};

/**
 * Derives the header's numbers from the cards, so a review added to the list
 * moves the total, its bar, the average and the written count together. Four
 * numbers kept in step by hand do not stay in step.
 */
export function summarize(
  reviews: readonly Review[],
  archive: Archive = EMPTY,
): ReviewSummary {
  const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 } as Record<
    Stars,
    number
  >;
  for (const stars of REVIEW_SCALE) {
    distribution[stars] =
      archive.ratings[stars] +
      reviews.filter((review) => review.rating === stars).length;
  }

  const total = REVIEW_SCALE.reduce(
    (sum, stars) => sum + distribution[stars],
    0,
  );
  const points = REVIEW_SCALE.reduce(
    (sum, stars) => sum + stars * distribution[stars],
    0,
  );

  return {
    reviews,
    distribution,
    total,
    written: archive.written + reviews.length,
    average: total === 0 ? 0 : Math.round((points / total) * 10) / 10,
  };
}
