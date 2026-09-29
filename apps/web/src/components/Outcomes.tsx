"use client";

import { useCallback, useState } from "react";

import { Deck } from "@/components/Deck";
import { OUTCOMES } from "@/lib/outcomes";

/**
 * What changes in month one: the eight outcomes, as a ledger and a deck.
 *
 * ## The shape, and where it came from
 *
 * The owner chose this over a marquee and over a card gallery on 23 September
 * 2026, then asked for it to look like the specialties section rather than
 * like a product mock. So the right-hand side is the niche deck itself
 * (Deck.tsx), dealt with photographs of one clinic instead of the niches, and
 * the header is the niche section's: centred eyebrow, the gradient hairline,
 * a serif heading. The pastel gradient panel and the fake app screen that the
 * first prototype had are gone; the photograph is the proof now.
 *
 * ## One number, two views
 *
 * The ledger on the left and the deck on the right share `index`. Resting on
 * a line brings its card forward; stepping the deck, by drag, dot, arrow or
 * key, moves the highlight on the ledger. Neither is the control and the
 * other the display; both are both. A visitor who never touches anything has
 * still read all eight lines, which is the reason the ledger exists at all:
 * a deck shows one thing at a time, and these are eight claims that belong
 * on screen together.
 *
 * Below the xl breakpoint the ledger would be eight lines of serif squeezed
 * beside, or on a phone above, a deck that is already 390px tall, so it
 * collapses to the one active line under the deck, and the dots do the rest.
 *
 * ## The card's click goes to the demo
 *
 * Same as a niche card. An outcome that opens the agent is a stronger promise
 * than a Confirm button that does nothing.
 */
export function Outcomes({ onOpen }: { onOpen: () => void }) {
  const [index, setIndex] = useState(0);
  const select = useCallback((i: number) => setIndex(i), []);

  const items = OUTCOMES.map((o) => ({ id: o.id, title: o.word, body: o.line, still: o.still }));
  const active = OUTCOMES[index] ?? OUTCOMES[0]!;

  return (
    <section id="outcomes" aria-labelledby="outcomes-heading" className="scroll-mt-24 pt-16 sm:pt-24">
      {/* Centred header, the specialties section's own. */}
      <div className="mx-auto max-w-[52ch] text-center">
        <p className="eyebrow-tag">What changes in month one</p>
        <span
          aria-hidden
          className="bg-gradient-to-r from-transparent via-orange to-transparent mx-auto mt-5 block h-px w-full max-w-[200px]"
        />
        <h2
          id="outcomes-heading"
          className="font-display mx-auto mt-5 text-[clamp(33.6px,4.8vw,55.2px)] leading-[1.06] font-medium tracking-[-0.026em] text-balance"
        >
          Eight things your desk stops losing
        </h2>
      </div>

      {/* The deck column is the card plus its tight fan, so the grid can be
          told its width and the ledger takes the rest. */}
      <div className="mt-12 grid items-center gap-10 xl:grid-cols-[minmax(0,1fr)_auto] xl:gap-12">
        {/* The ledger, from xl up. At lg the deck and its fan left the ledger a
            170px column, so below xl the deck stands alone with the active
            line under it. */}
        <ol className="border-line hidden border-t xl:block" aria-label="The eight outcomes">
          {OUTCOMES.map((o, i) => {
            const isActive = i === index;
            return (
              <li key={o.id} className="border-line border-b">
                <button
                  type="button"
                  // pointermove, not mouseenter: mouseenter also fires when the
                  // page scrolls under a stationary cursor, so the deck dealt
                  // itself as a visitor scrolled past the list. Movement of the
                  // pointer itself is the intent this reads. Selecting the same
                  // index again is a no-op, so the repeat events cost nothing.
                  onPointerMove={() => select(i)}
                  onFocus={() => select(i)}
                  onClick={() => select(i)}
                  aria-current={isActive}
                  className={[
                    "grid w-full grid-cols-[18px_1fr] items-baseline gap-4 py-[18px] pr-2 text-left transition-colors duration-300",
                    isActive ? "text-ink" : "text-muted hover:text-ink",
                  ].join(" ")}
                >
                  <span
                    aria-hidden
                    className={[
                      "inline-block size-2.5 translate-y-[-2px] rounded-full transition-all duration-300",
                      isActive ? "bg-red scale-110" : "bg-line-strong",
                    ].join(" ")}
                  />
                  <span className="font-display text-[clamp(18px,1.4vw,21.5px)] leading-[1.25] font-medium tracking-[-0.015em]">
                    {o.line}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        <div className="flex flex-col items-center">
          <Deck
            items={items}
            label="What changes in month one"
            noun="outcome"
            onOpen={onOpen}
            index={index}
            onIndexChange={select}
            spread="tight"
          />
          {/* The phone's ledger: one line, the current one. */}
          <p
            aria-live="polite"
            className="font-display text-ink mx-auto mt-6 max-w-[30ch] text-center text-[20px] leading-[1.25] font-medium tracking-[-0.015em] xl:hidden"
          >
            {active.line}
          </p>
        </div>
      </div>
    </section>
  );
}
