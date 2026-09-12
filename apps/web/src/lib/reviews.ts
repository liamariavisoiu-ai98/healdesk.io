/**
 * The reviews slider on the homepage.
 *
 * ⚠️ PLACEHOLDER CONTENT. Every review, name, face and number in this file was
 * written to design against, not collected from a customer. None of these
 * people exist: the portraits in public/reviews are StyleGAN output from
 * thispersondoesnotexist.com, and the counts in REVIEW_DISTRIBUTION are
 * invented.
 *
 * They must be replaced with real, attributable reviews before this section is
 * shown to the public. Publishing invented testimonials as though they were
 * genuine is a per-review civil penalty under the FTC's rule on consumer
 * reviews and testimonials (16 CFR Part 465, in force since October 2024), and
 * the same rule covers a made-up aggregate rating. This site already refuses to
 * claim an audit nobody performed (see KnowMore.tsx and Footer.tsx); the same
 * standard applies here, and the exposure is larger, because a testimonial
 * names a person.
 *
 * There is no JSON-LD Review or AggregateRating markup on this section, and
 * that omission is deliberate rather than an oversight. Structured data feeds a
 * star rating into search results, which turns a placeholder into a published
 * claim in a second place we do not control and cannot easily retract. Add it
 * when the reviews behind it are real.
 *
 * ## What the copy is doing
 *
 * Each entry answers an objection a clinic owner actually raises on a sales
 * call: can I trace the money, will my patients hate it, is this another system
 * to learn, will it break my booking software, will it say something clinical,
 * what does my attorney think, what does it displace, will my staff think they
 * are being replaced, and can I get out of it.
 *
 * The headline carries the objection and the body carries the proof, and that
 * split is load-bearing now rather than decorative: the card shows the headline
 * face up and keeps the body until someone hovers it. A headline that does not
 * survive on its own is a card nobody turns over.
 *
 * Two reviews are four stars and both carry a real complaint. That is the point
 * of them. A wall of nothing but five-star praise is the strongest signal a
 * reader has that the reviews were bought or written in-house.
 *
 * ## Lengths are assigned, not accidental
 *
 * The quotes run from four words to four sentences, and which reviewer gets
 * which is an editorial decision rather than however the drafting went. Eight
 * of the fifteen answer in a line or two; the other seven explain themselves at
 * length. Short does not mean vague: every one of the brief cards still names
 * the thing that changed, because a short review with no detail in it is not
 * terse, it is empty, and it reads as filler. Read down a page and the rhythm is uneven the way a real review
 * feed is uneven, which is most of what stops fifteen cards reading as one
 * author. The split follows the reviewers' first names, on the founder's
 * instruction; the effect that matters is the unevenness, so if the personas
 * change, keep the spread rather than the mapping.
 *
 * ## Three rules about attribution, all of them deliberate
 *
 * No surname. "Dana S." is what a review platform shows and what a clinic owner
 * will actually agree to, and a full invented name is the part of a fabricated
 * testimonial most likely to land on a real person.
 *
 * No specialty. The role line is a job title and a city, nothing more. Labelling
 * each card with a discipline segments the wall, and a reader who does not see
 * their own specialty in the list concludes the product is not for them. Every
 * review here has to read as though it could have come from the visitor's own
 * practice, which is also why the bodies talk about consults, rooms and
 * callbacks rather than about procedures.
 *
 * No business names. A fictional clinic name is very likely to collide with a
 * real practice somewhere in the US, and being quoted in someone else's
 * marketing is a complaint waiting to happen.
 */

