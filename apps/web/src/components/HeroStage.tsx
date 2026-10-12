"use client";

import { useEffect, useRef, useState } from "react";

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
 * a small pill at its foot does, "Move your cursor down", until the copy has
 * come up once. Meanwhile the logos' cards play on their own, one at a time
 * (HeroPortrait), so the hero is not still while it waits.
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
  const buy = useBuy();
  const heroRef = useRef<HTMLElement>(null);
  const copyRef = useRef<HTMLDivElement>(null);
  const { reveal, seen } = useReveal(heroRef, copyRef);

  return (
    <section ref={heroRef} aria-labelledby="hero-heading" className="hero" data-reveal={reveal}>
      {/* Above the photo, and transparent to the pointer everywhere but its
          own content, so the logos beside her still take a hover. */}
      <div className="hero__copy pointer-events-none z-10 mx-auto w-full max-w-[1240px] px-5 pt-10 pb-8 text-center sm:px-8 sm:pt-16 lg:px-14 xl:pt-0 xl:pb-16 xl:text-left">
        <div ref={copyRef} className="pointer-events-auto mx-auto max-w-[760px] xl:mx-0 xl:max-w-[min(600px,46%)]">
          {/* The announcement bar, after jasper.ai: a small tag, one bold
              line, and the way in. It wraps inside the copy's column (run out
              as one line on a desktop, it crossed the logos beside her), so it
              is one paragraph: the tag leads the first line and the rest flows
              after it, rather than each part taking a row of its own. The
              space after the tag is a real one, so a screen reader, a copy
              and the browser's find all get "New Instagram", not
              "NEWInstagram". The link opens the purchase flow in place where
              the provider exists and falls back to the standalone route. */}
          <p className="hero-line border-line mb-8 inline-block max-w-full rounded-[6px] border bg-white py-1.5 pr-3.5 pl-1.5 text-[14.5px] leading-[1.75] shadow-[0_10px_28px_-18px_rgb(23_42_58/0.4)]">
            <span className="bg-tint-mint text-ink mr-2 inline-block rounded-[3px] px-2 py-1 align-[1px] font-mono text-[11.5px] leading-none font-semibold tracking-[0.06em] uppercase">
              {site.announcement.tag}
            </span>{" "}
            <span className="text-ink font-semibold">{site.announcement.text}</span>{" "}
            {buy ? (
              <button
                type="button"
                onClick={() => buy.open()}
                className="text-red-deep hover:text-red ml-1.5 font-semibold whitespace-nowrap transition-colors"
              >
                {site.announcement.cta}
              </button>
            ) : (
              <a
                href={site.cta.primary.href}
                className="text-red-deep hover:text-red ml-1.5 font-semibold whitespace-nowrap transition-colors"
              >
                {site.announcement.cta}
              </a>
            )}
          </p>

          <h1
            id="hero-heading"
            className="hero-line font-display text-ink text-[clamp(40px,4.9vw,68px)] leading-[1.04] font-normal tracking-[-0.03em] text-balance [--line-delay:100ms]"
          >
            {site.tagline}
          </h1>

          {/* One column on a phone, two equal ones from 640px: the grid is
              what makes the buttons the same size whatever their labels. */}
          <div className="hero-line mx-auto mt-8 grid w-full max-w-[480px] grid-cols-1 gap-3 [--line-delay:200ms] sm:grid-cols-2 xl:mx-0 xl:mt-10">
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
      <p aria-hidden className="hero__cue" data-show={(reveal === "hidden" && !seen) || undefined}>
        Move your cursor down
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </p>

      {/* The white the copy sits on, rising from the bottom with it: over
          the photo, under the logos and the copy. */}
      <div aria-hidden className="hero__veil" />
    </section>
  );
}
