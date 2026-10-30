"use client";

import { useSelectedLayoutSegment } from "next/navigation";

/**
 * The console's sections (E1 §2, and Support since lane P7f): Home · Clinics ·
 * Queues · Support · Compliance · System, each answering one question, with
 * the current one marked. The
 * mark is read from the client router, which is right on every navigation;
 * the layout that renders this cannot know which child is below it
 * (app/admin/layout.tsx says why), and `AdminChrome` already reads the same
 * segment to hide the header on the sign-in door.
 *
 * Old sections that now redirect, and the pages that keep their addresses
 * under System (map, host, seo, demos, crm), are mapped to the section they
 * belong to, so the mark never goes dark on a page the nav does not list.
 * Plain anchors, as the whole console navigates. The Patient rights page
 * (/admin/rights, ops automation lane P6b) is under Compliance: it is the
 * agreement's clocks, decided by the owner; /admin/inbox redirects to
 * Queues › Approvals and lights Queues.
 */

export const SECTIONS = [
  { href: "/admin", label: "Home", segments: [null] },
  { href: "/admin/clinics", label: "Clinics", segments: ["clinics", "ops"] },
  { href: "/admin/queues", label: "Queues", segments: ["queues", "reviews", "recordings", "site-reads", "setup", "inbox"] },
  // The support console (lane P7d) is its own section: its cases are worked there, not in a queue.
  { href: "/admin/support", label: "Support", segments: ["support"] },
  { href: "/admin/compliance", label: "Compliance", segments: ["compliance", "agreements", "incidents", "notices", "rights"] },
  { href: "/admin/system", label: "System", segments: ["system", "map", "host", "seo", "demos", "crm"] },
] as const;

export function sectionFor(segment: string | null): (typeof SECTIONS)[number]["href"] | null {
  return SECTIONS.find((s) => (s.segments as readonly (string | null)[]).includes(segment))?.href ?? null;
}

export function AdminNav() {
  const segment = useSelectedLayoutSegment();
  const current = sectionFor(segment);
  return (
    <nav aria-label="Admin sections" className="order-last flex w-full flex-wrap gap-1 sm:order-none sm:w-auto">
      {SECTIONS.map((section) => {
        const on = section.href === current;
        return (
          <a
            key={section.href}
            href={section.href}
            aria-current={on ? "page" : undefined}
            className={`inline-flex min-h-11 items-center rounded-full px-3.5 py-2 text-sm font-semibold transition-colors ${
              on ? "bg-ink text-white" : "text-muted hover:text-ink hover:bg-paper-2"
            }`}
          >
            {section.label}
          </a>
        );
      })}
    </nav>
  );
}
