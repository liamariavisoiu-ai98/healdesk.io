"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type RefObject } from "react";

import { BuyButton } from "@/components/BuyModal";
import { portalSignInUrl, SIGN_IN_LABEL } from "@/lib/portal-link";
import { GetInTouch } from "@/components/GetInTouch";
import { NAV_WORDMARK_HEIGHT, WordmarkGlyphs } from "@/components/Wordmark";
import { site } from "@/lib/site";

/**
 * The navbar logo.
 *
 * It used to be the receiving half of a hand-off: the giant wordmark behind
 * AYA in the hero shrank into this one as you scrolled, and this one faded in
 * as that one faded out. The hero is static now (see HeroStage.tsx), so the
 * logo is simply always here, at one size, on every route. The navbar asks
 * for its larger size (Wordmark.tsx); the pages without a navbar keep 28px.
 */
export function Brand({ className = "", height }: { className?: string; height?: number }) {
  return (
    <a
      href="/"
      className={`inline-flex items-center leading-none ${className}`}
      aria-label={`${site.name} home`}
    >
      <span className="inline-block min-w-0">
        <WordmarkGlyphs height={height} />
      </span>
    </a>
  );
}

/** Where the navbar says which section is on screen: a phone. */
const PHONE = "(max-width: 639px)";

/**
 * Wayfinding, on a phone (owner, 12 October 2026).
 *
 * The homepage's sections are told apart by the warm bands under every other
 * one (globals.css, "Sections"), and on a phone from the navbar as well, where
 * a section can fill the screen. Once the hero has scrolled away, the wordmark gives way to
 * the healdesk mark and the title of the section on screen, the same words as
 * its highlighted title, and a hairline in the logo's red to orange fills
 * along the navbar's foot as the page is read. Back over the hero the
 * wordmark returns.
 *
 * The section on screen is the last one whose top has passed a line 30% of
 * the way down the screen under the navbar. The sections are found from
 * their titles (`.eyebrow-tag` in <main>), so a section added later is
 * picked up without a list to keep. The fill is written straight onto the
 * header as `--read`, so scrolling re-renders nothing; only crossing into a
 * new section or out of the hero does.
 */
function useWayfinding(enabled: boolean, header: RefObject<HTMLElement | null>) {
  const [now, setNow] = useState<{ past: boolean; title: string | null }>({ past: false, title: null });

  useEffect(() => {
    if (!enabled) return;
    const media = window.matchMedia(PHONE);
    let frame = 0;
    let stop = () => {};

    const start = () => {
      stop();
      if (!media.matches) {
        setNow({ past: false, title: null });
        return;
      }
      const hero = document.querySelector<HTMLElement>(".hero");
      const sections = [
        ...new Set(
          [...document.querySelectorAll<HTMLElement>("main .eyebrow-tag")]
            .map((tag) => tag.closest("section"))
            .filter((section): section is HTMLElement => section !== null),
        ),
      ];
      const read = () => {
        frame = 0;
        const bar = header.current;
        const navH = bar?.offsetHeight ?? 77;
        const past = hero ? hero.getBoundingClientRect().bottom <= navH : window.scrollY > 0;
        const line = navH + window.innerHeight * 0.3;
        let title: string | null = null;
        for (const section of sections) {
          if (section.getBoundingClientRect().top > line) break;
          title = section.querySelector(".eyebrow-tag")?.textContent?.trim() || title;
        }
        // How far through the page past the hero, 0 to 1.
        const from = hero ? hero.offsetTop + hero.offsetHeight - navH : 0;
        const to = document.documentElement.scrollHeight - window.innerHeight;
        const share = to > from ? Math.min(1, Math.max(0, (window.scrollY - from) / (to - from))) : 0;
        bar?.style.setProperty("--read", share.toFixed(4));
        setNow((prev) => (prev.past === past && prev.title === title ? prev : { past, title }));
      };
      const onScroll = () => {
        if (!frame) frame = requestAnimationFrame(read);
      };
      read();
      window.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", onScroll);
      stop = () => {
        cancelAnimationFrame(frame);
        frame = 0;
        window.removeEventListener("scroll", onScroll);
        window.removeEventListener("resize", onScroll);
      };
    };

    start();
    media.addEventListener("change", start);
    return () => {
      stop();
      media.removeEventListener("change", start);
    };
  }, [enabled, header]);

  return now;
}

