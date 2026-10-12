"use client";

import { Fragment, useEffect, useRef, useState } from "react";

import { BuyButton, useBuy } from "@/components/BuyModal";
import { HeroPortrait } from "@/components/HeroPortrait";
import { site } from "@/lib/site";

/**
 * The banner: the claim and the two ways in, over a photo of AYA with the
 * tools she works through beside her.
 *
 * ## What it replaced, and why
 *
 * Until 23 September 2026 this was a 130svh sticky stage: a life-size head
 * over a giant wordmark, shrinking as you scrolled, with the wordmark flying
 * into the navbar. That became a two-column banner with AYA rendered in 3D in
 * a panel beside the copy. On 3 October 2026 the owner removed the render
 * entirely, along with the three.js model, the layered and frame-grid
 * renderers behind it, and their build scripts; git history has all of it.
 *
 * What is left follows the references the owner chose, reception.ai for
 * structure and jasper.ai for identity: an announcement bar, the claim in one
 * serif heading and two buttons. On 5 October 2026 the owner removed the
 * supporting paragraph that sat under the heading, and put a second column
 * back with the soul in it and the integrations on a ring round it. On 7
 * October 2026 the photo took the soul's place (HeroPortrait).
 *
 * ## Full screen, from 9 October 2026
 *
 * The owner asked for the hero to fill the screen on a desktop: from 1280px it
 * is the screen's height less the navbar's, with the photo as its background,
 * composed as supplied, and the logos on their orbits all around her. Below
 * 1280px the copy comes first, centred, and the photo follows. The copy is
 * first in the page either way, so a screen reader meets the claim before the
 * picture.
 *
 * ## The copy follows the cursor (owner, 9 October 2026)
 *
 * On a desktop with a mouse the hero opens on the photo and the logos alone.
 * When the cursor comes into the bottom third of the hero, the white veil
 * rises from the bottom with the copy on it, line by line; when it leaves,
 * they slide away, for as long as the page is at the top. The first scroll
 * down locks them up, and so does a key that scrolls, or focus coming into
 * the copy, so a keyboard never lands on a button it cannot see. Back at the
 * very top they unlock and follow the cursor again, and the next scroll down
 * locks them again. A page loaded already scrolled opens locked.
 *
 * Nothing else on the hero says that moving the cursor down does anything, so
 * an arrowhead at its foot does, pointing down and jumping slowly, until the
 * copy has come up once. It was a pill that said "Move your cursor down"
 * until the owner asked for the arrow alone (12 October 2026). Meanwhile the logos' cards play on their own, one at a time
 * (HeroPortrait), so the hero is not still while it waits.
 *
 * ## The entrance, and the copy line by line (owner, 12 October 2026)
 *
 * The page opens in one movement: the photo settles, the orbits draw in
 * round her, the logos fan out along them, and last the cue's arrowhead
 * draws in.
 * The copy plays no part in that. Only when it comes up on the cursor does
 * the announcement rise, then the headline line by line, then the buttons
 * after its last line (HeroLines numbers the lines as the browser broke
 * them). Where the copy is simply there, below 1280px or without a cursor,
 * it does not animate at all.
 *
 * `data-reveal` on the section is that state: "hidden", "shown" or
 * "locked". globals.css acts on it only from 1280px and only where the
 * pointer is fine and hovers; anywhere else (a phone, a tablet, a touch
 * laptop) the copy is simply there. The copy stays in the page in every
 * state, so a screen reader and a search engine always have it, and the
 * navbar carries both calls to action throughout.
 *
 * ## The two buttons
 *
 * The same size, side by side (owner, 9 October 2026), and both without
 * arrows. "Try AYA for free" is ink at rest and outlined on hover, the
 * outline button's colours the other way round (`btn-ink`).
 *
 * The heading is `site.tagline`, which the <title> and the share card also
 * use, so the page and its preview always make the same claim.
 */
type Reveal = "hidden" | "shown" | "locked";

/** Keys that scroll the page down. */
const SCROLL_KEYS = new Set(["PageDown", " ", "ArrowDown", "End"]);

/**
 * The reveal's state, from the cursor, the scroll and the focus (see above).
 * Read from the events themselves rather than from React state, so a burst
 * of pointer moves costs one comparison each and a render only on a change.
 */
