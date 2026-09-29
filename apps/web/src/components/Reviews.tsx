"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";

import { LeaveReview } from "@/components/LeaveReview";
import {
  REVIEWS,
  REVIEWS_WRITTEN,
  REVIEW_DISTRIBUTION,
  REVIEW_SCALE,
  REVIEW_TOTAL,
  attribution,
  averageRating,
  type Review,
} from "@/lib/reviews";

/**
 * The reviews slider.
 *
 * ⚠️ The content is placeholder and must not go live as written. The reasoning,
 * and what has to happen before it does, is at the top of src/lib/reviews.ts.
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
 * ## Why the body is on the back of the card
 *
 * A card five across is about 210px wide, which is a portrait, not a paragraph.
 * So the front carries the rating, the headline and the person, and the quote
 * lives on the reverse. The consequence is that the HEADLINE is now the whole
 * pitch for a scanner: a card whose headline does not stand on its own is a
 * card nobody turns over. src/lib/reviews.ts is written to that constraint.
 *
 * The flip itself is in globals.css, along with the three things about it that
 * are not stylistic.
 *
 * ## Why the page count is measured rather than assumed
 *
 * `perPage` changes with the breakpoint, so the number of pages does too, and a
 * visitor sitting on page 3 of 3 who narrows their window is suddenly on page 3
 * of 5 with nothing under them. The effect below clamps for exactly that.
 *
 * The slide distance is measured for a duller reason: a page is not one
 * viewport wide, it is one viewport plus one gap, because the gap between the
 * last card of a page and the first card of the next one sits outside both.
 * Translating by a round 100% leaves every page after the first misaligned by
 * 18px, which compounds.
 *
 * ## What is borrowed from the specialties section
 *
 * The centred eyebrow over its gradient hairline, the 24px corner, and the dot
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

/** Cards per page, by breakpoint. Every one of these must divide REVIEWS. */
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
      {[1, 2, 3, 4, 5].map((n) => (
        <svg
          key={n}
          viewBox="0 0 24 24"
          width={size}
          height={size}
          aria-hidden
          className={n <= rating ? "fill-sun" : "fill-line-strong"}
        >
          <path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
        </svg>
      ))}
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

function Portrait({ review, size }: { review: Review; size: number }) {
  const box = { width: size, height: size };

  return review.photo ? (
    <img
      src={`/reviews/${review.photo}.jpg`}
      alt=""
      style={box}
      loading="lazy"
      decoding="async"
      className="ring-line shrink-0 rounded-full object-cover ring-1"
    />
  ) : (
    <span
      aria-hidden
      style={box}
      className="bg-paper-2 text-muted ring-line grid shrink-0 place-items-center rounded-full text-[15px] font-bold ring-1"
    >
      {initials(review.name)}
    </span>
  );
}