export type Review = {
  /**
   * Stable key, and the filename of the portrait when there is one.
   *
   * Named for the city, not the specialty. The id reaches the browser in the
   * portrait's `src`, so a niche encoded here is a niche on the page.
   */
  id: string;
  /** 4 or 5. Narrower than a star scale on purpose: see REVIEW_DISTRIBUTION. */
  rating: 4 | 5;
  /**
   * The line the card shows face up, and the only line a scanner reads.
   *
   * It has to state the objection or the outcome on its own, because the body
   * behind it is only reached by hovering.
   */
  headline: string;
  /**
   * The quote, on the back of the card.
   *
   * Length is capped by the card, not by taste: the back face is a fixed box
   * with no scrollbar, so a long enough review would be clipped mid-sentence.
   * src/lib/reviews.test.ts holds the ceiling.
   */
  body: string;
  /** First name and a surname initial. Never a full surname. */
  name: string;
  /**
   * Job title, if they gave one. No specialty and no business name.
   *
   * Optional because the form leaves it optional, and because a wall where
   * every single card carries a title reads as a form somebody filled in
   * rather than as fifteen people who happened to answer.
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
   * Portrait in public/reviews, without the extension.
   *
   * Deliberately absent on seven of the fifteen. A wall where every card carries
   * a face looks art-directed, which is the opposite of what it is trying to
   * say, and on a real review platform most people never upload one. The seven
   * without fall back to a monogram.
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

export const REVIEWS: readonly Review[] = [
  {
    id: "scottsdale",
    rating: 5,
    headline: "I can finally trace the money",
    body:
      "We were losing consults every evening and I could not prove it until I saw the callback log. In the " +
      "first month healdesk picked up 63 calls after we closed, and 19 of them turned into booked consults. " +
      "What sold me was opening the report and seeing which of those people actually showed up and paid.",
    name: "Dana S.",
    jobTitle: "Owner",
    city: "Scottsdale",
    state: "AZ",
    photo: "scottsdale",
  },
  {
    id: "columbus",
    rating: 5,
    headline: "Our callback board is blank now",
    body:
      "We kept a callback list on the whiteboard behind the desk. Nobody has written on it since we got " +
      "healdesk.",
    name: "Marcus E.",
    city: "Columbus",
    state: "OH",
  },
  {
    id: "tampa",
    rating: 5,
    /*
     * The short one, and it is on the wall on purpose.
     *
     * Fifteen considered paragraphs is what a page of written testimonials
     * looks like and not what a review page looks like. Most people who bother
     * at all bother for six seconds, and a reader who has ever left a review
     * knows it. One card that says almost nothing does more for the
     * believability of the other fourteen than a fifteenth good argument would.
     *
     * It is also the reason /api/reviews has no minimum length: refusing this
     * on the way in and then displaying it would be the site asking for
     * something it does not accept.
     */
    headline: "Just excellent!",
    body: "Outstanding service.",
    name: "Dr. Grant M.",
    jobTitle: "Owner",
    city: "Tampa",
    state: "FL",
    photo: "tampa",
  },
  {
    id: "denver",
    rating: 5,
    headline: "Nothing changed on our end",
    body:
      "There is no login, no app for the team and no extra tab open on the front desk computer. Appointments " +
      "appear in Boulevard the way they always have, and a summary lands in my inbox on Monday morning.",
    name: "Alyssa B.",
    jobTitle: "Practice Manager",
    state: "CO",
    photo: "denver",
  },
  {
    id: "austin",
    rating: 4,
    headline: "It writes into Mindbody cleanly",
    body:
      "Deposit link included, and I have not had to fix a duplicate booking yet. The first week it was too " +
      "quick to offer a slot before checking which room was free, and that took a conversation to sort out. " +
      "Since then it has been quiet, which is all I want from software.",
    name: "Nicole T.",
    jobTitle: "Owner",
    city: "Austin",
    state: "TX",
  },
  {
    id: "phoenix",
    rating: 5,
    headline: "Our ad leads stopped going cold",
    body:
      "Leads that came in after five used to sit until morning. Our cost per booked consult is down, on the " +
      "same ad spend.",
    name: "Andre S.",
    jobTitle: "Owner",
    city: "Phoenix",
    state: "AZ",
    photo: "phoenix",
  },
  {
    id: "chicago",
    rating: 5,
    headline: "Booked at four in the morning",
    body:
      "Someone booked a consult at 4am on a Tuesday. That one is worth more than the month costs us.",
    name: "Ray K.",
    jobTitle: "Clinic Director",
    state: "IL",
  },
  {
    id: "seattle",
    rating: 5,
    headline: "Our attorney had two questions",
    body:
      "He read the BAA before we signed anything and came back with two questions, both of which were " +
      "answered on a call the same week. They were straight about what has been audited and what has not, " +
      "which I trusted a great deal more than a compliance badge on a website.",
    name: "Meredith V.",
    jobTitle: "Practice Administrator",
    city: "Seattle",
    state: "WA",
    photo: "seattle",
  },
  {
    id: "portland",
    rating: 4,
    headline: "Better than the answering service",
    body:
      "We paid four hundred a month for messages taken badly. This costs less and books people instead.",
    name: "Tom W.",
    city: "Portland",
    state: "OR",
  },
  {
    id: "nashville",
    rating: 5,
    headline: "My coordinators got their day back",
    body:
      "My two coordinators used to spend the morning on the phone and the afternoon apologising for the " +
      "morning. They are with patients now instead, and the mood at the front desk changed a long time " +
      "before any of the numbers did.",
    name: "Simone A.",
    jobTitle: "Practice Manager",
    city: "Nashville",
    state: "TN",
    photo: "nashville",
  },
  {
    id: "newyork",
    rating: 5,
    headline: "I signed up planning to cancel",
    body:
      "Setup took one call and part of an afternoon, there was no setup fee, and by day four it had recovered " +
      "two consults we would otherwise have lost. I stopped looking for a reason to back out.",
    name: "Lauren P.",
    jobTitle: "Owner",
    state: "NY",
    photo: "newyork",
  },
  {
    id: "charlotte",
    rating: 5,
    headline: "It knew where the line was",
    body:
      "A caller rang in worried about swelling after a procedure and it did not try to answer her. It flagged " +
      "the call, and my nurse rang her back within the hour. That is the behaviour I would want from a new " +
      "hire on their first day.",
    name: "Dr. Priya R.",
    jobTitle: "Medical Director",
    city: "Charlotte",
    state: "NC",
  },
  {
    id: "sacramento",
    rating: 5,
    headline: "Three sites, one voice",
    body:
      "Three locations, three different phone experiences depending on who was covering. They all sound the " +
      "same now.",
    name: "Devon H.",
    state: "CA",
  },
  {
    id: "miami",
    rating: 5,
    headline: "My team was not replaced",
    body:
      "I told my staff this was not step one of letting them go. Six months on, same team.",
    name: "Marco D.",
    jobTitle: "Owner",
    state: "FL",
    photo: "miami",
  },
  {
    id: "boise",
    rating: 5,
    headline: "It answers on the second ring",
    body: "Every time. That was never true when it was us.",
    name: "Neil P.",
    jobTitle: "Owner",
    city: "Boise",
    state: "ID",
  },
];