function useReveal(
  hero: React.RefObject<HTMLElement | null>,
  copy: React.RefObject<HTMLElement | null>,
): { reveal: Reveal; seen: boolean } {
  const [reveal, setReveal] = useState<Reveal>("hidden");
  /** The copy has come up at least once this visit: the cue has done its job. */
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const el = hero.current;
    if (!el) return;
    const follows = window.matchMedia("(hover: hover) and (pointer: fine)");
    const atTop = () => window.scrollY <= 2;
    let state: Reveal = "hidden";
    let pointerLow = false;
    let focusInside = false;

    const set = (next: Reveal) => {
      if (next === state) return;
      state = next;
      setReveal(next);
      if (next !== "hidden") setSeen(true);
    };
    const follow = () => {
      if (!follows.matches || !atTop()) set("locked");
      else set(pointerLow || focusInside ? "shown" : "hidden");
    };

    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const box = el.getBoundingClientRect();
      pointerLow =
        event.clientX >= box.left &&
        event.clientX <= box.right &&
        event.clientY >= box.top + (box.height * 2) / 3 &&
        event.clientY <= box.bottom;
      if (state !== "locked") follow();
    };
    const onLeave = () => {
      pointerLow = false;
      if (state !== "locked") follow();
    };
    const onScroll = () => {
      if (!atTop()) set("locked");
      else if (state === "locked") follow();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY > 0) set("locked");
    };
    const onKey = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key) && !(event.target instanceof HTMLInputElement)) set("locked");
    };
    const onFocusIn = (event: FocusEvent) => {
      focusInside = Boolean(copy.current?.contains(event.target as Node));
      if (focusInside && state === "hidden") set("shown");
    };
    const onFocusOut = (event: FocusEvent) => {
      if (copy.current?.contains(event.relatedTarget as Node | null)) return;
      focusInside = false;
      if (state !== "locked") follow();
    };

    // The state the page opens in: locked when there is no cursor to follow
    // or the page is already scrolled, otherwise the photo alone.
    follow();
    document.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("keydown", onKey);
    el.addEventListener("focusin", onFocusIn);
    el.addEventListener("focusout", onFocusOut);
    follows.addEventListener("change", follow);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
      el.removeEventListener("focusin", onFocusIn);
      el.removeEventListener("focusout", onFocusOut);
      follows.removeEventListener("change", follow);
    };
  }, [hero, copy]);

  return { reveal, seen };
}

export function HeroStage() {
  const heroRef = useRef<HTMLElement>(null);
  const copyRef = useRef<HTMLDivElement>(null);
  const { reveal, seen } = useReveal(heroRef, copyRef);

  return (
    <section ref={heroRef} aria-labelledby="hero-heading" className="hero" data-reveal={reveal}>
      {/* Above the photo, and transparent to the pointer everywhere but its
          own content, so the logos beside her still take a hover. */}
      <div className="hero__copy pointer-events-none z-10 mx-auto w-full min-w-0 max-w-[1240px] px-5 pt-10 pb-8 text-center sm:px-8 sm:pt-16 lg:px-14 xl:pt-0 xl:pb-16 xl:text-left">
        <div ref={copyRef} className="pointer-events-auto mx-auto max-w-[760px] xl:mx-0 xl:max-w-[min(600px,46%)]">
          {/* The announcement, as one pill on one line (owner, 12 October
              2026): "NEW · Now on Instagram, Messenger and WhatsApp →", the
              whole of it the way in. It used to be a bar with a "Get AYA"
              link at its end, which wrapped onto a line of its own beside her
              and repeated the red button under it. The pill opens the
              purchase flow in place where the provider exists and falls back
              to the standalone route. Its name is the sentence and where it
              goes, so a screen reader hears "New: now on Instagram,
              Messenger and WhatsApp. Get AYA" rather than an arrow. */}
          <AnnouncementPill />

          {/* Split into its lines on a desktop with a cursor, so the copy
              comes up line by line (HeroLines). Named by the whole sentence,
              so a screen reader hears it once rather than word by word. */}
          <h1
            id="hero-heading"
            aria-label={site.tagline}
            className="font-display text-ink text-[clamp(40px,4.9vw,68px)] leading-[1.04] font-normal tracking-[-0.03em] text-balance"
          >
            <HeroLines text={site.tagline} />
          </h1>

          {/* One column on a phone, two equal ones from 640px: the grid is
              what makes the buttons the same size whatever their labels.
              They follow the headline's last line (`--hero-lines`). */}
          <div className="hero-line hero-line--after mx-auto mt-8 grid w-full max-w-[480px] grid-cols-1 gap-3 sm:grid-cols-2 xl:mx-0 xl:mt-10">
            <BuyButton size="h-[54px] px-6 text-base" className="w-full whitespace-nowrap" />
            <a href={site.cta.secondary.href} className="btn-ink h-[54px] w-full px-6 text-base whitespace-nowrap">
              {site.cta.secondary.label}
            </a>
          </div>
        </div>
      </div>

      <div className="hero__frame">
        <HeroPortrait autoplay={reveal === "hidden"} />
      </div>

      {/* Says what moving the cursor down does, until it has done it. Not for
          a screen reader (the copy is in the page throughout) and not for a
          touch screen (CSS shows it only with a pointer that hovers). */}
      <span aria-hidden className="hero__cue" data-show={(reveal === "hidden" && !seen) || undefined}>
        {/* Two strokes from the tip, so it draws outwards from its point. */}
        <svg viewBox="0 0 36 20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 16 4 4" pathLength={1} />
          <path d="M18 16 32 4" pathLength={1} />
        </svg>
      </span>

      {/* The white the copy sits on, rising from the bottom with it: over
          the photo, under the logos and the copy. */}
      <div aria-hidden className="hero__veil" />
    </section>
  );
}