function ReviewCard({ review, column }: { review: Review; column: number }) {
  const reduce = useReducedMotion() ?? false;
  /** Touch only. A pointer uses :hover and never sets this. */
  const [flipped, setFlipped] = useState(false);

  return (
    <motion.div
      variants={reduce ? undefined : CARD}
      transition={{ ...REVEAL, delay: column * STAGGER }}
      className="w-full basis-full sm:basis-[calc((100%-36px)/3)] lg:basis-[calc((100%-72px)/5)] shrink-0 grow-0"
    >
      {/*
        A button, not a div, and the reason is the flip. On a pointer the quote
        is a hover away; on a phone there is no hover at all, so without
        something to press the back of the card is unreachable and a third of
        the section's copy is invisible to half its visitors. Tab and Enter get
        there the same way.
      */}
      <button
        type="button"
        aria-expanded={flipped}
        onClick={() => setFlipped((on) => !on)}
        data-flipped={flipped}
        className="review-flip block h-[340px] w-full cursor-pointer text-left sm:h-[350px] lg:h-[424px]"
      >
        <span className="review-flip__inner block">
          <span className="review-flip__face flex flex-col rounded-[24px] p-5 sm:p-6">
            {/*
              Title first, rating immediately under it, and the spare height
              falls between that pair and the person at the bottom. Quoted,
              because the headline is the reviewer's line rather than ours, and
              the marks are the only thing on the front saying so.
            */}
            <span className="font-display block text-[20.4px] leading-[1.22] font-medium tracking-[-0.02em]">
              &ldquo;{review.headline}&rdquo;
            </span>

            <Stars rating={review.rating} size={15} className="mt-3" />

            <span className="mt-auto flex items-center gap-3 pt-6">
              <Portrait review={review} size={40} />
              <span className="min-w-0">
                <span className="block text-[16.2px] leading-tight font-bold">
                  {review.name}
                </span>
                <span className="text-muted mt-0.5 block text-[14.4px] leading-snug font-medium">
                  {attribution(review)}
                </span>
              </span>
            </span>
          </span>

          {/*
            The back is the quote and nothing else.

            It carried a portrait and a name until the browser was asked how
            tall it actually was: nine of the fifteen were clipping their last
            line or two behind a face the front of the card had already shown.
            Repeating the attribution cost about 80px of a 288px box to say
            something the reader had just read, so it went, and every quote
            fits. src/lib/reviews.test.ts caps the length that made it tight.
          */}
          <span className="review-flip__face review-flip__face--back bg-ink flex flex-col justify-center rounded-[24px] p-5 text-white sm:p-6">
            <span
              aria-hidden
              className="text-orange font-display mb-1 block text-[36px] leading-[0.5]"
            >
              &ldquo;
            </span>

            <span className="block text-[15px] leading-[1.5] font-medium text-white/90 sm:text-[15.6px]">
              {review.body}
            </span>
          </span>
        </span>
      </button>
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
  index,
}: {
  stars: number;
  count: number;
  index: number;
}) {
  const reduce = useReducedMotion() ?? false;
  const share = (count / REVIEW_TOTAL) * 100;
  // The floor keeps a row with a handful of ratings in it visible as a bar
  // rather than as a rounding error. A row with none stays empty: a sliver on
  // a zero would be a bar that says somebody left one star.
  const width = count === 0 ? 0 : Math.max(share, 1.6);

  return (
    <div className="flex items-center gap-3">
      <span className="text-muted flex w-7 shrink-0 items-center gap-0.5 text-[14.4px] font-bold tabular-nums">
        {stars}
        <svg viewBox="0 0 24 24" aria-hidden className="fill-line-strong size-[11px]">
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
          transition={{ duration: 0.7, delay: index * 0.07, ease: [0.22, 0.61, 0.36, 1] }}
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
function RatingHeader() {
  const reduce = useReducedMotion() ?? false;
  const average = averageRating();

  return (
    // The observer for every bar underneath. See the note on BAR.
    <motion.div
      initial={reduce ? false : "rest"}
      whileInView={reduce ? undefined : "lit"}
      viewport={{ once: true, margin: "-60px" }}
      /*
        Bottom-aligned, not centred.

        The three columns are different heights and each has its own natural
        baseline: the caption's last line, the one-star row, and the invite.
        Centred, all three floated at different offsets, which is the kind of
        near-alignment that reads as a mistake rather than as a choice. Sat on
        a common bottom edge they read as one band.
      */
      className="flex flex-wrap items-end justify-center gap-x-16 gap-y-8 text-center sm:text-left"
    >
      <div className="w-full sm:w-auto">
        <h2 className="font-figure text-brand-gradient inline-block text-[clamp(67.2px,9.6vw,100.8px)] leading-[0.86] font-semibold tracking-[-0.04em]">
          <span className="sr-only">Rated </span>
          {average.toFixed(1)}
          <span className="sr-only"> out of 5</span>
        </h2>
        <Stars
          rating={Math.round(average)}
          size={20}
          className="mt-4 justify-center sm:justify-start"
        />
        {/* Two lines, one fact each, and both counts are computed rather than
            typed. See ARCHIVE in src/lib/reviews.ts: publishing a review moves
            them both without anyone remembering to. */}
        <p className="text-muted mt-4 text-[16.8px] leading-[1.55] font-medium">
          Helped {REVIEW_TOTAL} clinics who have rated us.
          <br />
          {REVIEWS_WRITTEN} have shared their experience as well.
        </p>
      </div>

      <div className="mx-auto space-y-2 sm:mx-0">
        {REVIEW_SCALE.map((stars, index) => (
          <DistributionBar
            key={stars}
            stars={stars}
            count={REVIEW_DISTRIBUTION[stars]}
            index={index}
          />
        ))}
      </div>

      {/* Third in the row, after the score and the bars. Last on purpose: the
          two things to its left are the argument, and this is the ask. */}
      <div className="w-full sm:w-auto">
        <LeaveReview />
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

export function Reviews() {
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
      setPerPage(lg.matches ? PER_PAGE.lg : sm.matches ? PER_PAGE.sm : PER_PAGE.base);

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

  const pageCount = Math.ceil(REVIEWS.length / perPage);

  // Narrowing the window makes pages, so someone parked on the last one can end
  // up past the end with nothing under them.
  useEffect(() => {
    setPage((current) => Math.min(current, pageCount - 1));
  }, [pageCount]);

  const step = useCallback(
    (delta: number) =>
      setPage((current) => Math.min(Math.max(current + delta, 0), pageCount - 1)),
    [pageCount],
  );

  return (
    <section id="reviews" className="scroll-mt-24 py-20 sm:py-24">
      <div className="text-center">
        <p className="eyebrow-tag">
          What clinics say
        </p>
        <span
          aria-hidden
          className="via-orange mx-auto mt-5 mb-9 block h-px w-full max-w-[200px] bg-gradient-to-r from-transparent to-transparent"
        />
      </div>

      <RatingHeader />

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
            {REVIEWS.map((review, index) => (
              <ReviewCard key={review.id} review={review} column={index % perPage} />
            ))}
          </motion.div>
        </div>
      </div>

      <div className="mt-8 flex items-center justify-center gap-2">
        <StepArrow
          back
          label="Previous reviews"
          onClick={() => setPage((current) => (current - 1 + pageCount) % pageCount)}
        />

        {Array.from({ length: pageCount }, (_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setPage(i)}
            aria-label={`Reviews ${i * perPage + 1} to ${Math.min((i + 1) * perPage, REVIEWS.length)}`}
            aria-current={i === page}
            className={[
              "h-2 rounded-full transition-all duration-300",
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
        Showing {REVIEWS.length} of {REVIEWS_WRITTEN} written reviews.
      </p>
    </section>
  );
}
