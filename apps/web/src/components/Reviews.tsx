"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";

import { LeaveReview } from "@/components/LeaveReview";
import {
  REVIEW_SCALE,
  attribution,
  type Review,
  type ReviewSummary,
} from "@/lib/reviews";

/**
 * The reviews slider.
 *
 * It renders whatever ReviewSummary the homepage hands it and decides nothing
 * about where that came from: the homepage passes the published reviews in
 * production and the placeholder set in development. src/lib/reviews.ts has
 * the reasoning.
 *
 * ## The shape
 *
 * Five cards at a time, an arrow on each side, and a page of five sliding in
 * from the right. It started as the Framer community component `Testimonials
 * Bento` (framer.com/marketplace/components/testimonials-bento) and kept its
 * quote cards and its scroll-in stagger, but the bento grid underneath it has
 * gone: a grid shows everything at once, and this section is now paged.
 *
 * The logo marquee that ships with the original is deliberately not here. We
 * have no customer logos we are allowed to show, and a strip of them would be a
 * second fabricated claim sitting next to the first.
 *
 * ## The quote is on the card (owner, 12 October 2026)
 *
 * A card five across is about 210px wide, so for a while the front carried
 * only the rating, the headline and the person, and the quote lived on the
 * reverse, a hover or a tap away. Face up that was a tall card with an empty
 * middle, so the quote is now on the face, under the headline, and the cards
 * a page holds stretch to the tallest. The headline is still the pitch for a
 * scanner: src/lib/reviews.ts is written to that, and caps the quote's length.
 *
 * Every reviewer has a round avatar at the foot of the card: their own
 * photograph where they gave one, their initials where they did not, in the
 * same circle and ring (Portrait). On a phone, where a page is one card,
 * the row of fifteen dots is a thin bar that fills as the pages go by.
 *
 * ## Why the page count is measured rather than assumed
 *
 * `perPage` changes with the breakpoint, so the number of pages does too, and a
 * visitor sitting on page 5 of 5 who widens their window is suddenly on page 5
 * of 3 with nothing under them. Reviews clamps the page for exactly that.
 *
 * The slide distance is measured for a duller reason: a page is not one
 * viewport wide, it is one viewport plus one gap, because the gap between the
 * last card of a page and the first card of the next one sits outside both.
 * Translating by a round 100% leaves every page after the first misaligned by
 * 18px, which compounds.
 *
 * ## What is borrowed from the specialties section
 *
 * The centred eyebrow, the panel corner, and the dot
 * row, which the niche deck already uses to mean "here is where you are". The
 * "leave a review" banner takes the circle-flood interaction whole, because
 * like a niche card it is a button that opens something.
 *
 * Not taken: the deck's round bordered step buttons. They flanked the track
 * here for a while and were replaced by a pair of bare arrowheads either side
 * of the dots, the forward one nudging on a slow loop. Two bordered buttons
 * overlapping the first and last card of every page is a lot of chrome for a
 * section whose whole job is to be read.
 */

/** Gap between cards, and the extra distance a page has to travel. */
const GAP = 18;

/** Cards per page, by breakpoint. A count that divides all three pages evenly. */
const PER_PAGE = { base: 1, sm: 3, lg: 5 } as const;

/**
 * The slide.
 *
 * A spring rather than a curve, because the landing is meant to overshoot and
 * settle rather than stop dead.
 *
 * Slower than it was. At stiffness 220 the page crossed in about a third of a
 * second, which is quick enough that the eye reads it as a cut rather than as
 * travel: five cards were simply replaced by five others. At 80 it takes
 * roughly three quarters of a second, which is long enough to watch the batch
 * arrive. Damping ratio is about 0.73, so it overshoots by
 * roughly three percent and settles. That is deliberately a small number: at
 * nine percent the batch visibly bounced on arrival, which reads as playful
 * rather than expensive. What is wanted is weight, the sense that five cards
 * have mass and had to be stopped, not a spring toy.
 */
const SLIDE = { type: "spring", stiffness: 80, damping: 13, mass: 1 } as const;

