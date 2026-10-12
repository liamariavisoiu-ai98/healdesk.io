"use client";

import { useEffect, useRef, useState } from "react";

/** One entry in a legal page's contents: a Section's own id and title. */
export type LegalContentsEntry = { id: string; title: string };

/**
 * The contents rail beside /terms, /privacy and /data-deletion, from 1024px
 * (owner, 12 October 2026).
 *
 * The terms run to twenty-one sections, and a reader who came for one of them
 * (the refunds, the guarantee, "How we protect data") had only the scroll bar
 * to find it with. The list is rendered on the server from the page's own
 * Sections (LegalPage), so the links work with no script at all; this
 * component only marks the section being read, with `aria-current`.
 *
 * "Being read" is the last section whose top has passed a line 30% down the
 * viewport, worked out from where the sections are on each scroll frame. An
 * IntersectionObserver band was the first idea, but a short last section
 * (/data-deletion's) never reaches that line before the page runs out, so at
 * the very bottom the last section on screen wins instead.
 *
 * Below 1024px there is no rail: the column is the page.
 */
export function LegalContents({ entries }: { entries: readonly LegalContentsEntry[] }) {
  const [active, setActive] = useState<string | null>(entries[0]?.id ?? null);
  const listRef = useRef<HTMLDivElement>(null);
  const ids = entries.map((entry) => entry.id).join(" ");

  useEffect(() => {
    const targets = ids
      .split(" ")
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (targets.length === 0) return;

    let frame = 0;
    const update = () => {
      frame = 0;
      const line = window.innerHeight * 0.3;
      let current = targets[0]!.id;
      for (const target of targets) {
        if (target.getBoundingClientRect().top > line) break;
        current = target.id;
      }
      const atBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      if (atBottom) {
        const onScreen = targets.filter((t) => t.getBoundingClientRect().top < window.innerHeight);
        if (onScreen.length > 0) current = onScreen[onScreen.length - 1]!.id;
      }
      setActive(current);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [ids]);

  // The terms' list is taller than some screens: keep the marked entry in
  // the rail's own view, without moving the page.
  useEffect(() => {
    const list = listRef.current;
    const link = active ? list?.querySelector<HTMLElement>(`a[href="#${active}"]`) : null;
    if (!list || !link) return;
    const top = link.offsetTop;
    const bottom = top + link.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top - 8;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 8;
  }, [active]);

  return (
    <nav aria-label="Contents" className="hidden pt-14 sm:pt-20 lg:block">
      <div
        ref={listRef}
        className="sticky top-28 max-h-[calc(100vh-9rem)] overflow-y-auto overscroll-contain pb-4"
      >
        <p className="text-muted text-xs font-bold tracking-[0.14em] uppercase">On this page</p>
        <ol className="mt-4">
          {entries.map((entry) => {
            const current = entry.id === active;
            return (
              <li key={entry.id}>
                <a
                  href={`#${entry.id}`}
                  aria-current={current ? "location" : undefined}
                  onClick={() => setActive(entry.id)}
                  // One weight in both states: a bolder current entry would
                  // re-wrap its title, and the rail would shift as it moved.
                  className={[
                    "block border-l-2 py-1 pl-4 text-[14px] leading-snug font-medium transition-colors duration-fast",
                    current
                      ? "border-red text-ink"
                      : "border-line text-muted hover:border-line-strong hover:text-ink",
                  ].join(" ")}
                >
                  {entry.title}
                </a>
              </li>
            );
          })}
        </ol>
      </div>
    </nav>
  );
}
