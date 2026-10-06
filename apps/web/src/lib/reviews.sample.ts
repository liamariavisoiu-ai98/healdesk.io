import { summarize, type Review, type ReviewSummary } from "@/lib/reviews";

/**
 * The review wall as it was designed, shown labelled as examples until real
 * reviews are published.
 *
 * ⚠️ PLACEHOLDER CONTENT. Every review, name, face and number here was
 * written to design against, not collected from a customer. The portraits in
 * public/reviews are StyleGAN output from thispersondoesnotexist.com and the
 * archive counts are invented. Several cards also claim things v1 does not do
 * (tracing who showed up and paid, writing into Mindbody or Boulevard, "no
 * login").
 *
 * The owner chose on 3 October 2026 to show this set on the live site while
 * PUBLISHED is empty, on one condition: the wall renders it with `examples`
 * set, which prints EXAMPLE_NOTICE ("Example reviews: ...") above the rating.
 * Shown without that line it would be invented testimonials and an invented
 * aggregate presented as real, which is a per-review civil penalty under 16
 * CFR Part 465. src/lib/reviews.test.ts pins the condition.
 *
 * Nothing here may be copied into PUBLISHED, and the test checks that too.
 */

export const SAMPLE_REVIEWS: readonly Review[] = [
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
    body: "Someone booked a consult at 4am on a Tuesday. That one is worth more than the month costs us.",
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
    body: "We paid four hundred a month for messages taken badly. This costs less and books people instead.",
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
      "Setup took one call and part of an afternoon, and by day four it had recovered " +
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
    body: "I told my staff this was not step one of letting them go. Six months on, same team.",
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

/**
 * Everyone who "rated" but whose words are not on the wall. Invented, like the
 * rest of this file; it is what made the header read 4.9 across 286.
 */
const SAMPLE_ARCHIVE = {
  ratings: { 5: 244, 4: 27, 3: 0, 2: 0, 1: 0 },
  written: 56,
} as const;

export const SAMPLE: ReviewSummary = summarize(SAMPLE_REVIEWS, SAMPLE_ARCHIVE);