/** Marketing, below the fold, runs once: the long end of the duration scale. */
const REVEAL = { duration: 0.52, ease: [0.22, 0.61, 0.36, 1] } as const;

/**
 * The cards' entrance, driven from the track rather than from each card.
 *
 * ⚠️ The observer CANNOT live on the cards, and this is the same trap the
 * distribution bars fell into. Ten of the fifteen start outside an
 * `overflow: hidden` box, and an IntersectionObserver intersects against every
 * clipping ancestor: a card parked off the side of the slider reports
 * `isIntersecting: false` however far down the page you scroll. So pages two
 * and three sat at opacity 0, and clicking the arrow slid a blank stretch of
 * track into view. They faded in a beat later, once the observer caught up,
 * which is worse than either being there or not.
 *
 * So the track does the watching, once, and the label travels down to every
 * card through Motion's context. Everything past the first page is already
 * painted by the time anybody asks to see it.
 */
const CARD = {
  rest: { opacity: 0, y: 16 },
  lit: { opacity: 1, y: 0 },
} as const;

/** Seconds added per card across a page, so it lights up left to right. */
const STAGGER = 0.06;

/**
 * The star row.
 *
 * `size` is a number and lands as an inline width and height rather than as a
 * Tailwind class the caller passes in. An svg has no intrinsic size, so a
 * caller who forgets renders a row of nothing, and a `size-*` class handed down
 * from outside collides with any default set here, two single-class selectors
 * for the same property, resolved by whatever order Tailwind happened to emit
 * them in. A number cannot be forgotten and cannot lose.
 */
const STAR = "M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z";

/** STAR's corners, for the area under it. */
const STAR_POINTS: readonly (readonly [number, number])[] = [
  [12, 17.27], [18.18, 21], [16.54, 13.97], [22, 9.24], [14.81, 8.63],
  [12, 2], [9.19, 8.63], [2, 9.24], [7.46, 13.97], [5.82, 21],
];

/** The area of the star left of x, by the shoelace over the star cut at x. */
function areaLeftOf(x: number): number {
  const cut: [number, number][] = [];
  STAR_POINTS.forEach((a, i) => {
    const b = STAR_POINTS[(i + 1) % STAR_POINTS.length]!;
    if (a[0] <= x) cut.push([a[0], a[1]]);
    if (a[0] <= x !== b[0] <= x) cut.push([x, a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1])]);
  });
  let twice = 0;
  cut.forEach((a, i) => {
    const b = cut[(i + 1) % cut.length]!;
    twice += a[0] * b[1] - b[0] * a[1];
  });
  return Math.abs(twice) / 2;
}

/**
 * Where to stop lighting a star so that `lit` of it, by area, is lit. By
 * area, not by width: a tenth of the star's width is only the tip of its
 * right point, too small to see, where a tenth of the star is the point.
 */
function litEdge(lit: number): number {
  if (lit >= 1) return 24;
  const whole = areaLeftOf(22);
  let lo = 2;
  let hi = 22;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (areaLeftOf(mid) / whole < lit) lo = mid;
    else hi = mid;
  }
  return lo;
}

function Stars({
  rating,
  size,
  className = "",
}: {
  rating: number;
  size: number;
  className?: string;
}) {
  return (
    <span
      // One label for the row. Five separate glyphs each announcing "star" is
      // noise; what a screen reader needs is the number.
      role="img"
      aria-label={`${rating} out of 5`}
      className={`flex items-center gap-[3px] ${className}`}
    >
      {[1, 2, 3, 4, 5].map((n) => {
        // How much of this star is lit: 4.9 lights the fifth to nine tenths,
        // so its right point is grey (owner, 12 October 2026). The grey is a
        // shade deeper than the page's strong hairline (0.34 of the ink, not
        // 0.25), at the owner's request the same day: beside the gold it was
        // too faint to see.
        const lit = Math.max(0, Math.min(1, rating - (n - 1)));
        const edge = litEdge(lit);
        return (
          <svg key={n} viewBox="0 0 24 24" width={size} height={size} aria-hidden className="fill-[rgb(23_42_58/0.34)]">
            <path d={STAR} />
            {lit > 0 ? (
              <svg width={edge} height={24} viewBox={`0 0 ${edge} 24`} className="fill-sun">
                <path d={STAR} />
              </svg>
            ) : null}
          </svg>
        );
      })}
    </span>
  );
}

