"use client";

import { useEffect } from "react";

/**
 * The site's one scroll reveal (owner, 12 October 2026).
 *
 * Mark anything with `data-reveal` and it comes into view as it is scrolled
 * to: a short rise and a fade, once, on the shared durations and easings
 * (globals.css, "Reveal on scroll"). `data-reveal="heading"` rises from
 * behind its own bottom edge instead, for a section's heading, and
 * `data-reveal="stagger"` brings its children in one after another. This
 * sits beside the components' own, heavier entrances (the hero, the lock
 * screen, the reviews), which it never marks.
 *
 * Nothing is hidden until this has run, so without script, and for anything
 * already on screen when it runs, the page is simply there: it marks what is
 * in view as shown in the same task that switches the hiding on, so a
 * visitor never sees something above the fold vanish and come back. What is
 * added to the page later (a client component's late render) is picked up
 * as it arrives. Reduced motion: globals.css keeps the hiding off entirely.
 */
export function RevealOnScroll() {
  useEffect(() => {
    const root = document.documentElement;
    const seen = new WeakSet<Element>();

    const show = (el: Element) => el.setAttribute("data-shown", "");
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          show(entry.target);
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );

    const take = (el: Element) => {
      if (seen.has(el)) return;
      seen.add(el);
      // On screen or above it already: shown, never hidden.
      if (el.getBoundingClientRect().top < window.innerHeight) show(el);
      else observer.observe(el);
    };

    document.querySelectorAll("[data-reveal]").forEach(take);
    root.setAttribute("data-reveal-on", "");

    const added = new MutationObserver((records) => {
      for (const record of records) {
        record.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          if (node.matches("[data-reveal]")) take(node);
          node.querySelectorAll("[data-reveal]").forEach(take);
        });
      }
    });
    added.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      added.disconnect();
      root.removeAttribute("data-reveal-on");
    };
  }, []);

  return null;
}