/**
 * The announcement pill. One line at every width: the type steps down on a
 * narrow phone, and if the sentence still cannot fit, it ends in an ellipsis
 * rather than wrapping under the tag.
 */
function AnnouncementPill() {
  const buy = useBuy();
  const { tag, text, cta } = site.announcement;
  const label = `${tag}: ${text}. ${cta}`;
  const className =
    "hero-line hero-pill group mb-8 inline-flex max-w-full items-center gap-2 rounded-full border border-line bg-white py-1.5 pr-3.5 pl-1.5 text-[clamp(12.5px,3.4vw,14.5px)] leading-none whitespace-nowrap shadow-sm transition-[border-color,box-shadow] duration-fast hover:border-line-strong hover:shadow-md";
  const inner = (
    <>
      <span className="bg-tint-mint text-ink rounded-full px-2 py-1 text-[0.78em] font-semibold tracking-[0.06em] uppercase">{tag}</span>
      <span aria-hidden className="text-muted">·</span>
      <span className="text-ink min-w-0 overflow-hidden font-semibold text-ellipsis">{text}</span>
      <svg aria-hidden viewBox="0 0 16 16" className="text-red-deep size-[1.05em] shrink-0 transition-transform duration-fast ease-out group-hover:translate-x-0.5">
        <path d="M3 8h9.5M8.5 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </>
  );
  return buy ? (
    <button type="button" onClick={() => buy.open()} aria-label={label} className={className}>
      {inner}
    </button>
  ) : (
    <a href={site.cta.primary.href} aria-label={label} className={className}>
      {inner}
    </a>
  );
}

/**
 * The headline, word by word, each word told which line it landed on.
 *
 * The lines are wherever the browser broke them at this width, so they are
 * read from the page rather than written in: each word's top, measured after
 * layout and again whenever the heading's width changes, numbers its line
 * (`--line`), and the copy is told how many lines there are
 * (`--hero-lines`), so the buttons can follow the last. `offsetTop` ignores
 * the transform a hidden word is under, so measuring while the copy is down
 * is measuring where it will land. Before this runs, and without script,
 * every word is on line 0, so the headline comes up as one.
 */
function HeroLines({ text }: { text: string }) {
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = box.current;
    const copy = el?.closest<HTMLElement>(".hero__copy");
    if (!el || !copy) return;
    const number = () => {
      const words = [...el.querySelectorAll<HTMLElement>(".hero-word")];
      const tops = [...new Set(words.map((word) => word.offsetTop))].sort((a, b) => a - b);
      for (const word of words) word.style.setProperty("--line", String(tops.indexOf(word.offsetTop)));
      copy.style.setProperty("--hero-lines", String(tops.length));
    };
    number();
    const observer = new ResizeObserver(number);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const words = text.split(" ");
  return (
    <span ref={box} aria-hidden>
      {words.map((word, i) => (
        <Fragment key={i}>
          <span className="hero-word">
            <span>{word}</span>
          </span>
          {i < words.length - 1 ? " " : null}
        </Fragment>
      ))}
    </span>
  );
}