/**
 * Initials, for the reviewers with no portrait.
 *
 * The honorific is dropped first. "Dr. Grant M." reduced to DG is the kind of
 * small wrongness that makes a page feel machine-assembled.
 */
function initials(name: string): string {
  const parts = name
    .split(/\s+/)
    .filter((part) => !/^(dr|mr|mrs|ms|prof)\.?$/i.test(part));
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

/**
 * The reviewer's face: their own photograph where they uploaded one, and
 * their initials on white where they did not (owner, 12 October 2026: it was
 * a peach tint), in the same circle and the same hairline ring, so the two
 * read as one kind of avatar. The owner asked on 12 October 2026 for one
 * avatar style and, the same day, for the faces back: initials alone lost
 * the people.
 */
function Portrait({ review, size }: { review: Review; size: number }) {
  const box = { width: size, height: size };
  return review.photo ? (
    <img
      src={`/reviews/${review.photo}.jpg`}
      alt=""
      width={size}
      height={size}
      style={box}
      loading="lazy"
      decoding="async"
      className="ring-line shrink-0 rounded-full object-cover ring-1"
    />
  ) : (
    <span
      aria-hidden
      style={box}
      className="text-ink ring-line grid shrink-0 place-items-center rounded-full bg-white text-[14.5px] font-semibold tracking-[0.02em] ring-1"
    >
      {initials(review.name)}
    </span>
  );
}

/**
 * A review, all of it on one face (owner, 12 October 2026).
 *
 * Until then the card was a flip: the headline, the stars and the reviewer
 * face up, and the quote on the back, a hover or a tap away. Face up it was a
 * tall card with an empty middle, and most visitors never turned one over.
 * Now the quote is the middle: stars, the headline, the review itself, and
 * the reviewer at the foot. The cards on a page stretch to the tallest, so a
 * row stays even (src/lib/reviews.test.ts caps how long a quote may be).
 */
function ReviewCard({ review, column }: { review: Review; column: number }) {
  const reduce = useReducedMotion() ?? false;

  return (
    <motion.div
      variants={reduce ? undefined : CARD}
      transition={{ ...REVEAL, delay: column * STAGGER }}
      className="flex w-full shrink-0 grow-0 basis-full sm:basis-[calc((100%-36px)/3)] lg:basis-[calc((100%-72px)/5)]"
    >
      <figure className="review-card flex min-h-[300px] w-full flex-col rounded-lg p-5 sm:p-6">
        <Stars rating={review.rating} size={15} />

        {/* Quoted, because the headline is the reviewer's line rather than ours. */}
        <p className="font-display mt-3 text-[20.4px] leading-[1.22] font-normal tracking-[-0.02em]">
          &ldquo;{review.headline}&rdquo;
        </p>

        <blockquote className="text-muted mt-3 text-[15.6px] leading-[1.55] font-medium lg:text-[14.8px] lg:leading-[1.5]">
          <p>{review.body}</p>
        </blockquote>

        <figcaption className="mt-auto flex items-center gap-3 pt-6">
          <Portrait review={review} size={40} />
          <span className="min-w-0">
            <span className="block text-[16.2px] leading-tight font-semibold">{review.name}</span>
            <span className="text-muted mt-0.5 block text-[14.4px] leading-snug font-medium">{attribution(review)}</span>
          </span>
        </figcaption>
      </figure>
    </motion.div>
  );
}

/**
 * The bar fill's two states, driven from RatingHeader rather than from here.
 *
 * ⚠️ The observer CANNOT live on the bar itself, and this is not a preference.
 * An IntersectionObserver measures the element's transformed box, and a fill at
 * `scaleX(0)` is zero pixels wide: it reports `isIntersecting: false` and
 * `intersectionRatio: 0` no matter where it is on the screen. So a `whileInView`
 * on an element the same prop has scaled to nothing can never fire, and the
 * bars sit permanently empty. Verified in the browser, not deduced.
 *
 * Hence variants. The parent is a real-sized box, it does the observing, and
 * the label travels down through Motion's context to every fill under it.
 */
const BAR = {
  rest: { scaleX: 0 },
  lit: { scaleX: 1 },
} as const;

function DistributionBar({
  stars,
  count,
  total,
  index,
}: {
  stars: number;
  count: number;
  total: number;
  index: number;
}) {
  const reduce = useReducedMotion() ?? false;
  const share = (count / total) * 100;
  // The floor keeps a row with a handful of ratings in it visible as a bar
  // rather than as a rounding error. A row with none stays empty: a sliver on
  // a zero would be a bar that says somebody left one star.
  const width = count === 0 ? 0 : Math.max(share, 1.6);

  return (
    <div className="flex items-center gap-3">
      <span className="text-muted flex w-7 shrink-0 items-center gap-0.5 text-[14.4px] font-bold tabular-nums">
        {stars}
        <svg
          viewBox="0 0 24 24"
          aria-hidden
          className="fill-line-strong size-[11px]"
        >
          <path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
        </svg>
      </span>

      <span className="bg-paper-2 h-2 w-[168px] overflow-hidden rounded-full sm:w-[210px]">
        {/* Grown with scaleX rather than width: the width is already correct in
            the markup, so a reader with JS off or motion reduced sees the true
            bar and nobody pays for a layout pass per frame. With `variants`
            dropped the span carries no transform at all, which is exactly what
            a reduced-motion reader should get. */}
        <motion.span
          aria-hidden
          variants={reduce ? undefined : BAR}
          transition={{
            duration: 0.7,
            delay: index * 0.07,
            ease: [0.22, 0.61, 0.36, 1],
          }}
          style={{ width: `${width}%`, transformOrigin: "left" }}
          className="bg-sun block h-full rounded-full"
        />
      </span>

      <span className="text-muted w-8 shrink-0 text-left text-[14.4px] font-medium tabular-nums">
        {count}
      </span>
    </div>
  );
}

/**
 * The rating, standing in for the section's heading.
 *
 * It replaced a headline and a subtitle, and it is not in a card: boxing it
 * would make it a panel sitting under a heading rather than being the heading.
 * The number is the h2, with the rest of the sentence supplied to screen
 * readers so the page's outline reads as a phrase and not as "4.9".
 */
function RatingHeader({ summary }: { summary: ReviewSummary }) {
  const reduce = useReducedMotion() ?? false;
  const { average } = summary;

  return (
    // The observer for every bar underneath. See the note on BAR.
    <motion.div
      initial={reduce ? false : "rest"}
      whileInView={reduce ? undefined : "lit"}
      viewport={{ once: true, margin: "-60px" }}
      /*
        Bottom-aligned, not centred.

        The two columns are different heights and each has its own natural
        baseline: the invite under the score, and the one-star row. Centred,
        they floated at different offsets, which is the kind of
        near-alignment that reads as a mistake rather than as a choice. Sat on
        a common bottom edge they read as one band.
      */
      className="flex flex-wrap items-end justify-center gap-x-16 gap-y-8 text-center sm:text-left"
    >
      <div className="w-full sm:w-auto">
        {/* Padded, and pulled back by the same amount so nothing moves. The
            figure is gradient text, painted only inside the heading's own box,
            and the tight tracking set that box's right edge inside the bowl of
            the 9, which came out shaved flat ("not full", owner, 9 October
            2026). The padding gives every glyph room inside the box. */}
        <h2 className="font-figure text-brand-gradient -mx-[0.08em] -my-[0.12em] inline-block px-[0.08em] py-[0.12em] text-[clamp(67.2px,9.6vw,100.8px)] leading-[0.86] font-semibold tracking-[-0.04em]">
          <span className="sr-only">Rated </span>
          {average.toFixed(1)}
          <span className="sr-only"> out of 5</span>
        </h2>
        <Stars
          rating={Number(average.toFixed(1))}
          size={20}
          className="mt-4 justify-center sm:justify-start"
        />
        {/* The ask, under the score, where the two counts were ("Helped 286
            clinics who have rated us…", removed by the owner on 12 October
            2026). It was a third column after the bars. */}
        <div className="mt-6">
          <LeaveReview />
        </div>
      </div>

      <div className="mx-auto space-y-2 sm:mx-0">
        {REVIEW_SCALE.map((stars, index) => (
          <DistributionBar
            key={stars}
            stars={stars}
            count={summary.distribution[stars]}
            total={summary.total}
            index={index}
          />
        ))}
      </div>
    </motion.div>
  );
}

/**
 * One arrowhead, either direction.
 *
 * Both wrap rather than greying out at the ends. A control that disappears
 * exactly when a reader reaches the edge and looks for a way on is a control
 * that is missing when it is wanted, and with three pages the wrap is a short
 * trip rather than a surprise.
 *
 * Both lean, each towards the page it would take you to, on a shared period so
 * they move together rather than alternately.
 */
function StepArrow({
  back,
  label,
  onClick,
}: {
  back?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={[
        "text-red-deep hover:text-red -my-2 grid size-11 place-items-center transition-colors",
        back ? "mr-1.5" : "ml-1.5",
      ].join(" ")}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`size-[15px] ${back ? "review-nudge--back" : "review-nudge"}`}
      >
        <path d={back ? "m15 6-6 6 6 6" : "m9 6 6 6-6 6"} />
      </svg>
    </button>
  );
}

