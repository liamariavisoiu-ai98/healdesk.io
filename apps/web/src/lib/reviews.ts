/**
 * Customer reviews: the shape one takes, the ones we have published, and the
 * numbers the homepage's review wall derives from them.
 *
 * ## The wall shows PUBLISHED, or the examples, labelled
 *
 * Until 30 September 2026 the homepage carried a review wall: fifteen
 * testimonials, StyleGAN portraits from thispersondoesnotexist.com, and an
 * aggregate of "286 clinics, 4.9 average". None of it was collected from a
 * customer, and v1 had not answered a real call. The wall was taken down;
 * on 3 October 2026 it came back, with the content split off into
 * reviews.sample.ts. While PUBLISHED below is empty the homepage shows that
 * sample set with a line above the rating saying the reviews are examples;
 * the first published review replaces the whole set. Every count the header
 * shows is computed from the reviews it is given, never typed.
 *
 * Publishing invented testimonials or a made-up aggregate rating is a
 * per-review civil penalty under the FTC's rule on consumer reviews and
 * testimonials (16 CFR Part 465, in force since October 2024). This site
 * already refuses to claim an audit nobody performed (see KnowMore.tsx and
 * Footer.tsx); the same standard applies here, and the exposure is larger,
 * because a testimonial names a person.
 *
 * Collection still works: LeaveReview.tsx posts to /api/reviews, which checks
 * the customer and sends the review to us to be read. Nothing it receives
 * appears anywhere until someone here adds it to PUBLISHED. Before adding one:
 *
 * - none may claim what v1 cannot do: attended or collected revenue, writes
 *   into a booking system other than Google Calendar, deposit links sent
 *   after a call, call-backs, texts, or "nothing to log into";
 * - no aggregate rating that is not counted from reviews actually received;
 * - no JSON-LD Review or AggregateRating markup until both are real, because
 *   structured data publishes the claim a second time, in search results.
 *
 * ## Three rules about attribution, all of them deliberate
 *
 * No surname. "Dana S." is what a review platform shows and what a clinic owner
 * will actually agree to.
 *
 * No specialty. The role line is a job title and a city, nothing more. Labelling
 * each card with a discipline segments the section, and a reader who does not
 * see their own specialty concludes the product is not for them.
 *
 * No business names. Being quoted in someone else's marketing is a complaint
 * waiting to happen.
 */

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
