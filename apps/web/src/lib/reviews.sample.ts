import { summarize, type Review, type ReviewSummary } from "@/lib/reviews";

/**
 * The review wall as it was designed, shown labelled as examples until real
 * reviews are published.
 *
 * ⚠️ PLACEHOLDER CONTENT. Every review, name, face and number here was
 * written to design against, not collected from a customer. The portraits in
 * public/reviews are StyleGAN output from thispersondoesnotexist.com and the
 * archive counts are invented.
 *
 * The words are the owner's, chosen on 12 October 2026 from three rewrites
 * of each card or edits of the old one, several written by hand. Dr. Grant
 * M.'s and Ray K.'s are as they were. The cards that claimed tracing who showed
 * up and paid, writing into Mindbody or Boulevard, and "no login" were
 * rewritten to what v1 does (Mindbody and Boulevard clinics get booking
 * requests). Two still say what the product does not measure, by the owner's
 * choice: Andre S.'s lower cost per booked consult, and Lauren P.'s consults
 * "recovered". Nicole T.'s "patient's preferred time" and "doing it job" are
 * as the owner wrote them, on purpose: leave them.
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
    headline: "Every after-hours call, in one place",
    body:
      "We run it on overflow and after hours and already got 19 consults that used to be voicemails. The " +
      "calls we cannot pick up just get forwarded to Aya and she quotes from our price list and books the " +
      "consult in our Google Calendar. Honestly, an extremely useful purchase.",
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
      "We used to keep a callback list on the whiteboard behind the desk. Nobody has written on it since we " +
      "got healdesk.",
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
    headline: "Know this if you're on Boulevard",
    body:
      "If you're on Boulevard like us, know going in that it won't book into it. It takes the patient's " +
      "preferred time and alerts the desk, and we confirm in Boulevard ourselves. But to be honest, it " +
      "actually suited us since nobody had to learn a new booking system and instead they just stopped " +
      "drowning in voicemails. Great product overall.",
    name: "Alyssa B.",
    jobTitle: "Practice Manager",
    state: "CO",
    photo: "denver",
  },
  {
    id: "austin",
    rating: 4,
    headline: "Know your booking setup going in",
    body:
      "It doesn't book into Mindbody. It takes patient's preferred time and alerts the desk, and we confirm " +
      "in Mindbody. A star off only for the first week while my team found its rhythm with that, but since " +
      "then it's been quiet which is all I want from software. And it's doing it job more naturally than " +
      "others on the market.",
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
      "Leads that came in after 5pm used to always sit until morning. Our cost per booked consult is down " +
      "now that we got healdesk, on the same ad spend.",
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
    headline: "A vendor that signs a BAA, plainly",
    body:
      "Our attorney read the BAA before we signed anything and came back with two questions, both of which " +
      "were answered on a call the same week. They were straight about what has been audited and what has " +
      "not, which I trusted a great deal more than a compliance badge on a website.",
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
      "We paid $4000 one month for messages taken badly. This costs much less and books people instead. " +
      "Docked a star for the month where we didn't need all the minutes we bought and forgot we could " +
      "downgrade the plan.",
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
      "morning. They are with patients now instead, and frankly the mood at the front desk changed so much " +
      "and long before any of the numbers did. So happy with this provider.",
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
      "Setup was SO easy and it managed to recover two consults we would otherwise have lost by day 4. The " +
      "quality between this and other providers on the market is something else. Keep it up!",
    name: "Lauren P.",
    jobTitle: "Owner",
    state: "NY",
    photo: "newyork",
  },
  {
    id: "charlotte",
    rating: 5,
    headline: "Complications go straight to my nurse.",
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
    headline: "Brand consistency across three sites",
    body:
      "Three locations, three different phone experiences depending on who was covering. They all sound the " +
      "same now.",
    name: "Devon H.",
    state: "CA",
  },
  {
    id: "miami",
    rating: 5,
    headline: "Same team, six months in",
    body:
      "Front desk turnover is the quiet cost in this industry. I told mine this wasn't a replacement. Six " +
      "months on, nobody's left and nobody's drowning.",
    name: "Marco D.",
    jobTitle: "Owner",
    state: "FL",
    photo: "miami",
  },
  {
    id: "boise",
    rating: 5,
    headline: "It picks up every time.",
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