/**
 * The line that says the wall is examples, shown whenever it renders the
 * sample set (src/lib/reviews.sample.ts). The owner chose, on 3 October 2026,
 * to show the original wall on the live site rather than nothing, and this
 * line is the condition: none of those reviews came from a customer, so the
 * section says so before its rating does. src/lib/reviews.test.ts checks the
 * homepage passes `examples` whenever it passes the sample set.
 */
export const EXAMPLE_NOTICE =
  "Example reviews: healdesk is launching, and these show the format real ones will take.";

export function Reviews({
  summary,
  examples = false,
}: {
  summary: ReviewSummary;
  /** True when `summary` is the sample set rather than published reviews. */
  examples?: boolean;
}) {
  const { reviews } = summary;
  const reduce = useReducedMotion() ?? false;

  const viewportRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  const [width, setWidth] = useState(0);
  /**
   * Starts at the desktop count, unlike the niche deck, which defaults to its
   * mobile layout for the same question.
   *
   * Nothing here contradicts the server's markup: the track renders identically
   * at every `perPage`, and this only decides how many dots to draw and when to
   * grey an arrow out. Defaulting to 5 means the common case never renders 15
   * dots and then throws away 12 of them a frame later.
   */
  const [perPage, setPerPage] = useState<number>(PER_PAGE.lg);

  useEffect(() => {
    const lg = window.matchMedia("(min-width: 1024px)");
    const sm = window.matchMedia("(min-width: 640px)");
    const sync = () =>
      setPerPage(
        lg.matches ? PER_PAGE.lg : sm.matches ? PER_PAGE.sm : PER_PAGE.base,
      );

    sync();
    lg.addEventListener("change", sync);
    sm.addEventListener("change", sync);
    return () => {
      lg.removeEventListener("change", sync);
      sm.removeEventListener("change", sync);
    };
  }, []);

  // The track is the width of the viewport box, so a resize moves every page
  // boundary. Watching the element rather than the window catches the cases a
  // resize event does not: a scrollbar appearing, a zoom, a layout shift above.
  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const pageCount = Math.ceil(reviews.length / perPage);

  // Widening the window takes pages away, so someone parked on the last one can
  // end up past the end with nothing under them. Clamped while rendering,
  // because an effect ran a commit late with the track already aimed at the
  // empty stretch past the last card. The clamped page is written back to state
  // rather than applied wherever `page` is read, so narrowing the window again
  // leaves the visitor on the page they were moved to.
  if (page > pageCount - 1) setPage(pageCount - 1);

  const step = useCallback(
    (delta: number) =>
      setPage((current) =>
        Math.min(Math.max(current + delta, 0), pageCount - 1),
      ),
    [pageCount],
  );

  return (
    <section id="reviews" className="page-section page-section--band scroll-mt-24">
      <div className="text-center">
        <div className="mb-9">
          <p className="eyebrow-tag">What clinics say</p>
        </div>
        {/* Above the rating on purpose: it has to be read before the 4.9
            is, not found after it. Body size and ink, not a muted caption. */}
        {examples && (
          <p className="border-line text-ink mx-auto -mt-2 mb-10 inline-block max-w-full rounded-sm border bg-white px-4 py-2 text-[15.6px] font-semibold">
            {EXAMPLE_NOTICE}
          </p>
        )}
      </div>

      <RatingHeader summary={summary} />

      <div
        // Well clear of the rating band above. At 18px the first row of cards
        // crowded the bars and the two blocks read as one.
        className="relative mt-16"
        role="group"
        aria-roledescription="carousel"
        aria-label="What clinics say"
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          step(event.key === "ArrowRight" ? 1 : -1);
        }}
      >
        {/*
          The window. Everything past the fifth card is clipped here.

          `-my-10 py-10` is not spacing, it is the fix for a straight grey line
          that ran under every card. The cards cast a soft shadow downwards and
          this box clips at its own edge, so the bottom of every shadow was
          being cut off square: a hard horizontal band, wider than the card
          because a shadow spreads, ending in a line where the rounded corners
          did not. Padding gives the shadow somewhere to fade out inside the
          clip; the equal negative margin means the section's layout does not
          move an inch. Vertical only, because horizontal padding would let the
          next card peek into it.

          The padding does not disturb the measurement either: ResizeObserver
          reports the content box, which excludes it.
        */}
        <div ref={viewportRef} className="-my-10 overflow-hidden py-10">
          <motion.div
            // The one observer for all fifteen cards. See CARD.
            initial={reduce ? false : "rest"}
            whileInView={reduce ? undefined : "lit"}
            viewport={{ once: true, margin: "-60px" }}
            className="flex w-full items-stretch gap-[18px]"
            // A page is one viewport PLUS one gap: the gap between the last
            // card of a page and the first of the next sits outside both, so a
            // round 100% leaves every page after the first short by 18px.
            animate={{ x: -page * (width + GAP) }}
            transition={reduce ? { duration: 0 } : SLIDE}
          >
            {reviews.map((review, index) => (
              <ReviewCard
                key={review.id}
                review={review}
                column={index % perPage}
              />
            ))}
          </motion.div>
        </div>
      </div>

      <div className="mt-8 flex items-center justify-center gap-2">
        <StepArrow
          back
          label="Previous reviews"
          onClick={() =>
            setPage((current) => (current - 1 + pageCount) % pageCount)
          }
        />

        {/* A dot a page from 640px. On a phone, a page is one card and the
            dots were fifteen of them in a row, so there it is a thin bar
            filling as you go (owner, 12 October 2026), named by where you are. */}
        <span
          role="img"
          aria-label={`Review ${page + 1} of ${pageCount}`}
          className="bg-line relative mx-2 block h-[3px] w-40 overflow-hidden rounded-full sm:hidden"
        >
          <span
            className="bg-red absolute inset-y-0 left-0 rounded-full transition-[width] duration-slow ease-out"
            style={{ width: `${((page + 1) / pageCount) * 100}%` }}
          />
        </span>

        {Array.from({ length: pageCount }, (_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setPage(i)}
            aria-label={`Reviews ${i * perPage + 1} to ${Math.min((i + 1) * perPage, reviews.length)}`}
            aria-current={i === page}
            className={[
              "hidden h-2 rounded-full transition-all duration-base sm:inline-block",
              i === page ? "bg-red w-6" : "bg-line-strong hover:bg-muted w-2",
            ].join(" ")}
          />
        ))}

        <StepArrow
          label="Next reviews"
          onClick={() => setPage((current) => (current + 1) % pageCount)}
        />
      </div>

      <p className="text-muted mt-7 text-center text-[15.6px] font-medium">
        Browse through {reviews.length} of our latest reviews.
      </p>
    </section>
  );
}