/**
 * Wordmark on the left, two links and two calls to action on the right.
 *
 * Contact lives in the footer; "Why wait?" is the one page link
 * that earned a place here, because the page behind it is the argument for
 * buying now and the calculator it holds used to interrupt the homepage. The
 * navbar carries the purchase flow as its PRIMARY action, with the demo as
 * secondary. Until this existed the homepage had no path to checkout at all:
 * AYA's own prompt told her to point at a "Make It Yours" button that only
 * existed on the old /pricing page, so a prospect she had just convinced had
 * to find the footer to buy.
 *
 * "Get in touch" (6 October 2026, the owner's) sits beside it as the outlined
 * secondary button, opening a call booking over the page (GetInTouch.tsx).
 * It shows at every width: a calendar icon on a phone, its words from 480px.
 *
 * The text links wait until 700px. At 640, where they used to appear, a row
 * that also holds "Get in touch" is exactly full; at 700 there are about 60px
 * to spare. Nothing in the row wraps or shrinks except the wordmark, which
 * scales down on a phone narrower than about 360px rather than push the
 * buttons off the edge.
 *
 * Client component because both CTAs behave differently by route.
 */
export function Nav() {
  const pathname = usePathname();
  const onHome = pathname === "/";
  // A bare "#aya" on /why-wait scrolls to nothing, and a "/#aya" on the homepage
  // makes Next run a route transition instead of letting CSS smooth-scroll do it.
  const demoHref = onHome ? site.cta.secondary.href : `/${site.cta.secondary.href}`;
  const headerRef = useRef<HTMLElement>(null);
  const way = useWayfinding(onHome, headerRef);
  const wayfinding = way.past && way.title !== null;

  return (
    <header
      ref={headerRef}
      className="nav border-line/60 bg-paper/85 sticky top-0 z-50 border-b backdrop-blur-md"
      data-way={wayfinding || undefined}
    >
      <div className="mx-auto flex max-w-[1240px] items-center gap-2 px-5 py-4 min-[480px]:gap-3 sm:gap-5 sm:px-8 lg:px-14">
        {/* The wordmark, and on a phone past the hero, the mark and the
            section on screen in its place (useWayfinding). The one hidden is
            inert, so a keyboard meets one home link, never two. */}
        <div className="nav-brand min-w-0">
          <span className="nav-brand__logo min-w-0" inert={wayfinding || undefined}>
            <Brand className="min-w-0" height={NAV_WORDMARK_HEIGHT} />
          </span>
          {onHome ? (
            <span className="nav-brand__way" inert={!wayfinding || undefined}>
              <a href="/" aria-label={`${site.name} home`} className="shrink-0">
                <img src="/icon.png" alt="" width={32} height={32} className="nav-brand__mark" />
              </a>
              {/* Keyed, so each new section's title comes in afresh. Not
                  announced: the section's own heading says it. */}
              <span key={way.title ?? ""} aria-hidden className="nav-brand__title">
                {way.title}
              </span>
            </span>
          ) : null}
        </div>

        {/* Text links are hidden on the narrower screens rather than wrapped:
            a phone's row holds the wordmark and the two buttons instead of
            five cramped items, and both destinations are one scroll or one
            footer away. */}
        {site.navLinks.map((item) => (
          <a
            key={item.href}
            href={item.href}
            className="text-muted hover:text-ink ml-auto hidden text-[16.8px] font-semibold whitespace-nowrap transition-colors min-[700px]:inline-flex"
          >
            {item.label}
          </a>
        ))}
        {/* A hairline between the two text links (owner, 9 October 2026),
            shown wherever they are. */}
        <span aria-hidden className="bg-line-strong hidden h-5 w-px shrink-0 min-[700px]:block" />
        <a
          href={demoHref}
          className="text-muted hover:text-ink hidden text-[16.8px] font-semibold whitespace-nowrap transition-colors min-[700px]:inline-flex"
        >
          {site.cta.secondary.label}
        </a>

        {/* The clinic portal's sign-in, once NEXT_PUBLIC_PORTAL_URL is set
            (lib/portal-link.ts); nothing until then. */}
        {portalSignInUrl() ? (
          <a
            href={portalSignInUrl()!}
            className="text-muted hover:text-ink hidden text-[16.8px] font-semibold whitespace-nowrap transition-colors min-[700px]:inline-flex"
          >
            {SIGN_IN_LABEL}
          </a>
        ) : null}
        <GetInTouch className="ml-auto min-[700px]:ml-0" />
        <BuyButton className="shrink-0 whitespace-nowrap" />
      </div>
      {onHome ? <span aria-hidden className="nav-progress" /> : null}
    </header>
  );
}