/** The rungs the panel draws a bar for, best first. */
export const REVIEW_SCALE = [5, 4, 3, 2, 1] as const;

export type Stars = (typeof REVIEW_SCALE)[number];

/**
 * Everyone who rated us but whose words are not on this page.
 *
 * ⚠️ This is the ONLY hand-typed count left, and it is deliberately the one
 * that describes the past rather than the present. Everything the header shows
 * is computed from it plus REVIEWS, so publishing a review is a single edit:
 * add the entry, and the rating total, the bar it belongs in, the average and
 * the "have shared their experience" number all move together.
 *
 * The alternative, which this replaced, was four numbers to keep in step by
 * hand. They do not stay in step. A wall claiming 286 ratings averaging 4.9
 * while sixteen five-star reviews sit under it is the kind of arithmetic a
 * prospect checks, and the only kind of error on this page that costs a sale.
 *
 * `written` counts people who left words, `ratings` counts everyone.
 */
const ARCHIVE = {
  ratings: { 5: 244, 4: 27, 3: 0, 2: 0, 1: 0 } as Record<Stars, number>,
  written: 56,
};

/**
 * The bars, archive plus everything on the page.
 *
 * Derived rather than declared, so a review added above cannot leave the chart
 * underneath it describing a different set of customers.
 */
export const REVIEW_DISTRIBUTION: Readonly<Record<Stars, number>> =
  REVIEW_SCALE.reduce(
    (acc, stars) => {
      acc[stars] =
        ARCHIVE.ratings[stars] +
        REVIEWS.filter((review) => review.rating === stars).length;
      return acc;
    },
    { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 } as Record<Stars, number>,
  );

/** Ratings left, written or not. */
export const REVIEW_TOTAL = REVIEW_SCALE.reduce(
  (sum, stars) => sum + REVIEW_DISTRIBUTION[stars],
  0,
);

/** Ratings that came with words attached. */
export const REVIEWS_WRITTEN = ARCHIVE.written + REVIEWS.length;

/** Mean rating across every rating left, to one decimal place. */
export function averageRating(): number {
  const sum = REVIEW_SCALE.reduce(
    (acc, stars) => acc + stars * REVIEW_DISTRIBUTION[stars],
    0,
  );
  return Math.round((sum / REVIEW_TOTAL) * 10) / 10;
}
